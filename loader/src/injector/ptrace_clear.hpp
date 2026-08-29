#pragma once

/// perform_ptrace_message_clear — install a one-shot seccomp BPF filter that
/// matches a randomly-keyed exit_group() syscall and returns SECCOMP_RET_TRACE,
/// which consumes the pending PTRACE_EVENT_SECCOMP the injector left on us.
///
/// After the ptrace injector detaches, the kernel may still report a non-zero
/// TracerPid in /proc/self/status on some kernels (notably GKI 2.0).  The
/// SECCOMP_RET_TRACE return triggers a ptrace-stop that, because no tracer is
/// attached anymore, is consumed silently by the kernel — which has the side
/// effect of clearing the lingering tracer state.
///
/// On kernels >= 5.10 where Seccomp_filters: is visible in /proc/self/status,
/// installing a filter would itself be detectable, so the function is a no-op
/// there and the PLT-hook read() sanitization (see sanitize_tracer_pid_in_buffer)
/// remains the primary defense.
///
/// Adapted from PerformanC/ReZygisk (GPL-3.0 → AGPL-3.0 per §13).
void perform_ptrace_message_clear();
