// ptrace_clear.cpp — kernel-level TracerPid cleanup via seccomp BPF.
//
// After the ptrace injector (PTRACE_SEIZE + inject + PTRACE_DETACH) finishes,
// the kernel may still expose a non-zero TracerPid in /proc/self/status on
// some kernels (notably GKI 2.0, where the internal ptrace stop state is not
// fully cleared by PTRACE_DETACH alone — see detach_with_gki_workaround in
// ptracer.cpp for the injector-side half of this fix).
//
// This file implements the injected-side half: it installs a one-shot seccomp
// BPF filter that matches a randomly-keyed exit_group() syscall and returns
// SECCOMP_RET_TRACE.  Because no tracer is attached anymore, the resulting
// ptrace-stop is consumed silently by the kernel, which has the side effect
// of clearing the lingering tracer state — so TracerPid genuinely returns to
// 0 in the kernel, not just in what read() reports.
//
// On kernels >= 5.10 where Seccomp_filters: is visible in /proc/self/status,
// installing a filter would itself be a detection signal, so the function
// becomes a no-op there and the PLT-hook read() sanitization
// (sanitize_tracer_pid_in_buffer) remains the primary defense.
//
// Adapted from PerformanC/ReZygisk (GPL-3.0 → AGPL-3.0 per §13).

#include "ptrace_clear.hpp"

#include <cstdint>
#include <cstdio>
#include <cstring>

#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "logging.hpp"

// Returns true if /proc/self/status exposes a "Seccomp_filters:" line, which
// means the kernel is new enough (>= 5.10) that installing a seccomp filter
// is itself detectable — so we must not use that approach there.
static bool seccomp_filters_visible() {
    FILE *status_file = fopen("/proc/self/status", "r");
    if (!status_file) {
        PLOGE("open /proc/self/status");
        return true;  // assume visible — safer to skip the filter
    }

    char line[256];
    while (fgets(line, sizeof(line), status_file)) {
        if (strncmp(line, "Seccomp_filters:", 16) == 0) {
            fclose(status_file);
            return true;
        }
    }

    fclose(status_file);
    return false;
}

void perform_ptrace_message_clear() {
    // Since kernel 5.10, Seccomp filters are visible in /proc/self/status,
    // making this hiding technique itself a detection signal — skip it.
    if (seccomp_filters_visible()) {
        LOGD("ptrace_clear: Seccomp filters are visible, skipping seccomp-based cleanup");
        return;
    }

    // Generate 4 random 32-bit arguments that the BPF filter will match on.
    // Randomness ensures only our own exit_group call triggers the TRACE,
    // not any other exit_group in the process.
    int rnd_fd = open("/dev/urandom", O_RDONLY);
    if (rnd_fd == -1) {
        PLOGE("ptrace_clear: open /dev/urandom");
        return;
    }

    uint32_t args[4] = {0};
    if (read(rnd_fd, &args, sizeof(args)) != sizeof(args)) {
        PLOGE("ptrace_clear: read /dev/urandom");
        close(rnd_fd);
        return;
    }

    close(rnd_fd);

    // Set a flag bit so the magic value is never a plausible exit code.
    args[0] |= 0x10000;

    struct sock_filter filter[] = {
        // Load syscall number.
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        // If not exit_group, allow.
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit_group, 0, 9),

        // Load and check arg0 (lower 32 bits).
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, args[0], 0, 7),

        // Load and check arg1 (lower 32 bits).
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, args[1], 0, 5),

        // Load and check arg2 (lower 32 bits).
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, args[2], 0, 3),

        // Load and check arg3 (lower 32 bits).
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[3])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, args[3], 0, 1),

        // All match: return TRACE => triggers PTRACE_EVENT_SECCOMP.
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE),

        // Default: allow.
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };

    struct sock_fprog prog = {
        .len = static_cast<unsigned short>(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) {
        PLOGE("ptrace_clear: prctl(SECCOMP)");
        return;
    }

    // This syscall matches the filter, returns SECCOMP_RET_TRACE, and triggers
    // a ptrace event.  Because no tracer is attached, the kernel consumes the
    // stop silently — clearing the lingering tracer state.  The syscall itself
    // does NOT execute (the kernel skips it after the TRACE return with no
    // tracer), so the process stays alive.
    syscall(__NR_exit_group, args[0], args[1], args[2], args[3]);

    LOGD("ptrace_clear: seccomp-based TracerPid cleanup done");
}
