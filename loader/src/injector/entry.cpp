#include <dlfcn.h>

#include "daemon.hpp"
#include "logging.hpp"
#include "ptrace_clear.hpp"
#include "zygisk.hpp"

using namespace std;

extern "C" [[gnu::visibility("default")]]
void entry(void* addr, size_t size, const char* path, bool custom_loaded) {
    LOGI("zygisk library injected, version %s", ZKSU_VERSION);

    zygiskd::Init(path);

    if (!zygiskd::PingHeartbeat()) {
        LOGE("zygisk daemon is not running");
        return;
    }

    hook_entry(addr, size, custom_loaded);

    // Kernel-level TracerPid cleanup: install a one-shot seccomp BPF filter
    // that triggers PTRACE_EVENT_SECCOMP, which the kernel consumes silently
    // (no tracer attached) and in doing so clears any lingering ptrace state
    // the injector left behind.  On kernels >= 5.10 this is a no-op (the
    // filter itself would be visible), and the PLT-hook read() sanitization
    // remains the primary defense.  See ptrace_clear.cpp.
    perform_ptrace_message_clear();

    send_seccomp_event_if_needed();
}

/**
 * @brief Intercepts calls to __cxa_atexit to prevent registration of exit handlers.
 *
 * This function serves as a local replacement for the __cxa_atexit provided by libc.
 * By providing our own version, the dynamic linker resolves any calls from within our
 * injector library (and its static dependencies) to this function instead of the real one.
 *
 * @param func The function pointer (destructor) to be registered.
 * @param arg  A pointer to the argument for the function (the 'this' pointer for an object).
 * @param dso  A handle to the shared object that is registering the handler.
 * @return int Always returns 0 to indicate success, tricking the caller into thinking
 *             the handler was registered while we have actually blocked it.
 */
extern "C" int __cxa_atexit(void (*func)(void*), void* arg, void* dso) {
    // Dl_info will be filled with information about the library
    // containing the function pointer 'func'.
    Dl_info info;

    // Use dladdr() to resolve the function pointer to a library and symbol.
    if (dladdr(reinterpret_cast<const void*>(func), &info)) {
        // Successfully resolved the address.
        const char* library_path = info.dli_fname ? info.dli_fname : "<unknown library>";
        const char* symbol_name = info.dli_sname ? info.dli_sname : "<unknown symbol>";

        LOGV("atexit registration BLOCKED [func, lib, sym, obj, dso]: [%p, %s, %s, %p, %p]", func,
             library_path, symbol_name, arg, dso);

    } else {
        // dladdr() failed. We can still log the raw pointer.
        LOGV("atexit registration BLOCKED for function at %p without library information).", func);
    }

    return 0;
}
