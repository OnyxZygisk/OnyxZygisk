#include "zygote_abi.hpp"

#include <sys/wait.h>
#include <unistd.h>

#include <csignal>

#include "daemon.hpp"
#include "logging.hpp"
#include "monitor.hpp"
#include "utils.hpp"

ZygoteAbiManager::ZygoteAbiManager(AppMonitor& monitor, bool is_64bit)
    : abi_name_(is_64bit ? "64" : "32"),
      program_path_(is_64bit ? "/system/bin/app_process64" : "/system/bin/app_process32"),
      tracer_path_(is_64bit ? "./bin/zygisk-ptrace64" : "./bin/zygisk-ptrace32"),
      monitor_(monitor) {}

const Status& ZygoteAbiManager::get_status() const { return status_; }

void ZygoteAbiManager::notify_injected() {
    status_.zygote_injected = true;
    // A successful injection is proof that the *previous* zygote generation
    // was healthy. Reset the crash-loop counter so a later, genuinely faulty
    // zygote starts counting from 1 instead of inheriting the accumulated
    // count from normal fork activity (app crashes, system_server restarts,
    // hot-plug restarts, etc.) — which previously pushed the count past the
    // threshold and made `is_in_crash_loop` stop monitoring a perfectly
    // healthy device.
    counter.count = 0;
    counter.last_start_time = {.tv_sec = 0, .tv_nsec = 0};
}

void ZygoteAbiManager::set_daemon_info(std::string_view info) { status_.daemon_info = info; }

void ZygoteAbiManager::set_daemon_crashed(std::string_view error) {
    status_.daemon_running = false;
    status_.daemon_error_info = error;
}

bool ZygoteAbiManager::is_in_crash_loop() {
    struct timespec now{};
    clock_gettime(CLOCK_MONOTONIC, &now);

    // Only count when the *previous* zygote generation had been injected
    // but the new one is starting anyway — i.e. the previous zygote died.
    // init normally only re-forks app_process after a zygote crash or a
    // deliberate system_server restart (hot-plug). The injection-success
    // flag is the precise signal: if it was set, the prior zygote reached
    // a running state, so this new fork is either a crash restart or an
    // intentional restart. If it was *not* set, the prior attempt did not
    // even complete injection, and we already counted that failure on the
    // previous call — do not double-count the same non-start here.
    bool previous_was_running = status_.zygote_injected;
    // ensure_daemon_created() below clears zygote_injected for the new
    // generation; capture the value before that happens.
    bool count_this_time = previous_was_running;

    if (count_this_time) {
        if (now.tv_sec - counter.last_start_time.tv_sec <
            ZygoteAbiManager::CRASH_LOOP_WINDOW_SECONDS) {
            counter.count++;
        } else {
            counter.count = 1;
        }
        counter.last_start_time = now;
    }

    if (counter.count >= ZygoteAbiManager::CRASH_LOOP_RETRY_COUNT) {
        LOGE("detected zygote crash loop: %d restarts within %d seconds",
             counter.count, ZygoteAbiManager::CRASH_LOOP_WINDOW_SECONDS);
        return true;
    }
    return false;
}

bool ZygoteAbiManager::ensure_daemon_created() {
    // Only clear the injection flag when starting a brand-new zygote
    // generation (i.e. first time, or after the daemon died and is being
    // re-created). Clearing it unconditionally on every call previously
    // destroyed the `is_in_crash_loop` signal: a successful injection set
    // the flag, then the next `check_and_prepare_injection` call cleared
    // it before `is_in_crash_loop` could see it, so the crash counter
    // never incremented even during a real crash loop.
    if (status_.daemon_pid == -1) {
        status_.zygote_injected = false;
        auto pid = fork();
        if (pid < 0) {
            PLOGE("create daemon (abi=%s)", abi_name_);
            return false;
        }
        if (pid == 0) {
            std::string daemon_name = "./bin/zygiskd";
            daemon_name += abi_name_;
            execl(
                daemon_name.c_str(),
                daemon_name.c_str(),
                "--workdir",
                zygiskd::GetTmpPath().c_str(),
                nullptr
            );
            PLOGE("exec daemon %s", daemon_name.c_str());
            exit(1);
        }
        status_.supported = true;
        status_.daemon_pid = pid;
        status_.daemon_running = true;
    }
    return status_.daemon_running;
}

const char* ZygoteAbiManager::check_and_prepare_injection() {
    if (is_in_crash_loop()) {
        monitor_.request_stop("zygote crashed");
        return nullptr;
    }
    if (!ensure_daemon_created()) {
        monitor_.request_stop("daemon not running");
        return nullptr;
    }
    return tracer_path_;
}

bool ZygoteAbiManager::handle_daemon_exit_if_match(int pid, int process_status) {
    if (status_.supported && pid == status_.daemon_pid) {
        auto status_str = parse_status(process_status);
        LOGW("ZygoteAbiManager: daemon%s (pid %d) exited: %s", abi_name_, pid, status_str.c_str());
        status_.daemon_running = false;
        // Reset daemon_pid so a future ensure_daemon_created() can fork a
        // replacement instead of treating the dead PID as still alive.
        status_.daemon_pid = -1;
        if (status_.daemon_error_info.empty()) {
            status_.daemon_error_info = status_str;
        }
        monitor_.update_status();
        return true;
    }
    return false;
}
