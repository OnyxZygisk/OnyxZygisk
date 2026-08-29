// Remote in-process custom loader: maps libzygisk.so into the tracee without
// the system linker, so the library never enters the linker's solist and is not
// subject to the namespace allowlist that rejects a path-based dlopen on some
// KernelSU LKM late-load setups. See remote_csoloader.hpp.
//
// Adapted from PerformanC/ReZygisk (GPL-3.0), part of the CSOLoader project;
// conveyed under AGPL-3.0 per GPL-3.0 §13. See NOTICE.md.

#include "remote_csoloader.hpp"

#include <elf.h>
#include <fcntl.h>
#include <link.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>
#include <cinttypes>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>

#include "daemon.hpp"  // LP_SELECT
#include "logging.hpp"

// mmap on LP64 takes a byte offset; the 32-bit ABI uses mmap2 with a page-unit
// offset. The other syscalls have a single number across ABIs.
static constexpr long SYS_MMAP = LP_SELECT(__NR_mmap2, __NR_mmap);

#ifndef ALIGN_DOWN
#define ALIGN_DOWN(x, a) ((x) & ~((a) - 1))
#endif
#ifndef ALIGN_UP
#define ALIGN_UP(x, a) (((x) + ((a) - 1)) & ~((a) - 1))
#endif

// --- Local file / paging helpers ---------------------------------------------

// Reads exactly `len` bytes from `fd` at absolute offset `off` (local file).
static bool pread_full(int fd, void *buf, size_t len, off_t off) {
    auto *p = static_cast<uint8_t *>(buf);
    size_t done = 0;
    while (done < len) {
        ssize_t n = pread(fd, p + done, len - done, off + (off_t) done);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;  // unexpected EOF
        done += (size_t) n;
    }
    return true;
}

static uintptr_t page_start(uintptr_t addr, size_t page_size) {
    return ALIGN_DOWN(addr, page_size);
}

static uintptr_t page_end(uintptr_t addr, size_t page_size) {
    return ALIGN_DOWN(addr + page_size - 1, page_size);
}

static long remote_mmap_offset_arg(off_t file_offset, size_t page_size) {
#ifdef __LP64__
    (void) page_size;
    return (long) file_offset;
#else
    return (long) (file_offset / (off_t) page_size);
#endif
}

// --- ELF layout / dynamic parsing --------------------------------------------

// Parse the ELF header + program headers and compute the total span of all
// PT_LOAD segments (page-aligned). Allocates *out_phdr (caller frees).
static bool compute_load_layout(int fd, size_t page_size, ElfW(Ehdr) * eh, ElfW(Phdr) * *out_phdr,
                                ElfW(Addr) * out_min_vaddr, size_t *out_map_size) {
    if (!pread_full(fd, eh, sizeof(*eh), 0)) {
        LOGE("failed to read ELF header");
        return false;
    }
    if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0) {
        LOGE("invalid ELF magic");
        return false;
    }

    size_t phdr_sz = (size_t) eh->e_phnum * sizeof(ElfW(Phdr));
    auto *phdr = (ElfW(Phdr) *) malloc(phdr_sz);
    if (!phdr) {
        LOGE("failed to allocate program headers");
        return false;
    }
    if (!pread_full(fd, phdr, phdr_sz, (off_t) eh->e_phoff)) {
        LOGE("failed to read program headers");
        free(phdr);
        return false;
    }

    auto lo = (ElfW(Addr)) UINTPTR_MAX;
    ElfW(Addr) hi = 0;
    for (int i = 0; i < eh->e_phnum; i++) {
        if (phdr[i].p_type != PT_LOAD) continue;
        if (phdr[i].p_vaddr < lo) lo = phdr[i].p_vaddr;
        ElfW(Addr) end = phdr[i].p_vaddr + phdr[i].p_memsz;
        if (end > hi) hi = end;
    }
    if (hi <= lo) {
        LOGE("no valid PT_LOAD segments");
        free(phdr);
        return false;
    }

    lo = (ElfW(Addr)) page_start((uintptr_t) lo, page_size);
    hi = (ElfW(Addr)) page_end((uintptr_t) hi, page_size);

    *out_min_vaddr = lo;
    *out_map_size = (size_t) (hi - lo);
    *out_phdr = phdr;
    return true;
}

// Map an ELF virtual address to its file offset via the PT_LOAD tables.
static bool vaddr_to_offset(const ElfW(Phdr) * phdr, int phnum, ElfW(Addr) vaddr, off_t *out_off) {
    for (int i = 0; i < phnum; i++) {
        if (phdr[i].p_type != PT_LOAD) continue;
        ElfW(Addr) seg_start = phdr[i].p_vaddr;
        ElfW(Addr) seg_end = phdr[i].p_vaddr + phdr[i].p_filesz;
        if (vaddr < seg_start || vaddr >= seg_end) continue;
        *out_off = (off_t) phdr[i].p_offset + (off_t) (vaddr - seg_start);
        return true;
    }
    LOGE("failed to map vaddr 0x%" PRIxPTR " to a file offset", (uintptr_t) vaddr);
    return false;
}

// Find the full remote path of a mapped module by its soname (base==0 mapping).
static const char *find_remote_module_path(const std::vector<MapInfo> &remote_map,
                                           const char *soname) {
    for (const auto &m : remote_map) {
        if (m.path.empty() || m.offset != 0) continue;
        std::string_view p(m.path);
        auto slash = p.rfind('/');
        std::string_view filename = (slash == std::string_view::npos) ? p : p.substr(slash + 1);
        if (filename == soname) return m.path.c_str();
    }
    return nullptr;
}

struct elf_dyn_info {
    off_t dyn_off;
    size_t dyn_sz;
    off_t symtab_off;
    off_t strtab_off;
    off_t rel_off;
    size_t rel_sz;
    off_t rela_off;
    size_t rela_sz;
    off_t jmprel_off;
    size_t jmprel_sz;
    int pltrel_type;
    size_t syment;
    size_t strsz;
    size_t nsyms;
    char *strtab;
    size_t needed_count;
    size_t *needed_str_offsets;
    ElfW(Addr) init_vaddr;
    ElfW(Addr) init_array_vaddr;
    size_t init_array_sz;
};

static void elf_dyn_info_destroy(struct elf_dyn_info *info) {
    if (!info) return;
    free(info->strtab);
    free(info->needed_str_offsets);
    memset(info, 0, sizeof(*info));
}

// Parse PT_DYNAMIC and extract the relocation and symbol-table descriptors.
static bool elf_load_dyn_info(int fd, const ElfW(Ehdr) * eh, const ElfW(Phdr) * phdr,
                              struct elf_dyn_info *out) {
    memset(out, 0, sizeof(*out));

    // Everything is declared up front so the goto-cleanup below never bypasses
    // an initialization (which C++ forbids, unlike C).
    ElfW(Dyn) *dyn = nullptr;
    size_t *needed_str_offsets = nullptr;
    bool success = false;

    ElfW(Addr) symtab_vaddr = 0, strtab_vaddr = 0, gnu_hash_vaddr = 0;
    ElfW(Addr) rel_vaddr = 0, rela_vaddr = 0, jmprel_vaddr = 0;
    size_t rel_sz = 0, rela_sz = 0, jmprel_sz = 0, strsz = 0, syment = 0;
    size_t dyn_count = 0, needed_count = 0, needed_i = 0;

    const ElfW(Phdr) *dyn_phdr = nullptr;
    for (int i = 0; i < eh->e_phnum; i++) {
        if (phdr[i].p_type == PT_DYNAMIC) {
            dyn_phdr = &phdr[i];
            break;
        }
    }
    if (!dyn_phdr || dyn_phdr->p_filesz == 0) {
        LOGE("failed to find PT_DYNAMIC");
        return false;
    }

    out->dyn_off = (off_t) dyn_phdr->p_offset;
    out->dyn_sz = (size_t) dyn_phdr->p_filesz;
    dyn_count = out->dyn_sz / sizeof(ElfW(Dyn));

    dyn = (ElfW(Dyn) *) calloc(dyn_count, sizeof(ElfW(Dyn)));
    if (!dyn) {
        LOGE("failed to allocate dynamic entries");
        return false;
    }
    if (!pread_full(fd, dyn, dyn_count * sizeof(ElfW(Dyn)), out->dyn_off)) {
        LOGE("failed to read dynamic entries");
        goto cleanup;
    }

    for (size_t i = 0; i < dyn_count; i++) {
        if (dyn[i].d_tag == DT_NEEDED) needed_count++;
        if (dyn[i].d_tag == DT_NULL) break;
    }
    if (needed_count) {
        needed_str_offsets = (size_t *) calloc(needed_count, sizeof(size_t));
        if (!needed_str_offsets) {
            LOGE("failed to allocate DT_NEEDED offsets");
            goto cleanup;
        }
    }

    for (size_t i = 0; i < dyn_count; i++) {
        switch ((uintptr_t) dyn[i].d_tag) {
        case DT_SYMTAB: symtab_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_STRTAB: strtab_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_STRSZ: strsz = (size_t) dyn[i].d_un.d_val; break;
        case DT_SYMENT: syment = (size_t) dyn[i].d_un.d_val; break;
        case DT_REL: rel_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_RELSZ: rel_sz = (size_t) dyn[i].d_un.d_val; break;
        case DT_RELA: rela_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_RELASZ: rela_sz = (size_t) dyn[i].d_un.d_val; break;
        case DT_JMPREL: jmprel_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_PLTRELSZ: jmprel_sz = (size_t) dyn[i].d_un.d_val; break;
        case DT_PLTREL: out->pltrel_type = (int) dyn[i].d_un.d_val; break;
        case DT_GNU_HASH: gnu_hash_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_INIT: out->init_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_INIT_ARRAY: out->init_array_vaddr = (ElfW(Addr)) dyn[i].d_un.d_ptr; break;
        case DT_INIT_ARRAYSZ: out->init_array_sz = (size_t) dyn[i].d_un.d_val; break;
        case DT_NEEDED:
            if (needed_str_offsets && needed_i < needed_count)
                needed_str_offsets[needed_i++] = (size_t) dyn[i].d_un.d_val;
            break;
        case DT_NULL: i = dyn_count; break;
        }
    }

    if (!syment) syment = sizeof(ElfW(Sym));
    if (!symtab_vaddr || !strtab_vaddr || !strsz) {
        LOGE("missing DT_SYMTAB/DT_STRTAB/DT_STRSZ");
        goto cleanup;
    }

    if (!vaddr_to_offset(phdr, eh->e_phnum, symtab_vaddr, &out->symtab_off) ||
        !vaddr_to_offset(phdr, eh->e_phnum, strtab_vaddr, &out->strtab_off)) {
        LOGE("failed vaddr_to_offset for symtab/strtab");
        goto cleanup;
    }

    if (rel_vaddr && rel_sz) {
        if (!vaddr_to_offset(phdr, eh->e_phnum, rel_vaddr, &out->rel_off)) goto cleanup;
        out->rel_sz = rel_sz;
    }
    if (rela_vaddr && rela_sz) {
        if (!vaddr_to_offset(phdr, eh->e_phnum, rela_vaddr, &out->rela_off)) goto cleanup;
        out->rela_sz = rela_sz;
    }
    if (jmprel_vaddr && jmprel_sz) {
        if (!vaddr_to_offset(phdr, eh->e_phnum, jmprel_vaddr, &out->jmprel_off)) goto cleanup;
        out->jmprel_sz = jmprel_sz;
    }

    out->strtab = (char *) malloc(strsz + 1);
    if (!out->strtab) {
        LOGE("failed to allocate string table");
        goto cleanup;
    }
    if (!pread_full(fd, out->strtab, strsz, out->strtab_off)) {
        LOGE("failed to read string table");
        free(out->strtab);
        out->strtab = nullptr;
        goto cleanup;
    }
    out->strtab[strsz] = '\0';

    out->syment = syment;
    out->strsz = strsz;
    out->needed_count = needed_count;
    out->needed_str_offsets = needed_str_offsets;
    out->nsyms = 0;

    // Derive the symbol count from the GNU hash table so we can iterate dynsym.
    if (gnu_hash_vaddr) {
        off_t gnu_hash_off = 0;
        if (vaddr_to_offset(phdr, eh->e_phnum, gnu_hash_vaddr, &gnu_hash_off)) {
            uint32_t header[4];
            if (pread_full(fd, header, sizeof(header), gnu_hash_off)) {
                uint32_t nbuckets = header[0];
                uint32_t symoffset = header[1];
                uint32_t bloom_size = header[2];

                size_t bloom_words = bloom_size * sizeof(ElfW(Addr));
                off_t buckets_off = gnu_hash_off + 16 + (off_t) bloom_words;

                uint32_t max_bucket = 0;
                for (uint32_t b = 0; b < nbuckets; b++) {
                    uint32_t bucket_val;
                    if (!pread_full(fd, &bucket_val, sizeof(bucket_val),
                                    buckets_off + (off_t) (b * 4)))
                        break;
                    if (bucket_val > max_bucket) max_bucket = bucket_val;
                }

                if (max_bucket >= symoffset) {
                    off_t chains_off = buckets_off + (off_t) (nbuckets * 4);
                    uint32_t chain_idx = max_bucket - symoffset;
                    uint32_t chain_val;
                    while (pread_full(fd, &chain_val, sizeof(chain_val),
                                      chains_off + (off_t) (chain_idx * 4))) {
                        if (chain_val & 1) {
                            out->nsyms = max_bucket + 1;
                            break;
                        }
                        max_bucket++;
                        chain_idx++;
                    }
                    if (!out->nsyms) out->nsyms = max_bucket + 1;
                } else {
                    out->nsyms = symoffset;
                }
            }
        }
    }

    success = true;

cleanup:
    free(dyn);
    if (!success) free(needed_str_offsets);
    return success;
}

// Look up a defined symbol by name in the dynamic symbol table.
static bool find_dynsym_value(int fd, const struct elf_dyn_info *info, const char *sym_name,
                              ElfW(Addr) * out_value) {
    for (size_t i = 0; i < info->nsyms; i++) {
        ElfW(Sym) sym;
        if (!pread_full(fd, &sym, sizeof(sym), info->symtab_off + (off_t) (i * info->syment)))
            break;
        if (sym.st_name == 0 || sym.st_name >= info->strsz) continue;
        const char *name = &info->strtab[sym.st_name];
        if (strcmp(name, sym_name) != 0 || sym.st_shndx == SHN_UNDEF) continue;
        *out_value = sym.st_value;
        return true;
    }
    LOGE("symbol not found in dynsym: %s", sym_name);
    return false;
}

#ifdef __LP64__
#define ELF_R_TYPE ELF64_R_TYPE
#define ELF_R_SYM ELF64_R_SYM
#else
#define ELF_R_TYPE ELF32_R_TYPE
#define ELF_R_SYM ELF32_R_SYM
#endif

// Resolve a symbol referenced by a relocation: local definitions use the load
// bias; undefined symbols are looked up in the DT_NEEDED libraries (and, for the
// dl* family, the linker's __dl_* exports).
static bool resolve_symbol_addr(int fd, const struct elf_dyn_info *info,
                                const std::vector<MapInfo> &local_map,
                                const std::vector<MapInfo> &remote_map,
                                const char *const *needed_paths, uintptr_t load_bias,
                                size_t sym_idx, uintptr_t *out_addr) {
    ElfW(Sym) sym;
    if (!pread_full(fd, &sym, sizeof(sym), info->symtab_off + (off_t) (sym_idx * info->syment)))
        return false;

    if (sym.st_shndx != SHN_UNDEF) {
        *out_addr = (uintptr_t) load_bias + (uintptr_t) sym.st_value;
        return true;
    }

    if (sym.st_name == 0 || sym.st_name >= info->strsz) return false;
    const char *name = &info->strtab[sym.st_name];
    if (!name || !*name) return false;

    // EH-frame registration is optional in CSOLoader and awkward to resolve
    // remotely; leave it null (matches upstream).
    if (strcmp(name, "__register_frame") == 0 || strcmp(name, "__deregister_frame") == 0) {
        LOGW("bypassing resolution of EH frame function: %s", name);
        *out_addr = 0;
        return true;
    }

    for (size_t i = 0; i < info->needed_count; i++) {
        const char *mod_path = needed_paths ? needed_paths[i] : nullptr;
        if (!mod_path) continue;
        void *addr = find_func_addr(local_map, remote_map, mod_path, name);
        if (addr) {
            *out_addr = (uintptr_t) addr;
            return true;
        }
    }

    // The dl* family lives in the linker itself as __dl_* exports; some old
    // devices don't have libdl.so mapped to resolve them the usual way.
    if (strcmp(name, "dlopen") == 0 || strcmp(name, "dlsym") == 0 ||
        strcmp(name, "dlerror") == 0 || strcmp(name, "dl_iterate_phdr") == 0 ||
        strcmp(name, "dlclose") == 0) {
        const char *linker_dl_symbol = "__dl_dlopen";
        if (strcmp(name, "dlsym") == 0) linker_dl_symbol = "__dl_dlsym";
        else if (strcmp(name, "dlerror") == 0) linker_dl_symbol = "__dl_dlerror";
        else if (strcmp(name, "dl_iterate_phdr") == 0) linker_dl_symbol = "__dl_dl_iterate_phdr";
        else if (strcmp(name, "dlclose") == 0) linker_dl_symbol = "__dl_dlclose";

        LOGD("resolving %s from the linker as %s", name, linker_dl_symbol);
        void *addr = find_func_addr(local_map, remote_map,
                                    "/system/bin/" LP_SELECT("linker", "linker64"), linker_dl_symbol);
        if (addr) {
            *out_addr = (uintptr_t) addr;
            return true;
        }
    }

    LOGE("failed to resolve external symbol %s", name);
    return false;
}

static bool write_remote_addr(int pid, uintptr_t addr, ElfW(Addr) value) {
    return write_proc(pid, addr, &value, sizeof(value)) == (ssize_t) sizeof(value);
}

static bool read_remote_addr(int pid, uintptr_t addr, ElfW(Addr) * out) {
    return read_proc(pid, addr, out, sizeof(*out)) == (ssize_t) sizeof(*out);
}

// Apply RELA-format relocations (aarch64 / x86_64, and the generic relative).
static bool apply_rela_section(int pid, int fd, const struct elf_dyn_info *info,
                               const std::vector<MapInfo> &local_map,
                               const std::vector<MapInfo> &remote_map,
                               const char *const *needed_paths, uintptr_t load_bias, off_t rela_off,
                               size_t rela_sz) {
    size_t count = rela_sz / sizeof(ElfW(Rela));
    for (size_t i = 0; i < count; i++) {
        ElfW(Rela) r;
        if (!pread_full(fd, &r, sizeof(r), rela_off + (off_t) (i * sizeof(r)))) return false;

        unsigned type = (unsigned) ELF_R_TYPE(r.r_info);
        unsigned sym = (unsigned) ELF_R_SYM(r.r_info);
        uintptr_t target = (uintptr_t) load_bias + (uintptr_t) r.r_offset;
        ElfW(Addr) value = 0;

#if defined(__aarch64__)
        if (type == R_AARCH64_RELATIVE) {
            value = (ElfW(Addr)) load_bias + (ElfW(Addr)) r.r_addend;
        } else if (type == R_AARCH64_GLOB_DAT || type == R_AARCH64_JUMP_SLOT ||
                   type == R_AARCH64_ABS64) {
            uintptr_t sym_addr = 0;
            if (!resolve_symbol_addr(fd, info, local_map, remote_map, needed_paths, load_bias, sym,
                                     &sym_addr))
                return false;
            value = sym_addr ? (ElfW(Addr)) sym_addr + (ElfW(Addr)) r.r_addend : 0;
        } else {
            LOGE("unsupported AArch64 RELA type %u", type);
            return false;
        }
#elif defined(__x86_64__)
        if (type == R_X86_64_RELATIVE) {
            value = (ElfW(Addr)) load_bias + (ElfW(Addr)) r.r_addend;
        } else if (type == R_X86_64_GLOB_DAT || type == R_X86_64_JUMP_SLOT || type == R_X86_64_64) {
            uintptr_t sym_addr = 0;
            if (!resolve_symbol_addr(fd, info, local_map, remote_map, needed_paths, load_bias, sym,
                                     &sym_addr))
                return false;
            value = sym_addr ? (ElfW(Addr)) sym_addr + (ElfW(Addr)) r.r_addend : 0;
        } else {
            LOGE("unsupported x86_64 RELA type %u", type);
            return false;
        }
#else
        (void) info;
        (void) local_map;
        (void) remote_map;
        (void) sym;
        (void) needed_paths;
        if (type == 0) {
            value = (ElfW(Addr)) load_bias + (ElfW(Addr)) r.r_addend;
        } else {
            LOGE("unsupported RELA type %u", type);
            return false;
        }
#endif

        if (!write_remote_addr(pid, target, value)) return false;
    }
    return true;
}

// Apply REL-format relocations (arm / i386, and the generic relative).
static bool apply_rel_section(int pid, int fd, const struct elf_dyn_info *info,
                              const std::vector<MapInfo> &local_map,
                              const std::vector<MapInfo> &remote_map,
                              const char *const *needed_paths, uintptr_t load_bias, off_t rel_off,
                              size_t rel_sz) {
    size_t count = rel_sz / sizeof(ElfW(Rel));
    for (size_t i = 0; i < count; i++) {
        ElfW(Rel) r;
        if (!pread_full(fd, &r, sizeof(r), rel_off + (off_t) (i * sizeof(r)))) return false;

        unsigned type = (unsigned) ELF_R_TYPE(r.r_info);
        unsigned sym = (unsigned) ELF_R_SYM(r.r_info);
        uintptr_t target = (uintptr_t) load_bias + (uintptr_t) r.r_offset;
        ElfW(Addr) addend = 0;
        ElfW(Addr) value = 0;

#if defined(__arm__)
        if (type == R_ARM_RELATIVE) {
            if (!read_remote_addr(pid, target, &addend)) return false;
            value = (ElfW(Addr)) load_bias + addend;
        } else if (type == R_ARM_GLOB_DAT || type == R_ARM_JUMP_SLOT || type == R_ARM_ABS32) {
            uintptr_t sym_addr = 0;
            if (!resolve_symbol_addr(fd, info, local_map, remote_map, needed_paths, load_bias, sym,
                                     &sym_addr))
                return false;
            if (sym_addr == 0) {
                value = 0;
            } else if (type == R_ARM_ABS32) {
                if (!read_remote_addr(pid, target, &addend)) return false;
                value = (ElfW(Addr)) sym_addr + addend;
            } else {
                value = (ElfW(Addr)) sym_addr;
            }
        } else {
            LOGE("unsupported ARM REL type %u", type);
            return false;
        }
#elif defined(__i386__)
        if (type == R_386_RELATIVE) {
            if (!read_remote_addr(pid, target, &addend)) return false;
            value = (ElfW(Addr)) load_bias + addend;
        } else if (type == R_386_GLOB_DAT || type == R_386_JMP_SLOT || type == R_386_32) {
            uintptr_t sym_addr = 0;
            if (!resolve_symbol_addr(fd, info, local_map, remote_map, needed_paths, load_bias, sym,
                                     &sym_addr))
                return false;
            if (sym_addr == 0) {
                value = 0;
            } else if (type == R_386_32) {
                if (!read_remote_addr(pid, target, &addend)) return false;
                value = (ElfW(Addr)) sym_addr + addend;
            } else {
                value = (ElfW(Addr)) sym_addr;
            }
        } else {
            LOGE("unsupported i386 REL type %u", type);
            return false;
        }
#else
        (void) info;
        (void) local_map;
        (void) remote_map;
        (void) sym;
        (void) needed_paths;
        (void) addend;
        (void) target;
        LOGE("REL relocations are not supported on this architecture");
        return false;
#endif

        if (!write_remote_addr(pid, target, value)) return false;
    }
    return true;
}

static bool apply_relocations(int pid, int fd, const struct elf_dyn_info *info,
                              const std::vector<MapInfo> &local_map,
                              const std::vector<MapInfo> &remote_map,
                              const char *const *needed_paths, uintptr_t load_bias) {
    if (info->rela_sz && info->rela_off) {
        if (!apply_rela_section(pid, fd, info, local_map, remote_map, needed_paths, load_bias,
                                info->rela_off, info->rela_sz))
            return false;
    }
    if (info->rel_sz && info->rel_off) {
        if (!apply_rel_section(pid, fd, info, local_map, remote_map, needed_paths, load_bias,
                               info->rel_off, info->rel_sz))
            return false;
    }
    // PLT relocations use whichever of RELA/REL the DT_PLTREL tag names.
    if (info->jmprel_sz && info->jmprel_off) {
        if (info->pltrel_type == DT_RELA) {
            if (!apply_rela_section(pid, fd, info, local_map, remote_map, needed_paths, load_bias,
                                    info->jmprel_off, info->jmprel_sz))
                return false;
        } else if (info->pltrel_type == DT_REL) {
            if (!apply_rel_section(pid, fd, info, local_map, remote_map, needed_paths, load_bias,
                                   info->jmprel_off, info->jmprel_sz))
                return false;
        } else {
            LOGE("unknown DT_PLTREL type %d", info->pltrel_type);
            return false;
        }
    }
    return true;
}

// --- Main entry ---------------------------------------------------------------

bool remote_csoloader_load_and_resolve_entry(int pid, struct user_regs_struct &regs,
                                             const std::vector<MapInfo> &remote_map,
                                             const std::vector<MapInfo> &local_map,
                                             const char *lib_path, uintptr_t *out_base,
                                             size_t *out_total_size, uintptr_t *out_entry) {
    struct user_regs_struct regs_saved = regs;

    long page_size_long = sysconf(_SC_PAGESIZE);
    if (page_size_long <= 0) {
        LOGE("sysconf(_SC_PAGESIZE) failed");
        return false;
    }
    size_t page_size = (size_t) page_size_long;

    // The ELF file is opened locally to read headers/relocations; segment
    // contents are mapped into the target via a remote openat of the same path.
    int fd = open(lib_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        PLOGE("open %s", lib_path);
        return false;
    }

    ElfW(Ehdr) eh;
    ElfW(Phdr) *phdr = nullptr;
    ElfW(Addr) min_vaddr = 0;
    size_t map_size = 0;
    if (!compute_load_layout(fd, page_size, &eh, &phdr, &min_vaddr, &map_size)) {
        LOGE("failed to parse ELF program headers for %s", lib_path);
        close(fd);
        return false;
    }

    // Raw syscalls (rather than remote libc calls) sidestep IBT/GCS enforcement
    // that can reject a ptrace-driven indirect call into a libc export.
    uintptr_t syscall_gadget = find_syscall_gadget(pid, remote_map);
    if (!syscall_gadget) {
        LOGE("failed to find a syscall gadget");
        free(phdr);
        close(fd);
        return false;
    }

    long args[6];

    // Stage the path string on the target's stack for the remote openat.
    size_t path_len = strlen(lib_path) + 1;
    uintptr_t remote_path = regs_saved.REG_SP - ALIGN_UP(path_len, (size_t) 16);
    if (write_proc(pid, remote_path, lib_path, path_len) != (ssize_t) path_len) {
        LOGE("failed to write library path to the target stack");
        free(phdr);
        close(fd);
        return false;
    }
    regs.REG_SP = remote_path;

    args[0] = AT_FDCWD;
    args[1] = (long) remote_path;
    args[2] = O_RDONLY | O_CLOEXEC;
    args[3] = 0;
    long remote_fd = remote_syscall(pid, regs, syscall_gadget, __NR_openat, args, 4);
    if (remote_fd < 0) {
        LOGE("remote openat(%s) failed: %ld", lib_path, remote_fd);
        free(phdr);
        close(fd);
        return false;
    }

    // Scrub the path from the target stack now that the fd is open.
    {
        size_t zlen = ALIGN_UP(path_len, (size_t) 16);
        void *zeros = calloc(1, zlen);
        if (zeros) {
            write_proc(pid, remote_path, zeros, zlen);
            free(zeros);
        }
    }

    // Reserve the whole mapping span. On LP64 request a high (4 GiB+) base so it
    // stays clear of where the target later grows its own VMAs.
    uintptr_t min_addr = sizeof(void *) == 8 ? 0x100000000ULL : (uintptr_t) 0;
    args[0] = (long) min_addr;
    args[1] = (long) map_size;
    args[2] = PROT_NONE;
    args[3] = MAP_PRIVATE | MAP_ANONYMOUS;
    args[4] = -1;
    args[5] = 0;
    uintptr_t remote_base = (uintptr_t) remote_syscall(pid, regs, syscall_gadget, SYS_MMAP, args, 6);
    if (!remote_base || remote_base == (uintptr_t) MAP_FAILED) {
        LOGE("remote mmap reserve failed: %p", (void *) remote_base);
        args[0] = remote_fd;
        remote_syscall(pid, regs, syscall_gadget, __NR_close, args, 1);
        free(phdr);
        close(fd);
        return false;
    }
#ifdef __LP64__
    if (remote_base < min_addr) {
        LOGE("remote mmap reserve returned a low base %p (< %p)", (void *) remote_base,
             (void *) min_addr);
        args[0] = (long) remote_base;
        args[1] = (long) map_size;
        remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
        args[0] = remote_fd;
        remote_syscall(pid, regs, syscall_gadget, __NR_close, args, 1);
        free(phdr);
        close(fd);
        return false;
    }
#endif

    uintptr_t load_bias = remote_base - (uintptr_t) min_vaddr;

    // Segments recorded here get their final protections applied after
    // relocations (which need them temporarily writable).
    struct {
        uintptr_t addr;
        size_t len;
        int final_prot;
    } segs[64];
    size_t segs_count = 0;

    for (int i = 0; i < eh.e_phnum; i++) {
        if (phdr[i].p_type != PT_LOAD) continue;

        uintptr_t seg_start = (uintptr_t) phdr[i].p_vaddr + load_bias;
        uintptr_t seg_page = page_start(seg_start, page_size);
        uintptr_t seg_end = (uintptr_t) phdr[i].p_vaddr + (uintptr_t) phdr[i].p_memsz + load_bias;
        uintptr_t seg_page_end = page_end(seg_end, page_size);
        size_t seg_page_len = (size_t) (seg_page_end - seg_page);

        off_t seg_offset = (off_t) phdr[i].p_offset;
        off_t file_page_offset = (off_t) page_start((uintptr_t) seg_offset, page_size);
        uintptr_t file_end = (uintptr_t) phdr[i].p_vaddr + (uintptr_t) phdr[i].p_filesz + load_bias;
        uintptr_t file_page_end = page_end(file_end, page_size);
        bool is_writable = (phdr[i].p_flags & PF_W) != 0;

        // Map the file-backed portion R/W first (relocations patch into it).
        if (phdr[i].p_filesz > 0) {
            size_t file_map_len = (size_t) (file_page_end - seg_page);
            args[0] = (long) seg_page;
            args[1] = (long) file_map_len;
            args[2] = PROT_READ | PROT_WRITE;
            args[3] = MAP_FIXED | MAP_PRIVATE;
            args[4] = remote_fd;
            args[5] = remote_mmap_offset_arg(file_page_offset, page_size);
            uintptr_t seg_map =
                (uintptr_t) remote_syscall(pid, regs, syscall_gadget, SYS_MMAP, args, 6);
            if (!seg_map || seg_map == (uintptr_t) MAP_FAILED) {
                LOGE("remote mmap of file-backed segment %d failed", i);
                args[0] = remote_fd;
                remote_syscall(pid, regs, syscall_gadget, __NR_close, args, 1);
                free(phdr);
                close(fd);
                return false;
            }

            // Zero the tail of the last file page for a writable segment (the
            // .bss bleed within the final page).
            if (is_writable && file_page_end > file_end) {
                size_t tail_len = (size_t) (file_page_end - file_end);
                void *zeros = calloc(1, tail_len);
                if (!zeros || write_proc(pid, file_end, zeros, tail_len) != (ssize_t) tail_len) {
                    LOGE("failed to zero the tail of segment %d", i);
                    free(zeros);
                    args[0] = remote_fd;
                    remote_syscall(pid, regs, syscall_gadget, __NR_close, args, 1);
                    free(phdr);
                    close(fd);
                    return false;
                }
                free(zeros);
            }
        }

        // Map any remaining anonymous (.bss) pages beyond the file contents.
        if (seg_page_end > file_page_end) {
            args[0] = (long) file_page_end;
            args[1] = (long) (seg_page_end - file_page_end);
            args[2] = PROT_READ | PROT_WRITE;
            args[3] = MAP_FIXED | MAP_PRIVATE | MAP_ANONYMOUS;
            args[4] = -1;
            args[5] = 0;
            uintptr_t bss_map =
                (uintptr_t) remote_syscall(pid, regs, syscall_gadget, SYS_MMAP, args, 6);
            if (!bss_map || bss_map == (uintptr_t) MAP_FAILED) {
                LOGE("remote mmap of bss for segment %d failed", i);
                args[0] = remote_fd;
                remote_syscall(pid, regs, syscall_gadget, __NR_close, args, 1);
                free(phdr);
                close(fd);
                return false;
            }
        }

        int prot = 0;
        if (phdr[i].p_flags & PF_R) prot |= PROT_READ;
        if (phdr[i].p_flags & PF_W) prot |= PROT_WRITE;
        if (phdr[i].p_flags & PF_X) prot |= PROT_EXEC;
        if (segs_count < (sizeof(segs) / sizeof(segs[0]))) {
            segs[segs_count].addr = seg_page;
            segs[segs_count].len = seg_page_len;
            segs[segs_count].final_prot = prot;
            segs_count++;
        }
    }

    args[0] = remote_fd;
    remote_syscall(pid, regs, syscall_gadget, __NR_close, args, 1);

    struct elf_dyn_info dinfo;
    if (!elf_load_dyn_info(fd, &eh, phdr, &dinfo)) {
        LOGE("failed to load ELF dynamic info");
        free(phdr);
        close(fd);
        return false;
    }

    const char **needed_paths = nullptr;
    if (dinfo.needed_count) {
        needed_paths = (const char **) calloc(dinfo.needed_count, sizeof(char *));
        if (!needed_paths) {
            LOGE("failed to allocate needed-paths array");
            elf_dyn_info_destroy(&dinfo);
            free(phdr);
            close(fd);
            return false;
        }
        for (size_t i = 0; i < dinfo.needed_count; i++) {
            size_t off = dinfo.needed_str_offsets[i];
            if (off >= dinfo.strsz) continue;
            needed_paths[i] = find_remote_module_path(remote_map, &dinfo.strtab[off]);
        }
    }

    if (!apply_relocations(pid, fd, &dinfo, local_map, remote_map, needed_paths, load_bias)) {
        LOGE("failed to apply relocations");
        free((void *) needed_paths);
        elf_dyn_info_destroy(&dinfo);
        free(phdr);
        close(fd);
        return false;
    }

    // Now that relocations are written, tighten each segment to its ELF perms.
    for (size_t i = 0; i < segs_count; i++) {
        args[0] = (long) segs[i].addr;
        args[1] = (long) segs[i].len;
        args[2] = segs[i].final_prot;
        long mp_ret = remote_syscall(pid, regs, syscall_gadget, __NR_mprotect, args, 3);
        if (mp_ret < 0) {
            LOGE("failed to set final protection on segment at %p: %ld", (void *) segs[i].addr,
                 mp_ret);
            args[0] = (long) remote_base;
            args[1] = (long) map_size;
            remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
            free((void *) needed_paths);
            elf_dyn_info_destroy(&dinfo);
            free(phdr);
            close(fd);
            return false;
        }
    }

    // A system dlopen runs DT_INIT and DT_INIT_ARRAY before returning. Since
    // this loader deliberately bypasses the system linker, we must reproduce
    // that step ourselves. Without it, C++ globals in libzygisk (notably the
    // daemon path std::string) remain zero-initialized but unconstructed and
    // entry() crashes on its first assignment.
    uintptr_t constructor_return =
        (uintptr_t) find_module_return_addr(remote_map, "libc.so");
    if (!constructor_return) {
        LOGE("failed to find a safe return trap for libzygisk constructors");
        args[0] = (long) remote_base;
        args[1] = (long) map_size;
        remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
        free((void *) needed_paths);
        elf_dyn_info_destroy(&dinfo);
        free(phdr);
        close(fd);
        return false;
    }

    std::vector<long> constructor_args;
    auto call_constructor = [&](uintptr_t address, const char *kind, size_t index) {
        bool succeeded = false;
        remote_call(pid, regs, address, constructor_return, constructor_args, &succeeded);
        if (!succeeded) {
            LOGE("%s constructor %zu at %p failed", kind, index, (void *) address);
        }
        return succeeded;
    };

    if (dinfo.init_vaddr &&
        !call_constructor(load_bias + (uintptr_t) dinfo.init_vaddr, "DT_INIT", 0)) {
        args[0] = (long) remote_base;
        args[1] = (long) map_size;
        remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
        regs = regs_saved;
        set_regs(pid, regs_saved);
        free((void *) needed_paths);
        elf_dyn_info_destroy(&dinfo);
        free(phdr);
        close(fd);
        return false;
    }

    if (dinfo.init_array_vaddr && dinfo.init_array_sz) {
        if (dinfo.init_array_sz % sizeof(ElfW(Addr)) != 0) {
            LOGE("invalid DT_INIT_ARRAYSZ: %zu", dinfo.init_array_sz);
            args[0] = (long) remote_base;
            args[1] = (long) map_size;
            remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
            regs = regs_saved;
            set_regs(pid, regs_saved);
            free((void *) needed_paths);
            elf_dyn_info_destroy(&dinfo);
            free(phdr);
            close(fd);
            return false;
        }

        uintptr_t init_array = load_bias + (uintptr_t) dinfo.init_array_vaddr;
        size_t constructor_count = dinfo.init_array_sz / sizeof(ElfW(Addr));
        for (size_t i = 0; i < constructor_count; i++) {
            ElfW(Addr) constructor = 0;
            if (!read_remote_addr(pid, init_array + i * sizeof(constructor), &constructor)) {
                LOGE("failed to read DT_INIT_ARRAY constructor %zu", i);
                args[0] = (long) remote_base;
                args[1] = (long) map_size;
                remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
                regs = regs_saved;
                set_regs(pid, regs_saved);
                free((void *) needed_paths);
                elf_dyn_info_destroy(&dinfo);
                free(phdr);
                close(fd);
                return false;
            }
            if (!constructor || constructor == (ElfW(Addr)) -1) continue;
            if (!call_constructor((uintptr_t) constructor, "DT_INIT_ARRAY", i)) {
                args[0] = (long) remote_base;
                args[1] = (long) map_size;
                remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
                regs = regs_saved;
                set_regs(pid, regs_saved);
                free((void *) needed_paths);
                elf_dyn_info_destroy(&dinfo);
                free(phdr);
                close(fd);
                return false;
            }
        }
    }

    ElfW(Addr) entry_value = 0;
    if (!find_dynsym_value(fd, &dinfo, "entry", &entry_value)) {
        LOGE("failed to resolve `entry` from the ELF dynsym");
        args[0] = (long) remote_base;
        args[1] = (long) map_size;
        remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
        regs = regs_saved;
        set_regs(pid, regs_saved);
        free((void *) needed_paths);
        elf_dyn_info_destroy(&dinfo);
        free(phdr);
        close(fd);
        return false;
    }
    uintptr_t remote_entry = (uintptr_t) load_bias + (uintptr_t) entry_value;

    // Constructor calls intentionally stop at a synthetic return trap and
    // therefore leave the live register set at that trap.  Hand the caller the
    // exact pre-loader state so its next remote call starts from a clean stack.
    regs = regs_saved;
    if (!set_regs(pid, regs_saved)) {
        LOGE("failed to restore registers after custom loading");
        args[0] = (long) remote_base;
        args[1] = (long) map_size;
        remote_syscall(pid, regs, syscall_gadget, __NR_munmap, args, 2);
        free((void *) needed_paths);
        elf_dyn_info_destroy(&dinfo);
        free(phdr);
        close(fd);
        return false;
    }

    free((void *) needed_paths);
    elf_dyn_info_destroy(&dinfo);
    free(phdr);
    close(fd);

    *out_base = remote_base;
    *out_total_size = map_size;
    *out_entry = remote_entry;

    LOGI("remote-mapped %s at %p (size %zu), entry %p", lib_path, (void *) remote_base, map_size,
         (void *) remote_entry);
    return true;
}
