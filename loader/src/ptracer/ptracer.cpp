#include <dlfcn.h>
#include <elf.h>
#include <link.h>
#include <signal.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <sys/ptrace.h>
#include <sys/system_properties.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "daemon.hpp"
#include "logging.hpp"
#include "remote_csoloader.hpp"
#include "utils.hpp"

/**
 * @brief Injects a shared library into a running process at its main entry point.
 *
 * This function orchestrates the core injection logic. It attaches to the target process,
 * intercepts its execution just before the first instruction, and uses this opportunity
 * to load a shared library (`libzygisk.so`) into the process's address space.
 *
 * The strategy is as follows:
 * 1.  **Parse Kernel Argument Block**: Read the process's stack to find the location of program
 *     arguments, environment variables, and the ELF Auxiliary Vector (auxv).
 * 2.  **Find Entry Point**: From the auxv, extract the `AT_ENTRY` value, which is the memory
 *     address of the program's first executable instruction. The dynamic linker has already
 *     run at this stage, making libraries like `libdl.so` available.
 * 3.  **Hijack Execution**: Overwrite the `AT_ENTRY` value in the process's memory with a
 *     deliberately invalid address. When the process is resumed, it will immediately trigger a
 *     segmentation fault (`SIGSEGV`), which we, as the tracer, can catch. This is a reliable
 *     way to pause the process at the perfect moment.
 * 4.  **Remote Code Execution**: Once the process is paused, we restore the original entry point.
 *     We then use `ptrace` to execute functions within the target process's context.
 *     - Remotely call `dlopen()` to load our library.
 *     - Remotely call `dlsym()` to find the address of our library's `entry` function.
 *     - Remotely call our `entry` function to initialize OnyxZygisk.
 * 5.  **Restore State**: After injection, restore all CPU registers, which allows the original
 *     entry point to be called when the process is fully resumed.
 *
 * @param pid The Process ID of the target (e.g., Zygote).
 * @param lib_path The absolute path to the shared library to be injected.
 * @return True on successful injection, false otherwise.
 */
bool inject_on_main(int pid, const char *lib_path) {
    LOGI("starting library injection for PID: %d, library: %s", pid, lib_path);

    // Backup of the target's registers, to be restored before detaching.
    struct user_regs_struct regs{}, backup{};
    auto map = MapInfo::Scan(std::to_string(pid));
    if (!get_regs(pid, regs)) {
        LOGE("failed to get registers for PID %d, injection aborted", pid);
        return false;
    }

    // --- Step 1 & 2: Parse Kernel Argument Block to Find Entry Point ---
    // The stack pointer (SP) at process startup points to the Kernel Argument Block.
    // We parse this structure to locate argc, argv, envp, and the auxiliary vector (auxv).
    // Ref:
    // https://cs.android.com/android/platform/superproject/main/+/main:bionic/libc/private/KernelArgumentBlock.h
    LOGV("reading kernel argument block from stack pointer: 0x%lx", (unsigned long) regs.REG_SP);
    auto sp = static_cast<uintptr_t>(regs.REG_SP);

    int argc;
    read_proc(pid, sp, &argc, sizeof(argc));

    auto argv = reinterpret_cast<char **>(sp + sizeof(uintptr_t));
    auto envp = argv + argc + 1;

    // Iterate past the environment variables to find the start of the auxiliary vector.
    // The end of envp is marked by a null pointer.
    auto p = envp;
    while (true) {
        uintptr_t val;
        read_proc(pid, (uintptr_t) p, &val, sizeof(val));
        if (val != 0) {
            p++;
        } else {
            break;
        }
    }
    p++;  // Skip the final null pointer to get to auxv.
    auto auxv = reinterpret_cast<ElfW(auxv_t) *>(p);
    LOGV("parsed process startup info: argc=%d, argv=%p, envp=%p, auxv=%p", argc, argv, envp, auxv);

    // Now, scan the auxiliary vector to find AT_ENTRY. This gives us the program's
    // entry address, which is where execution will begin.
    uintptr_t entry_addr = 0;
    uintptr_t addr_of_entry_addr = 0;
    auto v = auxv;
    while (true) {
        ElfW(auxv_t) buf;
        read_proc(pid, (uintptr_t) v, &buf, sizeof(buf));
        if (buf.a_type == AT_NULL) {
            break;  // End of auxiliary vector.
        }
        if (buf.a_type == AT_ENTRY) {
            entry_addr = (uintptr_t) buf.a_un.a_val;
            addr_of_entry_addr = (uintptr_t) v + offsetof(ElfW(auxv_t), a_un);
            break;
        }
        v++;
    }

    if (entry_addr == 0) {
        LOGE("failed to find AT_ENTRY in auxiliary vector for PID %d, cannot determine entry point",
             pid);
        return false;
    }
    LOGI("found program entry point at 0x%" PRIxPTR, entry_addr);

    // --- Step 3: Hijack Execution Flow ---
    // We replace the program's entry point with an invalid address. This causes a SIGSEGV
    // as soon as we resume the process, allowing us to regain control at the perfect time.
    LOGV("hijacking entry point to intercept execution");
    // For arm32 compatibility, we set the last bit to the same as the entry address.
    uintptr_t break_addr = (-0x05ec1cff & ~1) | (entry_addr & 1);  // An arbitrary invalid address.
    if (!write_proc(pid, addr_of_entry_addr, &break_addr, sizeof(break_addr))) {
        LOGE("failed to write hijack address to PID %d, injection aborted", pid);
        return false;
    }

    int status;

    while (true) {
        // Resume execution. We pass 0 to signal to suppress any pending SIGSTOPs.
        if (ptrace(PTRACE_CONT, pid, 0, 0) == -1) {
            PLOGE("ptrace(PTRACE_CONT) failed");
            return false;
        }

        wait_for_trace(pid, &status, __WALL);

        // 1. Handle Process Death
        if (WIFEXITED(status) || WIFSIGNALED(status)) {
            LOGE("process died unexpectedly: %s", parse_status(status).c_str());
            return false;
        }

        // 2. Handle Stops
        if (WIFSTOPPED(status)) {
            int sig = WSTOPSIG(status);

            if (sig == SIGSEGV) {
                // SUCCESS: We hit our trap.
                break;
            } else if (sig == SIGSTOP) {
                // NOISE: Spurious stop from PTRACE_ATTACH. Ignore and continue.
                continue;
            } else {
                // ERROR: Unexpected signal (e.g., SIGILL, SIGBUS). Abort.
                LOGE("process stopped for unexpected signal: %d", sig);
                return false;
            }
        }
    }

    // Verify we are truly at the trap
    if (!get_regs(pid, regs)) {
        LOGE("failed to get registers after SIGSEGV for PID %d", pid);
        return false;
    }
    // Sanity check: ensure we stopped at our invalid address.
    if (static_cast<uintptr_t>(regs.REG_IP & ~1) != (break_addr & ~1)) {
        LOGE("process stopped at unexpected address 0x%lx, expected ~0x%" PRIxPTR, regs.REG_IP,
             break_addr);
        return false;
    }

    LOGI("successfully intercepted process %d at its entry point", pid);

    // --- Step 4: Remote Code Execution ---
    // First, restore the original entry point in memory.
    if (!write_proc(pid, addr_of_entry_addr, &entry_addr, sizeof(entry_addr))) {
        LOGE("FATAL: failed to restore original entry point, process %d will not recover", pid);
        return false;
    }

    // Backup the current registers before we start making remote calls.
    // It is vital we keep the original PSTATE intact in the backup, so
    // the original executable can securely validate its own BTI pad upon final resume.
    memcpy(&backup, &regs, sizeof(regs));
    // Fix up the backup's IP right away: every failure path below simply
    // restores `backup` and returns, so the target always resumes at its real
    // entry point instead of the deliberately-invalid hijack address. Doing
    // this only on the final success path (as a previous version of this
    // function did) meant any failure past this point detached the target
    // with its IP still parked on the hijack address, crashing it for real
    // the instant it resumed.
    backup.REG_IP = (long) entry_addr;

#if defined(__aarch64__)
    // Clear the BTYPE field (bits 10 and 11) in PSTATE.
    // The previous indirect branch from the linker set BTYPE to 0b11.
    // If we jump into BTI-protected bionic libraries (like libdl.so) with BTYPE=0b11,
    // the CPU will throw a Branch Target Exception (SIGILL).
    regs.pstate &= ~(3ULL << 10);
#endif

    map = MapInfo::Scan(std::to_string(pid));  // Re-scan maps as they may have changed.
    auto local_map = MapInfo::Scan();
    auto libc_return_addr = find_module_return_addr(map, "libc.so");

    // Any failure from here on gracefully resumes the target at its real
    // entry point (via `backup`) instead of leaving it crashed or hung.
    auto abort_injection = [&](const char *msg) {
        LOGE("%s", msg);
        set_regs(pid, backup);
        return false;
    };

    if (libc_return_addr == nullptr) {
        return abort_injection("could not find a safe libc return trap in the target process");
    }

    // Where the injected library lands and the address of its `entry` symbol;
    // both load paths below fill these in.
    void *start_addr = nullptr;
    size_t block_size = 0;
    uintptr_t injector_entry = 0;
    bool custom_loaded = false;

    // --- Primary load: remote dlopen() through the system linker ---
    // Let bionic perform relocations and C++ constructor ordering whenever it
    // accepts the path.  Besides being simpler, this is important for zygote
    // safety: a failed hand-written constructor sequence may already have
    // mutated global state before it faults, so it must never be attempted
    // speculatively on devices where the normal linker works.
    LOGV("executing remote call to dlopen(\"%s\")", lib_path);
    auto dlopen_addr = find_func_addr(local_map, map, "libdl.so", "dlopen");
    if (dlopen_addr == nullptr) {
        return abort_injection("could not find address of dlopen in the target process");
    }
    std::vector<long> args;
    auto remote_lib_path = push_string(pid, regs, lib_path);
    if (remote_lib_path == 0) {
        return abort_injection("failed to push library path to target");
    }
    args.push_back((long) remote_lib_path);
    args.push_back((long) RTLD_NOW);
    bool dlopen_call_succeeded = false;
    auto remote_handle = remote_call(pid, regs, (uintptr_t) dlopen_addr,
                                     (uintptr_t) libc_return_addr, args,
                                     &dlopen_call_succeeded);

    // A signal or unexpected ptrace stop while running the system linker is not
    // a namespace rejection.  The tracee may be partially modified, so abort
    // instead of trying another loader in the same zygote.
    if (!dlopen_call_succeeded) {
        return abort_injection("remote dlopen did not return cleanly");
    }

    if (remote_handle != 0) {
        LOGI("successfully loaded library via remote dlopen, handle: 0x%" PRIxPTR,
             remote_handle);

        LOGV("executing remote call to dlsym to find the 'entry' symbol");
        auto dlsym_addr = find_func_addr(local_map, map, "libdl.so", "dlsym");
        if (dlsym_addr == nullptr) {
            return abort_injection("could not find address of dlsym in the target process");
        }
        args.clear();
        auto remote_entry_str = push_string(pid, regs, "entry");
        args.push_back(remote_handle);
        args.push_back((long) remote_entry_str);
        bool dlsym_call_succeeded = false;
        injector_entry = remote_call(pid, regs, (uintptr_t) dlsym_addr,
                                     (uintptr_t) libc_return_addr, args,
                                     &dlsym_call_succeeded);
        if (!dlsym_call_succeeded || injector_entry == 0) {
            return abort_injection(
                "dlsym failed to find the 'entry' symbol in the injected library");
        }
        LOGI("found injector entry point at address 0x%" PRIxPTR, injector_entry);

        map = MapInfo::Scan(std::to_string(pid));
        for (const auto &info : map) {
            if (info.path.find("libzygisk.so") != std::string::npos) {
                if (start_addr == nullptr) start_addr = (void *) info.start;
                block_size += (info.end - info.start);
            }
        }
        LOGV("found injected library mapped from %p with total size %zu", start_addr,
             block_size);
    } else {
        // dlopen returned normally but rejected the path.  This is the narrow
        // case the custom loader exists for (notably some KernelSU LKM linker
        // namespaces), so collect diagnostics and then use it as a fallback.
        LOGW("remote dlopen rejected the library; trying the custom loader fallback");
        if (auto access_addr = find_func_addr(local_map, map, "libc.so", "access");
            access_addr != nullptr) {
            args.clear();
            args.push_back((long) remote_lib_path);
            args.push_back(R_OK);
            bool access_call_succeeded = false;
            auto access_ret = remote_call(pid, regs, (uintptr_t) access_addr,
                                          (uintptr_t) libc_return_addr, args,
                                          &access_call_succeeded);
            if (access_call_succeeded) {
                LOGW("target-side access(\"%s\", R_OK) returned %ld (0 = readable)",
                     lib_path, (long) access_ret);
            }
        }

        if (auto dlerror_addr = find_func_addr(local_map, map, "libdl.so", "dlerror");
            dlerror_addr != nullptr) {
            args.clear();
            bool dlerror_call_succeeded = false;
            auto dlerror_str_addr = remote_call(pid, regs, (uintptr_t) dlerror_addr,
                                                (uintptr_t) libc_return_addr, args,
                                                &dlerror_call_succeeded);
            if (dlerror_call_succeeded && dlerror_str_addr != 0) {
                if (auto strlen_addr = find_func_addr(local_map, map, "libc.so", "strlen");
                    strlen_addr != nullptr) {
                    args.clear();
                    args.push_back(dlerror_str_addr);
                    bool strlen_call_succeeded = false;
                    auto dlerror_len = remote_call(pid, regs, (uintptr_t) strlen_addr,
                                                   (uintptr_t) libc_return_addr, args,
                                                   &strlen_call_succeeded);
                    if (strlen_call_succeeded && dlerror_len > 0 && dlerror_len < 4096) {
                        std::string err((size_t) dlerror_len + 1, 0);
                        read_proc(pid, (uintptr_t) dlerror_str_addr, err.data(), dlerror_len);
                        LOGW("dlopen error: %s", err.c_str());
                    }
                }
            }
        }

        uintptr_t rc_base = 0, rc_entry = 0;
        size_t rc_size = 0;
        if (!remote_csoloader_load_and_resolve_entry(pid, regs, map, local_map, lib_path,
                                                      &rc_base, &rc_size, &rc_entry)) {
            return abort_injection("both remote dlopen and the custom loader failed");
        }
        start_addr = (void *) rc_base;
        block_size = rc_size;
        injector_entry = rc_entry;
        custom_loaded = true;
        LOGI("mapped libzygisk via the custom loader fallback at %p (entry 0x%" PRIxPTR ")",
             start_addr, injector_entry);
    }

    // Remotely call our entry(start_addr, block_size, path) function
    LOGI("calling the injector's entry function to initialize OnyxZygisk");
    std::vector<long> entry_args;
    entry_args.push_back((uintptr_t) start_addr);
    entry_args.push_back(block_size);
    auto remote_tmp_path = push_string(pid, regs, zygiskd::GetTmpPath().c_str());
    entry_args.push_back((long) remote_tmp_path);
    entry_args.push_back(custom_loaded);
    bool entry_succeeded = false;
    remote_call(pid, regs, injector_entry, (uintptr_t) libc_return_addr, entry_args,
                &entry_succeeded);
    if (!entry_succeeded) {
        return abort_injection("libzygisk entry function failed before initialization completed");
    }

    // --- Step 5: Restore State ---
    // `backup.REG_IP` was already set back to the original entry address above.
    LOGI("injection complete, restoring registers before resuming normal execution");
    if (!set_regs(pid, backup)) {
        LOGE("failed to restore original registers for PID %d", pid);
        return false;
    }

    return true;
}

// Macro helper to check for specific ptrace stop events.
#define STOPPED_WITH(sig, event)                                                                   \
    (WIFSTOPPED(status) && WSTOPSIG(status) == (sig) && (status >> 16) == (event))

// Common wait routine to avoid repetition.
// Returns false if wait failed or process died unexpectedly.
static bool wait_for_process(int pid, int *status) {
    if (waitpid(pid, status, __WALL) < 0) {
        PLOGE("waitpid on PID %d", pid);
        return false;
    }
    return true;
}

/**
 * @brief Injects the Zygisk library into the main thread.
 *
 * Shared logic between Seize and Attach methods.
 */
static bool perform_injection(int pid) {
    std::string lib_path = zygiskd::GetTmpPath();
    lib_path += "/lib" LP_SELECT("", "64") "/libzygisk.so";

    if (!inject_on_main(pid, lib_path.c_str())) {
        LOGE("failed to inject library into zygote (PID: %d)", pid);
        return false;
    }
    return true;
}

/**
 * @brief Executes the GKI 2.0 Workaround and detaches.
 *
 * Advances the process by one syscall to clear internal kernel ptrace state
 * before finally detaching.
 */
static bool detach_with_gki_workaround(int pid, int detach_signal) {
    int status;
    LOGV("applying GKI 2.0 workaround (step syscall) before detach");

    // 1. Advance to next syscall entry/exit to clear signal-stop state
    if (ptrace(PTRACE_SYSCALL, pid, 0, 0) == -1) {
        PLOGE("ptrace(PTRACE_SYSCALL) on PID %d", pid);
        ptrace(PTRACE_DETACH, pid, 0, detach_signal);  // Try to detach anyway
        return false;
    }

    // 2. Wait for the syscall stop
    if (!wait_for_process(pid, &status)) {
        // If wait fails, force detach
        ptrace(PTRACE_DETACH, pid, 0, detach_signal);
        return false;
    }

    // 3. Clean detach
    if (ptrace(PTRACE_DETACH, pid, 0, detach_signal) == -1) {
        PLOGE("ptrace(PTRACE_DETACH) on PID %d", pid);
        return false;
    }
    return true;
}

// --- Strategy 1: PTRACE_SEIZE (Preferred) ---

static bool trace_with_seize(int pid, bool *seize_syscall_failed) {
    LOGI("attempting trace_seize on PID %d", pid);
    *seize_syscall_failed = false;

    // PTRACE_O_EXITKILL ensures Zygote dies if we crash, preventing a zombie state.
    if (ptrace(PTRACE_SEIZE, pid, 0, PTRACE_O_EXITKILL) == -1) {
        // Only this specific failure is a real "PTRACE_SEIZE failed" -- every
        // other `return false` below happens after the seize already
        // succeeded, so errno at that point belongs to some unrelated later
        // call and must not be reported (or fallen back on) as a seize error.
        *seize_syscall_failed = true;
        return false;
    }

    int status;
// Helper macro for local flow control
#define BAIL_AND_DETACH                                                                            \
    ptrace(PTRACE_DETACH, pid, 0, 0);                                                              \
    return false;

    // Wait for the initial Seize stop
    if (!wait_for_process(pid, &status)) return false;

    // SEIZE usually stops with SIGSTOP + PTRACE_EVENT_STOP
    if (STOPPED_WITH(SIGSTOP, PTRACE_EVENT_STOP)) {
        // 1. Inject Payload
        if (!perform_injection(pid)) {
            BAIL_AND_DETACH
        }

        LOGV("injection complete, starting signal continuation sequence");

        // 2. Send SIGCONT to the process
        if (kill(pid, SIGCONT) == -1) {
            PLOGE("kill(SIGCONT) on PID %d", pid);
            BAIL_AND_DETACH
        }

        // 3. Resume (PTRACE_CONT)
        if (ptrace(PTRACE_CONT, pid, 0, 0) == -1) {
            PLOGE("ptrace(PTRACE_CONT) failed");
            BAIL_AND_DETACH
        }
        if (!wait_for_process(pid, &status)) return false;

        // 4. Expect SIGTRAP (caused by the signal interruption in Seize mode)
        if (STOPPED_WITH(SIGTRAP, PTRACE_EVENT_STOP)) {
            if (ptrace(PTRACE_CONT, pid, 0, 0) == -1) {
                BAIL_AND_DETACH
            }
            if (!wait_for_process(pid, &status)) return false;

            // 5. Expect the actual SIGCONT delivery
            if (STOPPED_WITH(SIGCONT, 0)) {
                LOGV("received expected SIGCONT");
                // 6. Workaround + Detach
                return detach_with_gki_workaround(pid, SIGCONT);
            } else {
                LOGE("unexpected state after SIGTRAP: %s", parse_status(status).c_str());
                BAIL_AND_DETACH
            }
        } else {
            LOGE("expected SIGTRAP after CONT, got: %s", parse_status(status).c_str());
            BAIL_AND_DETACH
        }
    } else {
        LOGE("seize attached, but unexpected initial state: %s", parse_status(status).c_str());
        BAIL_AND_DETACH
    }

#undef BAIL_AND_DETACH
    return true;
}

// --- Strategy 2: PTRACE_ATTACH (Fallback) ---

static bool trace_with_attach(int pid) {
    LOGI("falling back to trace_attach on PID %d", pid);

    // Classic attach. This sends SIGSTOP to the process immediately.
    if (ptrace(PTRACE_ATTACH, pid, 0, 0) == -1) {
        PLOGE("ptrace(PTRACE_ATTACH) on PID %d", pid);
        return false;
    }

    int status;
    if (!wait_for_process(pid, &status)) {
        // If wait fails, we must try to detach or the process hangs forever
        ptrace(PTRACE_DETACH, pid, 0, 0);
        return false;
    }

    // Classic ATTACH results in a STOPPED status with SIGSTOP.
    // It does NOT use PTRACE_EVENT_STOP in the status bits usually.
    if (WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP) {
        // Optional: Set EXITKILL for parity with SEIZE, though not strictly required for fallback.
        ptrace(PTRACE_SETOPTIONS, pid, 0, PTRACE_O_EXITKILL);

        // 1. Inject Payload
        if (!perform_injection(pid)) {
            ptrace(PTRACE_DETACH, pid, 0, 0);
            return false;
        }

        // 2. Detach
        // For classic attach, we don't need the SIGTRAP/SIGCONT dance because
        // we haven't manually sent a SIGCONT via kill().
        // The process is simply stopped by the attach.
        // We use the GKI workaround to ensure the detach is clean.
        // We pass SIGCONT to detach to ensure the process resumes.
        return detach_with_gki_workaround(pid, SIGCONT);

    } else {
        LOGE("attach succeeded but process state unexpected: %s", parse_status(status).c_str());
        ptrace(PTRACE_DETACH, pid, 0, 0);
        return false;
    }
}

/**
 * @brief Attaches to the Zygote process and initiates the injection.
 *
 * Tries modern PTRACE_SEIZE first. If that fails with I/O error (EIO),
 * falls back to classic PTRACE_ATTACH.
 *
 * @param pid The Zygote process ID.
 * @return True on success, false on failure.
 */
bool trace_zygote(int pid) {
    LOGI("attaching to zygote (PID: %d) to begin injection", pid);

    // 1. Try SEIZE (Modern, robust handling of group stops)
    bool seize_syscall_failed = false;
    if (trace_with_seize(pid, &seize_syscall_failed)) {
        LOGI("successfully detached from zygote (via SEIZE), OnyxZygisk active");
        return true;
    }
    int seize_errno = errno;

    if (!seize_syscall_failed) {
        // The seize itself succeeded; injection failed for some other reason
        // (already logged by inject_on_main/abort_injection). Falling back to
        // PTRACE_ATTACH would just hit the identical failure again.
        return false;
    }

    // 2. Check for fallback condition
    // PTRACE_SEIZE returns EIO if the process state prohibits seizing,
    // or sometimes if security modules interfere.
    if (seize_errno == EIO) {
        LOGW("PTRACE_SEIZE failed with EIO, attempting fallback to PTRACE_ATTACH");

        if (trace_with_attach(pid)) {
            LOGI("successfully detached from zygote (via ATTACH), OnyxZygisk active");
            return true;
        }
    } else {
        // If it wasn't EIO (e.g., EPERM, ESRCH), Attach will likely fail too,
        // or the error is fatal.
        errno = seize_errno;
        PLOGE("PTRACE_SEIZE failed (errno: %d)", seize_errno);
    }

    return false;
}
