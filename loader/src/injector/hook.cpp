#include <cstring>
#include <dlfcn.h>
#include <pthread.h>
#include <sched.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
#include <unwind.h>

#include <lsplt.hpp>

#include "android_util.hpp"
#include "daemon.hpp"
#include "module.hpp"
#include "zygisk.hpp"

using namespace std;

// *********************
// Zygisk Bootstrapping
// *********************
//
// Zygisk's lifecycle is driven by several PLT function hooks in libandroid_runtime, libart, and
// libnative_bridge. As Zygote is starting up, these carefully selected functions will call into
// the respective lifecycle callbacks in Zygisk to drive the progress forward.
//
// The entire bootstrap process is shown in the graph below.
// Arrows represent control flow, and the blocks are sorted chronologically from top to bottom.
//
//       libandroid_runtime                zygisk                 libart
//
//           ┌───────┐                 ┌─────────────┐
//           │ start │                 │ remote_call │
//           └───┬───┘                 └──────┬──────┘
//               │                            │
//               │                            ▼
//               │                        ┌────────┐
//               │                        │hook_plt│
//               │                        └────────┘
//               ▼
//   ┌──────────────────────┐
//   │ strdup("ZygoteInit") │
//   └───────────┬────┬─────┘
//               │    │                ┌───────────────┐
//               │    └───────────────►│hook_zygote_jni│
//               │                     └───────────────┘       ┌─────────┐
//               │                                             │         │
//               └────────────────────────────────────────────►│   JVM   │
//                                                             │         │
//                                                             └──┬─┬────┘
//     ┌───────────────────┐                                      │ │
//     │nativeXXXSpecialize│◄─────────────────────────────────────┘ │
//     └─────────────┬─────┘                                        │
//                   │                 ┌─────────────┐              │
//                   └────────────────►│ZygiskContext│              │
//                                     └─────────────┘              ▼
//                                                       ┌─────────────────────────┐
//                                                       │pthread_attr_setstacksize│
//                                                       └──────────┬──────────────┘
//                                    ┌────────────────┐            │
//                                    │restore_plt_hook│◄───────────┘
//                                    └────────────────┘
//
// Some notes regarding the important functions/symbols during bootstrap:
//
// * HookContext::hook_plt(): hook functions like |unshare| and |strdup|
// * strdup: called in AndroidRuntime::start before calling ZygoteInit#main(...)
// * HookContext::hook_zygote_jni(): replace the process specialization functions registered
//   with register_jni_procs. This marks the final step of the code injection bootstrap process.
// * pthread_attr_setstacksize: called whenever the JVM tries to setup threads for itself. We use
//   this method to cleanup and unmap Zygisk from the process.

constexpr const char *kZygoteInit = "com.android.internal.os.ZygoteInit";
constexpr const char *kZygote = "com/android/internal/os/Zygote";

// Global contexts:
//
// HookContext lives as long as Zygisk is loaded in memory. It tracks the process's function
// hooking state and bootstraps code injection until we replace the process specialization methods.
//
// ZygiskContext lives during the process specialization process. It implements Zygisk
// features, such as loading modules and customizing process fork/specialization.

ZygiskContext *g_ctx;
HookContext *g_hook;

// -----------------------------------------------------------------

#define DCL_HOOK_FUNC(ret, func, ...)                                                              \
    ret (*old_##func)(__VA_ARGS__);                                                                \
    ret new_##func(__VA_ARGS__)

DCL_HOOK_FUNC(static char *, strdup, const char *str) {
    if (strcmp(kZygoteInit, str) == 0) {
        g_hook->hook_zygote_jni();
        g_hook->cached_map_infos = lsplt::MapInfo::Scan();
    }
    return old_strdup(str);
}

DCL_HOOK_FUNC(int, fork) { return (g_ctx && g_ctx->pid >= 0) ? g_ctx->pid : old_fork(); }

// Hide the TracerPid line from any libc-based read() of
// /proc/<pid>/status, and strip Zygisk-related pathnames from any
// libc-based read() of /proc/<pid>/maps.  After the injector's
// PTRACE_SEIZE/Detach cycle the kernel may still report a non-zero
// TracerPid on some GKI 2.0 kernels (see detach_with_gki_workaround in
// ptracer.cpp), and module loading leaves `jit-cache-zygisk` / `memfd:`
// / `zygisk-module` backing-file names in /proc/<pid>/maps.  Detection
// apps read both files to flag Zygote as being traced / injected.  We
// rewrite the offending fields in-place so the caller never sees them.
DCL_HOOK_FUNC(ssize_t, read, int fd, void *buf, size_t count) {
    ssize_t ret = old_read(fd, buf, count);
    if (ret > 0) {
        char *b = static_cast<char *>(buf);
        size_t n = static_cast<size_t>(ret);
        sanitize_tracer_pid_in_buffer(b, n);
        sanitize_maps_in_buffer(b, n);
    }
    return ret;
}

// Set up the app's private mount namespace according to the selected mount
// mode (see module.hpp / zygiskd's ProcessFlags):
//   • global        — every app keeps module mounts; do nothing here.
//   • namespace swap — denylisted apps setns into the cached clean namespace;
//                      trusted apps inherit the (never-unmounted) zygote.
//   • revert only    — modules were unmounted from zygote already, so trusted
//                      apps setns back into Root to regain them; denylisted
//                      apps simply inherit the clean zygote (no setns).
DCL_HOOK_FUNC(static int, unshare, int flags) {
    if (g_ctx && (flags & CLONE_NEWNS) && !(g_ctx->flags & SERVER_FORK_AND_SPECIALIZE) &&
        !(g_ctx->info_flags & MOUNT_MODE_GLOBAL)) {
        bool should_unmount = !(g_ctx->info_flags & (PROCESS_IS_MANAGER | PROCESS_GRANTED_ROOT)) &&
                              g_ctx->flags & DO_REVERT_UNMOUNT;

        if (g_ctx->info_flags & MOUNT_MODE_SETNS) {
            // Zygote was never unmounted in this mode: only denylisted apps
            // need switching, into the cached clean namespace.
            if (should_unmount) {
                ZygiskContext::update_mount_namespace(zygiskd::MountNamespace::Clean);
            }
        } else {
            // Revert-only: zygote had its module mounts stripped.
            if (!should_unmount && g_hook->zygote_unmounted) {
                ZygiskContext::update_mount_namespace(zygiskd::MountNamespace::Root);
            }
            // Denylisted apps rely on inheriting the clean zygote; no setns
            // fallback (that is what makes this "revert only").
        }
    }

    int res = old_unshare(flags);
    errno = 0;  // Restore errno back to 0
    return res;
}

DCL_HOOK_FUNC(int, property_get, const char *key, char *value, const char *default_value) {
    if (!g_hook->skip_hooking_unloader) {
        g_hook->hook_unloader();
        g_hook->skip_hooking_unloader = true;
        for (auto it = g_hook->plt_backup.rbegin(); it != g_hook->plt_backup.rend(); ++it) {
            const auto &[dev, inode, sym, old_func] = *it;
            if (*old_func == old_property_get) {
                if (!lsplt::RegisterHook(dev, inode, sym, *old_func, nullptr) ||
                    !lsplt::CommitHook(g_hook->cached_map_infos, true)) {
                    PLOGE("unhook property_get");
                } else {
                    // A reverse_iterator must be converted to a forward iterator.
                    // The `base()` of the *next* iterator gives the correct position.
                    g_hook->plt_backup.erase(std::next(it).base());
                }
                break;
            }
        }
    }
    return old_property_get(key, value, default_value);
}

using ReopenOrDetachFn = void (*)(const void *, void *);
static ReopenOrDetachFn old_reopen_or_detach = nullptr;

// Opaque mirror of Android's internal FileDescriptorInfo. This is deliberately
// best-effort because the type is not part of the stable NDK ABI.
struct FileDescriptorInfoLayout {
    int fd;
    struct stat stat;
#if defined(__LP64__)
    unsigned char path_storage[24];
#else
    unsigned char path_storage[12];
#endif
    int open_flags;
    int fd_flags;
    int fs_flags;
    off_t offset;
    bool is_sock;
};

static bool read_file_descriptor_info(const void *object, int &fd, const char *&path,
                                     bool &is_sock) {
    if (object == nullptr) return false;

    const auto &info = *reinterpret_cast<const FileDescriptorInfoLayout *>(object);
    fd = info.fd;
    is_sock = info.is_sock;
    const auto *bytes = info.path_storage;
    if ((bytes[0] & 1u) == 0) {
        const size_t length = bytes[0] >> 1;
        if (length >= sizeof(info.path_storage)) return false;
        path = reinterpret_cast<const char *>(bytes + 1);
    } else {
#if defined(__LP64__)
        constexpr size_t data_offset = 16;
#else
        constexpr size_t data_offset = 8;
#endif
        std::memcpy(&path, bytes + data_offset, sizeof(path));
        if (path == nullptr) return false;
    }
    return fd >= 0 && path != nullptr;
}

static void new_reopen_or_detach(const void *object, void *fail_fn) {
    if (old_reopen_or_detach == nullptr) return;

    int fd = -1;
    const char *path = nullptr;
    bool is_sock = false;
    if (!read_file_descriptor_info(object, fd, path, is_sock)) {
        old_reopen_or_detach(object, fail_fn);
        return;
    }

    constexpr std::string_view boot_image = "/memfd:/boot-image-methods.art";
    if (is_sock || std::string_view(path).starts_with(boot_image) || access(path, F_OK) == 0) {
        old_reopen_or_detach(object, fail_fn);
        return;
    }

    // A root-module overlay may have disappeared after zygote opened the FD.
    // Detach that stale descriptor instead of invoking the framework abort path.
    LOGV("detaching unavailable zygote file descriptor %d (%s)", fd, path);
    close(fd);
}

// We cannot directly call `munmap` to unload ourselves, otherwise when `munmap` returns,
// it will return to our code which has been unmapped, causing segmentation fault.
// Instead, we hook `pthread_attr_setstacksize` which will be called when VM daemon threads start.
DCL_HOOK_FUNC(static int, pthread_attr_setstacksize, void *target, size_t size) {
    int res = old_pthread_attr_setstacksize((pthread_attr_t *) target, size);

    if (g_hook->should_unmap && gettid() == getpid()) {
        // Only perform unloading on the main thread

        g_hook->restore_plt_hook();
        if (g_hook->should_unmap) {
            void *start_addr = g_hook->start_addr;
            size_t block_size = g_hook->block_size;

            if (g_hook->should_spoof_maps) {
                spoof_virtual_maps("zygisk-module", true);
            }

            delete g_hook;
            // Because both `pthread_attr_setstacksize` and `munmap` have the same function
            // signature, we can use `musttail` to let the compiler reuse our stack frame and thus
            // `munmap` will directly return to the caller of `pthread_attr_setstacksize`.
            LOGV("unmap libzygisk.so loaded at %p with size %zu", start_addr, block_size);
            [[clang::musttail]] return munmap(start_addr, block_size);
        }
        delete g_hook;
    }

    return res;
}

#undef DCL_HOOK_FUNC

// -----------------------------------------------------------------
static size_t get_fd_max() {
    rlimit r{32768, 32768};
    getrlimit(RLIMIT_NOFILE, &r);
    return r.rlim_max;
}

ZygiskContext::ZygiskContext(JNIEnv *env, void *args)
    : env(env),
      args{args},
      process(nullptr),
      pid(-1),
      flags(0),
      info_flags(0),
      allowed_fds(get_fd_max()),
      hook_info_lock(PTHREAD_MUTEX_INITIALIZER) {
    g_ctx = this;
}

ZygiskContext::~ZygiskContext() {
    // This global pointer points to a variable on the stack.
    // Set this to nullptr to prevent leaking local variable.
    // This also disables most plt hooked functions.
    g_ctx = nullptr;

    if (!is_child()) return;

    // Strip out all API function pointers
    for (auto &m : modules) {
        m.clearApi();
    }

    // Cleanup
    g_hook->should_unmap = true;
    g_hook->restore_zygote_hook(env);
}

// -----------------------------------------------------------------

HookContext::HookContext(void *start_addr, size_t block_size)
    : start_addr{start_addr}, block_size{block_size} {};

// -----------------------------------------------------------------

inline void *unwind_get_region_start(_Unwind_Context *ctx) {
    auto fp = _Unwind_GetRegionStart(ctx);
#if defined(__arm__)
    // On arm32, we need to check if the pc is in thumb mode,
    // if so, we need to set the lowest bit of fp to 1
    auto pc = _Unwind_GetGR(ctx, 15);  // r15 is pc
    if (pc & 1) {
        // Thumb mode
        fp |= 1;
    }
#endif
    return reinterpret_cast<void *>(fp);
}

// -----------------------------------------------------------------

void HookContext::register_hook(dev_t dev, ino_t inode, const char *symbol, void *new_func,
                                void **old_func) {
    if (!lsplt::RegisterHook(dev, inode, symbol, new_func, old_func)) {
        LOGE("failed to register plt_hook \"%s\"\n", symbol);
        return;
    }
    plt_backup.emplace_back(dev, inode, symbol, old_func);
}

#define PLT_HOOK_REGISTER_SYM(DEV, INODE, SYM, NAME)                                               \
    register_hook(DEV, INODE, SYM, reinterpret_cast<void *>(new_##NAME),                           \
                  reinterpret_cast<void **>(&old_##NAME))

#define PLT_HOOK_REGISTER(DEV, INODE, NAME) PLT_HOOK_REGISTER_SYM(DEV, INODE, #NAME, NAME)

void HookContext::hook_plt() {
    ino_t android_runtime_inode = 0;
    dev_t android_runtime_dev = 0;
    ino_t libc_inode = 0;
    dev_t libc_dev = 0;

    cached_map_infos = lsplt::MapInfo::Scan();
    for (auto &map : cached_map_infos) {
        if (map.path.ends_with("/libandroid_runtime.so")) {
            android_runtime_inode = map.inode;
            android_runtime_dev = map.dev;
        } else if (map.path.ends_with("/libc.so") && libc_inode == 0) {
            libc_inode = map.inode;
            libc_dev = map.dev;
        }
    }

    PLT_HOOK_REGISTER(android_runtime_dev, android_runtime_inode, fork);
    PLT_HOOK_REGISTER(android_runtime_dev, android_runtime_inode, unshare);
    PLT_HOOK_REGISTER(android_runtime_dev, android_runtime_inode, strdup);
    PLT_HOOK_REGISTER(android_runtime_dev, android_runtime_inode, property_get);
    if (android_runtime_dev != 0 && android_runtime_inode != 0) {
        register_hook(android_runtime_dev, android_runtime_inode,
                      "_ZNK18FileDescriptorInfo14ReopenOrDetach",
                      reinterpret_cast<void *>(new_reopen_or_detach),
                      reinterpret_cast<void **>(&old_reopen_or_detach));
    }
    // Hook read() in libc.so so any library that reads /proc/<pid>/status
    // (including detection apps using libc directly) gets a sanitized
    // TracerPid line.  See sanitize_tracer_pid_in_buffer.
    PLT_HOOK_REGISTER(libc_dev, libc_inode, read);

    if (!lsplt::CommitHook(cached_map_infos)) LOGE("HookContext::hook_plt failed");

    // Remove unhooked methods
    plt_backup.erase(std::remove_if(plt_backup.begin(), plt_backup.end(),
                                    [](auto &t) { return *std::get<3>(t) == nullptr; }),
                     plt_backup.end());
}

void HookContext::hook_unloader() {
    ino_t art_inode = 0;
    dev_t art_dev = 0;

    cached_map_infos = lsplt::MapInfo::Scan();
    for (auto &map : cached_map_infos) {
        if (map.path.ends_with("/libart.so")) {
            art_inode = map.inode;
            art_dev = map.dev;
            break;
        }
    }

    PLT_HOOK_REGISTER(art_dev, art_inode, pthread_attr_setstacksize);
    if (!lsplt::CommitHook(cached_map_infos)) {
        LOGE("HookContext::hook_unloader failed");
    }
}

void HookContext::restore_plt_hook() {
    // Unhook plt_hook
    for (const auto &[dev, inode, sym, old_func] : plt_backup) {
        if (!lsplt::RegisterHook(dev, inode, sym, *old_func, nullptr)) {
            LOGE("failed to register plt_hook [%s]", sym);
            should_unmap = false;
        }
    }
    if (!lsplt::CommitHook(cached_map_infos, true)) {
        LOGE("failed to restore plt_hook");
        should_unmap = false;
    }
}

// -----------------------------------------------------------------

void HookContext::hook_jni_methods(JNIEnv *env, const char *clz, JNIMethods methods) {
    auto clazz = env->FindClass(clz);
    if (clazz == nullptr) {
        env->ExceptionClear();
        for (auto &method : methods) {
            method.fnPtr = nullptr;
        }
        return;
    }

    vector<JNINativeMethod> hooks;
    for (auto &native_method : methods) {
        // It's useful to allow nullptr function pointer for restoring hook
        if (!native_method.fnPtr) continue;

        auto method_id = env->GetMethodID(clazz, native_method.name, native_method.signature);
        bool is_static = false;
        if (method_id == nullptr) {
            env->ExceptionClear();
            method_id = env->GetStaticMethodID(clazz, native_method.name, native_method.signature);
            is_static = true;
        }
        if (method_id == nullptr) {
            env->ExceptionClear();
            native_method.fnPtr = nullptr;
            continue;
        }
        auto method = util::jni::ToReflectedMethod(env, clazz, method_id, is_static);
        auto modifier = util::jni::CallIntMethod(env, method, member_getModifiers);
        if ((modifier & MODIFIER_NATIVE) == 0) {
            native_method.fnPtr = nullptr;
            continue;
        }
        auto artMethod = util::art::ArtMethod::FromReflectedMethod(env, method);
        hooks.push_back(native_method);
        auto original_method = artMethod->GetData();
        LOGV("replaced %s!%s @%p", clz, native_method.name, original_method);
        native_method.fnPtr = original_method;
    }

    if (hooks.empty()) return;
    env->RegisterNatives(clazz, hooks.data(), hooks.size());
}

void HookContext::hook_zygote_jni() {
    auto get_created_java_vms = reinterpret_cast<jint (*)(JavaVM **, jsize, jsize *)>(
        dlsym(RTLD_DEFAULT, "JNI_GetCreatedJavaVMs"));
    if (!get_created_java_vms) {
        for (auto &map : cached_map_infos) {
            if (!map.path.ends_with("/libnativehelper.so")) continue;
            void *h = dlopen(map.path.data(), RTLD_LAZY);
            if (!h) {
                LOGW("cannot dlopen libnativehelper.so: %s", dlerror());
                break;
            }
            get_created_java_vms =
                reinterpret_cast<decltype(get_created_java_vms)>(dlsym(h, "JNI_GetCreatedJavaVMs"));
            dlclose(h);
            break;
        }
        if (!get_created_java_vms) {
            LOGW("JNI_GetCreatedJavaVMs not found");
            return;
        }
    }
    JavaVM *vm = nullptr;
    jsize num = 0;
    jint res = get_created_java_vms(&vm, 1, &num);
    if (res != JNI_OK || vm == nullptr) return;
    JNIEnv *env = nullptr;
    res = vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
    if (res != JNI_OK || env == nullptr) return;

    auto classMember = util::jni::FindClass(env, "java/lang/reflect/Member");
    if (classMember != nullptr)
        member_getModifiers = util::jni::GetMethodID(env, classMember, "getModifiers", "()I");
    auto classModifier = util::jni::FindClass(env, "java/lang/reflect/Modifier");
    if (classModifier != nullptr) {
        auto fieldId = util::jni::GetStaticFieldID(env, classModifier, "NATIVE", "I");
        if (fieldId != nullptr)
            MODIFIER_NATIVE = util::jni::GetStaticIntField(env, classModifier, fieldId);
    }
    if (member_getModifiers == nullptr || MODIFIER_NATIVE == 0) return;
    if (!util::art::ArtMethod::Init(env)) {
        LOGE("failed to init ArtMethod");
        return;
    }
    hook_jni_methods(env, kZygote, zygote_methods);

    // Each Zygote entrypoint has several version variants in the table and only one
    // resolves per device. If none of a method's variants resolves (e.g. a new OS
    // changed its native signature), that entrypoint is left unhooked and injection
    // silently breaks for the affected process class. Fail loudly instead.
    for (const char *name :
         {"nativeForkAndSpecialize", "nativeSpecializeAppProcess", "nativeForkSystemServer"}) {
        bool hooked = false;
        for (const auto &method : zygote_methods) {
            if (method.fnPtr != nullptr && strcmp(method.name, name) == 0) {
                hooked = true;
                break;
            }
        }
        if (!hooked)
            LOGE("no matching signature for %s; injection will not work on this build", name);
    }
}

void HookContext::restore_zygote_hook(JNIEnv *env) {
    hook_jni_methods(env, kZygote, zygote_methods);
}

// -----------------------------------------------------------------

void hook_entry(void *start_addr, size_t block_size, bool custom_loaded) {
    g_hook = new HookContext(start_addr, block_size);
    g_hook->hook_plt();
    // A custom-mapped image never entered bionic's solist. Trying to remove it
    // would corrupt the linker's load counters and can dereference a record
    // that does not exist. Path-based dlopen still needs the original cleanup.
    if (!custom_loaded) {
        clean_linker_trace(zygiskd::GetTmpPath().data(), 1, 0, true);
    }
}

void hookJniNativeMethods(JNIEnv *env, const char *clz, JNINativeMethod *methods, int numMethods) {
    g_hook->hook_jni_methods(env, clz, {methods, (size_t) numMethods});
}
