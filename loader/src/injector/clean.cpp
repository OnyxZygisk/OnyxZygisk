#include <linux/mman.h>
#include <sys/mman.h>
#include <unistd.h>

#include <cstring>
#include <string_view>

#include <lsplt.hpp>

#include "atexit.hpp"
#include "fossil.hpp"
#include "logging.hpp"
#include "solist.hpp"
#include "zygisk.hpp"

void clean_libc_trace() {
    auto g_array = Atexit::findAtexitArray();
    if (g_array != nullptr) {
        g_array->recompact();
        LOGV("g_array after recompact: %s", g_array->format_state_string().c_str());
    }
}

void clean_linker_trace(const char *path, size_t loaded_modules, size_t unloaded_modules,
                        bool unload_soinfo) {
    LOGV("cleaning linker trace for path %s", path);
    Linker::dropSoPath(path, unload_soinfo);

    if (unload_soinfo) {
        Linker::resetCounters(loaded_modules, loaded_modules);
    } else {
        Linker::resetCounters(loaded_modules, unloaded_modules);
    }
}

void spoof_virtual_maps(const char *path, bool clear_write_permission) {
    // spoofing map path names is futile in Android, we do it simply
    // to avoid trivial Zygisk detections based on string comparison.
    for (auto &map : lsplt::MapInfo::Scan()) {
        void *addr = (void *) map.start;
        size_t size = map.end - map.start;

        if (strstr(map.path.c_str(), path)) {
            LOGV("spoofing entry path contaning string %s", map.path.c_str());
            // Create an anonymous mapping to hold a copy of the original data
            void *copy = mmap(nullptr, size, PROT_WRITE, MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
            if (copy == MAP_FAILED) {
                LOGE("failed to backup block %s [%p, %p]", map.path.c_str(), addr,
                     (void *) map.end);
                continue;
            }
            // Ensure the original mapping is readable before copying
            if ((map.perms & PROT_READ) == 0) {
                mprotect(addr, size, PROT_READ);
            }
            memcpy(copy, addr, size);
            // Overwrite the original mapping with our anonymous copy
            if (mremap(copy, size, size, MREMAP_MAYMOVE | MREMAP_FIXED, addr) == MAP_FAILED) {
                LOGE("mremap failed for %s [%p, %p]", map.path.c_str(), addr, (void *) map.end);
            }
            // The backup copy is now at the original address, we can unmap our temporary one.
            // Note: The man page for mremap is ambiguous on whether the old mapping at 'copy'
            // is unmapped. To be safe and avoid potential leaks, we explicitly unmap it.
            munmap(copy, size);
            // Restore the original permissions
            mprotect(addr, size, map.perms);
        }

        if (clear_write_permission && map.path.size() > 0 &&
            (map.perms & (PROT_READ | PROT_WRITE | PROT_EXEC)) ==
                (PROT_READ | PROT_WRITE | PROT_EXEC)) {
            LOGV("clearing write permission for entry %s", map.path.c_str());
            int new_perms = map.perms & ~PROT_WRITE;  // Remove the write permission
            if (mprotect(addr, size, new_perms) == -1) {
                PLOGE("remove write permission from %s [%p, %p]", map.path.c_str(), addr,
                      (void *) map.end);
            } else {
                LOGV("write permission removed from %s [%p, %p]", map.path.c_str(), addr,
                     (void *) map.end);
            }
        }
    }
}

void spoof_zygote_fossil(char *search_from, char *search_to, const char *anchor) {
    Fossil::MountArgv suspicious_fossil = Fossil::MountArgv::find(search_from, search_to);
    if (!suspicious_fossil.isValid()) {
        LOGV("no valid fossil found on the stack");
        return;
    }
    suspicious_fossil.dump("current fossil");

    if (suspicious_fossil.getTarget().find(anchor) != std::string::npos) {
        LOGV("stack fossil appears to be the legitimate 'ref_profiles' entry");
        return;
    }

    auto mount_entries = Fossil::parseMountInfo();
    std::optional<Fossil::MountInfoEntry> clean_template_opt;
    for (size_t i = 1; i < mount_entries.size(); ++i) {
        if (mount_entries[i - 1].target.find(anchor) != std::string::npos &&
            mount_entries[i].is_suspicious) {
            clean_template_opt = mount_entries[i - 1];
            break;
        }
    }
    if (!clean_template_opt) {
        LOGV("no suspicious mount was found in mountinfo to identify a template");
        return;
    }
    const Fossil::MountInfoEntry &clean_entry = *clean_template_opt;
    LOGV("using preceding entry as the clean spoof template: '%s'", clean_entry.target.c_str());

    Fossil::MountArgv clean_fossil_to_write(clean_entry, suspicious_fossil.getStartAddress(),
                                            suspicious_fossil.getBaseFlags());
    clean_fossil_to_write.dump("spoofed fossil");

    suspicious_fossil.cleanMemory();
    clean_fossil_to_write.writeToMemory();
}

// ---------------------------------------------------------------------------
// TracerPid hiding
//
// Detection apps read /proc/<pid>/status and look for a non-zero
// `TracerPid:` line to flag the process as being ptraced.  OnyxZygisk
// attaches with PTRACE_SEIZE to inject libzygisk.so and detaches as soon
// as injection is done, but the kernel may briefly expose a non-zero
// TracerPid during the attach/detach window, and on some GKI 2.0 kernels
// the field can linger even after detach (see detach_with_gki_workaround
// in ptracer.cpp).
//
// To close the detection gap completely we PLT-hook `read` in the injected
// zygote and rewrite any `TracerPid:\t<non-zero>` line we see in the read
// buffer to `TracerPid:\t0`.  This covers every libc-based read of
// /proc/self/status regardless of which library issued it.
//
// The rewrite is in-place: `TracerPid:\t12345` and `TracerPid:\t0` differ
// in length, so we pad the remainder of the line with spaces and keep the
// trailing newline.  The total buffer size never changes.
size_t sanitize_tracer_pid_in_buffer(char *buf, size_t nbytes) {
    static constexpr std::string_view kNeedle = "TracerPid:";
    if (buf == nullptr || nbytes == 0) return nbytes;

    for (size_t i = 0; i + kNeedle.size() < nbytes; ++i) {
        if (std::memcmp(buf + i, kNeedle.data(), kNeedle.size()) != 0) continue;

        // Skip the colon and any whitespace after it.
        size_t j = i + kNeedle.size();
        while (j < nbytes && (buf[j] == ' ' || buf[j] == '\t')) ++j;

        // Parse the numeric value.
        size_t value_start = j;
        while (j < nbytes && buf[j] >= '0' && buf[j] <= '9') ++j;
        size_t value_end = j;

        // Only rewrite if the value is non-zero; a zero TracerPid is the
        // clean state we want to present.
        bool non_zero = false;
        for (size_t k = value_start; k < value_end; ++k) {
            if (buf[k] != '0') { non_zero = true; break; }
        }
        if (!non_zero) {
            i = value_end;  // skip past, keep scanning for another match
            continue;
        }

        // Replace the value with '0' and pad the rest of the line with
        // spaces so the buffer length stays identical.  The line ends at
        // the next '\n' or the end of the buffer.
        size_t line_end = j;
        while (line_end < nbytes && buf[line_end] != '\n') ++line_end;

        // Write "0" then spaces up to line_end.
        buf[value_start] = '0';
        for (size_t k = value_start + 1; k < line_end; ++k) buf[k] = ' ';

        LOGV("hid non-zero TracerPid in read buffer at offset %zu", i);
        i = line_end;
    }
    return nbytes;
}

// ---------------------------------------------------------------------------
// /proc/<pid>/maps path hiding
//
// Detection apps read /proc/self/maps and look for backing-file names that
// betray a Zygisk installation:
//   - `jit-cache-zygisk`  — the display name DlopenMem passes to
//     android_dlopen_ext when loading a module from a memfd.
//   - `memfd:...`         — a raw memfd_create file backing an exec mapping
//     (remote_csoloader or system-linker fd load).
//   - `zygisk-module`     — the on-disk path of a Zygisk module .so.
//
// We cannot mremap-anonymize these mappings in general: third-party module
// code may still be executing, and replacing its .text would crash the
// process.  Instead we PLT-hook `read` and strip the pathname field from
// any maps line whose path matches one of those markers.  The line itself
// is kept (address/perms/offset/dev/inode stay), so the row count and the
// address layout reported to the caller are unchanged — only the trailing
// pathname is blanked, making the mapping look anonymous.
//
// Because /proc/<pid>/maps is a seq_file and a single read() may return a
// partial line or span multiple lines, we scan the whole buffer and only
// rewrite a line when we can see its terminating '\n' (or EOF).  A partial
// line at the end of the buffer is left untouched — the next read will
// bring the rest and we'll sanitize it then.
size_t sanitize_maps_in_buffer(char *buf, size_t nbytes) {
    if (buf == nullptr || nbytes == 0) return nbytes;

    // Markers that identify a Zygisk-related backing file in a maps line.
    static constexpr std::string_view kMarkers[] = {
        "jit-cache-zygisk",
        "memfd:",
        "zygisk-module",
    };

    size_t i = 0;
    while (i < nbytes) {
        // Find the start of the pathname field: the 6th whitespace-separated
        // column in a maps line.  We scan forward from the line start and
        // count fields.  A maps line looks like:
        //   12c00000-12c10000 r-xp 00000000 fe:00 1234 /path/to/lib (deleted)
        size_t line_start = i;
        size_t field = 0;
        size_t path_start = i;
        size_t j = i;
        for (; j < nbytes; ++j) {
            if (buf[j] == '\n') break;
            if (buf[j] == ' ' || buf[j] == '\t') {
                // Skip runs of whitespace between fields.
                while (j < nbytes && (buf[j] == ' ' || buf[j] == '\t')) ++j;
                ++field;
                if (field == 5) {  // path is the 6th field (0-indexed 5)
                    path_start = j;
                }
                --j;  // the for-loop will ++j back to the next non-ws char
            }
        }

        // Only rewrite when we have a complete line (terminated by '\n' or
        // end of buffer).  j is either at '\n' or at nbytes.
        bool complete = (j < nbytes && buf[j] == '\n');
        if (complete && field >= 5) {
            // Check whether the pathname contains any marker.
            std::string_view path(buf + path_start, j - path_start);
            bool matched = false;
            for (auto m : kMarkers) {
                if (path.find(m) != std::string_view::npos) {
                    matched = true;
                    break;
                }
            }
            if (matched) {
                // Blank the pathname field (replace with spaces, keep the
                // trailing newline).  This keeps the line length identical
                // so downstream parsers that key on offsets are unaffected.
                for (size_t k = path_start; k < j; ++k) buf[k] = ' ';
                LOGV("hid maps path in line at offset %zu", line_start);
            }
        }

        i = (j < nbytes) ? j + 1 : j;  // advance past '\n'
    }
    return nbytes;
}
