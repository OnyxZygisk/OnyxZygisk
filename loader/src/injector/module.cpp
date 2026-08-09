#include "module.hpp"

#include <android/dlext.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <csignal>

#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <lsplt.hpp>

#include "daemon.hpp"
#include "dl.hpp"
#include "files.hpp"
#include "logging.hpp"
#include "misc.hpp"
#include "module_loader.hpp"
#include "zygisk.hpp"

using namespace std;

ZygiskModule::ZygiskModule(int id, void *handle, void *entry, bool custom)
    : id(id), handle(handle), custom(custom), entry{entry}, api{}, mod{nullptr} {
    // Make sure all pointers are null
    memset(&api, 0, sizeof(api));
    api.base.impl = this;
    api.base.registerModule = &ZygiskModule::RegisterModuleImpl;
}

bool ZygiskModule::RegisterModuleImpl(ApiTable *api, long *module) {
    if (api == nullptr || module == nullptr) return false;

    long api_version = *module;
    // Unsupported version
    if (api_version > ZYGISK_API_VERSION) return false;

    // Set the actual module_abi*
    api->base.impl->mod = {module};

    // Fill in API accordingly with module API version
    if (api_version >= 1) {
        api->v1.hookJniNativeMethods = hookJniNativeMethods;
        api->v1.pltHookRegister = [](auto a, auto b, auto c, auto d) {
            if (g_ctx) g_ctx->plt_hook_register(a, b, c, d);
        };
        api->v1.pltHookExclude = [](auto a, auto b) {
            if (g_ctx) g_ctx->plt_hook_exclude(a, b);
        };
        api->v1.pltHookCommit = []() { return g_ctx && g_ctx->plt_hook_commit(); };
        api->v1.connectCompanion = [](ZygiskModule *m) { return m->connectCompanion(); };
        api->v1.setOption = [](ZygiskModule *m, auto opt) { m->setOption(opt); };
    }
    if (api_version >= 2) {
        api->v2.getModuleDir = [](ZygiskModule *m) { return m->getModuleDir(); };
        api->v2.getFlags = [](auto) { return ZygiskModule::getFlags(); };
    }
    if (api_version >= 4) {
        api->v4.pltHookCommit = []() { return lsplt::CommitHook(g_hook->cached_map_infos); };
        api->v4.pltHookRegister = [](dev_t dev, ino_t inode, const char *symbol, void *fn,
                                     void **backup) {
            if (dev == 0 || inode == 0 || symbol == nullptr || fn == nullptr) return;
            lsplt::RegisterHook(dev, inode, symbol, fn, backup);
        };
        api->v4.exemptFd = [](int fd) { return g_ctx && g_ctx->exempt_fd(fd); };
    }

    return true;
}

bool ZygiskModule::valid() const {
    if (mod.api_version == nullptr) return false;
    switch (*mod.api_version) {
    case 5:
    case 4:
    case 3:
    case 2:
    case 1:
        return mod.v1->impl && mod.v1->preAppSpecialize && mod.v1->postAppSpecialize &&
               mod.v1->preServerSpecialize && mod.v1->postServerSpecialize;
    default:
        return false;
    }
}

/* Zygisksu changed: Use own zygiskd */
int ZygiskModule::connectCompanion() const { return zygiskd::ConnectCompanion(id); }

/* Zygisksu changed: Use own zygiskd */
int ZygiskModule::getModuleDir() const { return zygiskd::GetModuleDir(id); }

void ZygiskModule::setOption(zygisk::Option opt) {
    if (g_ctx == nullptr) return;
    switch (opt) {
    case zygisk::FORCE_DENYLIST_UNMOUNT:
        g_ctx->flags |= DO_REVERT_UNMOUNT;
        break;
    case zygisk::DLCLOSE_MODULE_LIBRARY:
        unload = true;
        break;
    }
}

uint32_t ZygiskModule::getFlags() { return g_ctx ? (g_ctx->info_flags & ~PRIVATE_MASK) : 0; }

bool ZygiskModule::tryUnload() const { return unload && UnloadModule(handle, custom); }

// -----------------------------------------------------------------

#define call_app(method)                                                                           \
    switch (*mod.api_version) {                                                                    \
    case 1:                                                                                        \
    case 2: {                                                                                      \
        AppSpecializeArgs_v1 a(args);                                                              \
        mod.v1->method(mod.v1->impl, &a);                                                          \
        break;                                                                                     \
    }                                                                                              \
    case 3:                                                                                        \
    case 4:                                                                                        \
    case 5:                                                                                        \
        mod.v1->method(mod.v1->impl, args);                                                        \
        break;                                                                                     \
    }

void ZygiskModule::preAppSpecialize(AppSpecializeArgs_v5 *args) const { call_app(preAppSpecialize) }

void ZygiskModule::postAppSpecialize(const AppSpecializeArgs_v5 *args) const {
    call_app(postAppSpecialize)
}

void ZygiskModule::preServerSpecialize(ServerSpecializeArgs_v1 *args) const {
    mod.v1->preServerSpecialize(mod.v1->impl, args);
}

void ZygiskModule::postServerSpecialize(const ServerSpecializeArgs_v1 *args) const {
    mod.v1->postServerSpecialize(mod.v1->impl, args);
}

// -----------------------------------------------------------------

void ZygiskContext::plt_hook_register(const char *regex, const char *symbol, void *fn,
                                      void **backup) {
    if (regex == nullptr || symbol == nullptr || fn == nullptr) return;
    regex_t re;
    if (regcomp(&re, regex, REG_NOSUB) != 0) return;
    mutex_guard lock(hook_info_lock);
    register_info.emplace_back(RegisterInfo{re, symbol, fn, backup});
}

void ZygiskContext::plt_hook_exclude(const char *regex, const char *symbol) {
    if (!regex) return;
    regex_t re;
    if (regcomp(&re, regex, REG_NOSUB) != 0) return;
    mutex_guard lock(hook_info_lock);
    ignore_info.emplace_back(IgnoreInfo{re, symbol ?: ""});
}

void ZygiskContext::plt_hook_process_regex() {
    if (register_info.empty()) return;
    for (auto &map : g_hook->cached_map_infos) {
        if (map.offset != 0 || !map.is_private || !(map.perms & PROT_READ)) continue;
        for (auto &reg : register_info) {
            if (regexec(&reg.regex, map.path.data(), 0, nullptr, 0) != 0) continue;
            bool ignored = false;
            for (auto &ign : ignore_info) {
                if (regexec(&ign.regex, map.path.data(), 0, nullptr, 0) != 0) continue;
                if (ign.symbol.empty() || ign.symbol == reg.symbol) {
                    ignored = true;
                    break;
                }
            }
            if (!ignored) {
                lsplt::RegisterHook(map.dev, map.inode, reg.symbol, reg.callback, reg.backup);
            }
        }
    }
}

bool ZygiskContext::plt_hook_commit() {
    {
        mutex_guard lock(hook_info_lock);
        plt_hook_process_regex();
        register_info.clear();
        ignore_info.clear();
    }
    return lsplt::CommitHook(g_hook->cached_map_infos);
}

// -----------------------------------------------------------------

void ZygiskContext::sanitize_fds() {
    if (!is_child()) {
        return;
    }

    if (can_exempt_fd() && !exempted_fds.empty()) {
        auto update_fd_array = [&](int old_len) -> jintArray {
            jintArray array = env->NewIntArray(static_cast<int>(old_len + exempted_fds.size()));
            if (array == nullptr) return nullptr;

            env->SetIntArrayRegion(array, old_len, static_cast<int>(exempted_fds.size()),
                                   exempted_fds.data());
            for (int fd : exempted_fds) {
                if (fd >= 0 && static_cast<size_t>(fd) < allowed_fds.size()) {
                    allowed_fds[fd] = true;
                }
            }
            *args.app->fds_to_ignore = array;
            return array;
        };

        if (jintArray fdsToIgnore = *args.app->fds_to_ignore) {
            int *arr = env->GetIntArrayElements(fdsToIgnore, nullptr);
            int len = env->GetArrayLength(fdsToIgnore);
            for (int i = 0; i < len; ++i) {
                int fd = arr[i];
                if (fd >= 0 && static_cast<size_t>(fd) < allowed_fds.size()) {
                    allowed_fds[fd] = true;
                }
            }
            if (jintArray newFdList = update_fd_array(len)) {
                env->SetIntArrayRegion(newFdList, 0, len, arr);
            }
            env->ReleaseIntArrayElements(fdsToIgnore, arr, JNI_ABORT);
        } else {
            update_fd_array(0);
        }
    }

    // Close all forbidden fds to prevent crashing
    auto dir = open_dir("/proc/self/fd");
    int dfd = dirfd(dir.get());
    for (dirent *entry; (entry = readdir(dir.get()));) {
        int fd = parse_int(entry->d_name);
        if ((fd < 0 || static_cast<size_t>(fd) >= allowed_fds.size() || !allowed_fds[fd]) &&
            fd != dfd) {
            close(fd);
        }
    }
}

bool ZygiskContext::exempt_fd(int fd) {
    if ((flags & POST_SPECIALIZE) || (flags & SKIP_CLOSE_LOG_PIPE)) return true;
    if (!can_exempt_fd()) return false;
    exempted_fds.push_back(fd);
    LOGV("exempt fd %d", fd);
    return true;
}

bool ZygiskContext::can_exempt_fd() const {
    return (flags & APP_FORK_AND_SPECIALIZE) && args.app->fds_to_ignore;
}

static int sigmask(int how, int signum) {
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, signum);
    return sigprocmask(how, &set, nullptr);
}

void ZygiskContext::fork_pre() {
    // Do our own fork before loading any 3rd party code
    // First block SIGCHLD, unblock after original fork is done
    sigmask(SIG_BLOCK, SIGCHLD);
    pid = old_fork();

    if (!is_child()) return;

    // Record all open fds
    auto dir = xopen_dir("/proc/self/fd");
    for (dirent *entry; (entry = readdir(dir.get()));) {
        int fd = parse_int(entry->d_name);
        if (fd < 0 || static_cast<size_t>(fd) >= allowed_fds.size()) {
            close(fd);
            continue;
        }
        allowed_fds[fd] = true;
    }
    // The dirfd will be closed once out of scope
    allowed_fds[dirfd(dir.get())] = false;
}

void ZygiskContext::fork_post() {
    // Unblock SIGCHLD in case the original method didn't
    sigmask(SIG_UNBLOCK, SIGCHLD);
}

/* Zygisksu changed: Load module fds */

/// True when the comma-separated `list` contains `needle` (whitespace-tolerant).
static bool list_contains(std::string_view list, std::string_view needle) {
    size_t start = 0;
    for (;;) {
        auto comma = list.find(',', start);
        auto token = list.substr(start, comma == std::string_view::npos ? std::string_view::npos
                                                                        : comma - start);
        while (!token.empty() && (token.front() == ' ' || token.front() == '\t')) {
            token.remove_prefix(1);
        }
        while (!token.empty() && (token.back() == ' ' || token.back() == '\t')) {
            token.remove_suffix(1);
        }
        if (token == needle) return true;
        if (comma == std::string_view::npos) return false;
        start = comma + 1;
    }
}

/// Whether the process being specialized falls inside the FN node's declared
/// scope. `scope` is 0 = all, 1 = allowlist, 2 = denylist; `process` is the
/// specialize `nice_name`, usually the package name. Processes like
/// `pkg:sub` are matched against the `pkg` prefix as well.
static bool fn_scope_matches(const zygiskd::FnModule &fn, const char *process) {
    if (fn.scope == 0 || process == nullptr || process[0] == '\0') return true;
    std::string_view proc(process);
    auto base = proc.substr(0, proc.find(':'));
    bool listed = list_contains(fn.apps, proc) || list_contains(fn.apps, base);
    return fn.scope == 1 ? listed : !listed;
}

/// Whether an FN node's `trigger` list applies to the process type being
/// specialized: `app`/`zygote` for app processes, `system_server`/`zygote`
/// for system_server. `zygote` means "at zygote level", i.e. everywhere.
static bool fn_applies(const zygiskd::FnModule &fn, bool is_server) {
    if (is_server) {
        return list_contains(fn.triggers, "system_server") || list_contains(fn.triggers, "zygote");
    }
    return list_contains(fn.triggers, "app") || list_contains(fn.triggers, "zygote");
}

void ZygiskContext::run_modules_pre() {
    auto ms = zygiskd::ReadModules();
    auto size = ms.size();
    for (size_t i = 0; i < size; i++) {
        auto &m = ms[i];
        if (LoadedModule lm = LoadModuleFromMemfd(m.memfd)) {
            modules.emplace_back(i, lm.handle, lm.entry, lm.custom);
        }
    }

    // FN (Functional Node) modules — phase 2. After the classic Zygisk modules
    // are loaded, load the entry libraries of the active FN nodes whose
    // triggers match this process type and whose scope covers the package
    // being specialized. FN indices are offset past the classic modules so
    // companion and module-dir requests resolve to the right node on the
    // daemon side (see `handle_read_fn_modules` in zygiskd).
    const bool is_server = (flags & SERVER_FORK_AND_SPECIALIZE) != 0;
    auto fns = zygiskd::ReadFnModules();
    for (size_t i = 0; i < fns.size(); i++) {
        auto &fn = fns[i];
        if (!fn_applies(fn, is_server)) continue;
        if (!is_server && !fn_scope_matches(fn, process)) continue;
        if (LoadedModule lm = LoadModuleFromMemfd(fn.memfd)) {
            LOGI("loading FN module `%s` into %s (priority %u)", fn.id.c_str(),
                 is_server ? "system_server" : process ? process : "unknown", fn.priority);
            modules.emplace_back(size + i, lm.handle, lm.entry, lm.custom);
        }
    }

    for (auto &m : modules) {
        m.onLoad(env);
        if (flags & APP_SPECIALIZE) {
            m.preAppSpecialize(args.app);
        } else if (flags & SERVER_FORK_AND_SPECIALIZE) {
            m.preServerSpecialize(args.server);
        }
    }
}

void ZygiskContext::run_modules_post() {
    flags |= POST_SPECIALIZE;

    size_t modules_unloaded = 0;
    for (const auto &m : modules) {
        if (flags & APP_SPECIALIZE) {
            m.postAppSpecialize(args.app);
        } else if (flags & SERVER_FORK_AND_SPECIALIZE) {
            m.postServerSpecialize(args.server);
        }
        if (m.tryUnload()) modules_unloaded++;
    }

    if (modules.size() > 0) {
        LOGV("modules unloaded: %zu/%zu", modules_unloaded, modules.size());
        if (modules.size() == modules_unloaded) {
            clean_libc_trace();
            // Only safe once every module this process loaded — custom or
            // system-linker — is actually gone: a still-resident
            // custom-loaded module (one that didn't ask to unload) depends on
            // the custom loader's global TLS bookkeeping for as long as it
            // keeps running.
            DeinitCustomLoaderIfUsed();
        }
        clean_linker_trace("jit-cache-zygisk", modules.size(), modules_unloaded, true);
        g_hook->should_spoof_maps =
            (flags & APP_SPECIALIZE) && (modules.size() - modules_unloaded) > 0;
    }
}

void ZygiskContext::app_specialize_pre() {
    uid_t uid = args.app->uid;
    bool is_isolated_aid = uid >= AID_ISOLATED_START && uid <= AID_ISOLATED_END;
    if (is_isolated_aid && args.app->app_data_dir) {
        const char *data_dir = nullptr;
        data_dir = env->GetStringUTFChars(args.app->app_data_dir, nullptr);
        if (data_dir != nullptr) {
            struct stat st;
            if (stat(data_dir, &st) != -1) {
                // Correct uid for isolated services
                uid = st.st_uid;
            }
            LOGV("Found isolated process [uid:%d, data_dir:%s]", uid, data_dir);
            env->ReleaseStringUTFChars(args.app->app_data_dir, data_dir);
        }
    }

    bool skip_zygiskd = false;
    if (is_isolated_aid) {
        UniqueFd fd = zygiskd::Connect(1);
        if (fd == -1) {
            skip_zygiskd = true;
        }
    }

    if (!skip_zygiskd && info_flags == 0) info_flags = zygiskd::GetProcessFlags(uid);

    if ((info_flags & UNMOUNT_MASK) == UNMOUNT_MASK) {
        LOGI("[%s] is on the denylist", process);
        flags |= DO_REVERT_UNMOUNT;
    }

    flags |= APP_SPECIALIZE;
    if (!skip_zygiskd) run_modules_pre();
}

void ZygiskContext::app_specialize_post() {
    run_modules_post();

    if ((info_flags & PROCESS_IS_MANAGER) == PROCESS_IS_MANAGER) {
        LOGI("current uid %d is manager!", args.app->uid);
        setenv("ZYGISK_ENABLED", "1", 1);
    }

    // Cleanups
    env->ReleaseStringUTFChars(args.app->nice_name, process);
}

// ── live hot-plug into the already-running system_server ──
//
// Framework modules (LSPosed) only take effect inside system_server, and the
// goal is zero reboot. The hard constraint learned the painful way: a thread
// must NOT exist inside system_server while it is being specialized — a
// process with >1 thread cannot complete selinux_android_setcontext ->
// setcon() during SpecializeCommon, which bootlooped every build that spawned
// a thread in server_specialize_pre OR _post (v349–v355).
//
// So at specialize time we create no thread — we only ARM a realtime signal
// handler (cheap, single-threaded, setcon-safe). The daemon sends that signal
// only AFTER sys.boot_completed, i.e. long past the specialize window, when
// system_server is fully up and already massively multi-threaded. The handler
// then spawns a short-lived worker that pulls the current module list from the
// daemon and loads any not-yet-loaded module into this live system_server.
//
// Signal 40 is a realtime signal (bionic reserves 32–34; 40 sits in the
// user-available range) agreed with the daemon (see zygiskd's
// signal_system_server_hotplug).
static constexpr int kHotplugSignal = 40;
static ZygiskContext *g_ss_ctx = nullptr;
static JavaVM *g_ss_vm = nullptr;

/// One pass: load every served module this system_server has not loaded yet.
/// Runs on a worker thread spawned post-boot, never during specialize.
static void hotplug_load_once() {
    static std::mutex mtx;
    static std::vector<std::string> loaded;
    std::lock_guard<std::mutex> lk(mtx);

    if (g_ss_ctx == nullptr || g_ss_vm == nullptr) return;
    JNIEnv *penv = nullptr;
    if (g_ss_vm->GetEnv(reinterpret_cast<void **>(&penv), JNI_VERSION_1_6) != JNI_OK) {
        if (g_ss_vm->AttachCurrentThread(&penv, nullptr) != JNI_OK) return;
    }

    auto ms = zygiskd::ReadModules();
    for (size_t i = 0; i < ms.size(); i++) {
        auto &m = ms[i];
        if (std::find(loaded.begin(), loaded.end(), m.name) != loaded.end()) continue;
        if (LoadedModule lm = LoadModuleFromMemfd(m.memfd)) {
            LOGI("hot-plug: loading module `%s` into live system_server", m.name.c_str());
            g_ss_ctx->modules.emplace_back(static_cast<int>(i), lm.handle, lm.entry, lm.custom);
            auto &mod = g_ss_ctx->modules.back();
            mod.onLoad(penv);
            // preServerSpecialize with fresh args — the specialize-time struct
            // is long gone. LSPosed-class modules only read the env.
            jint uid = 1000, gid = 1000, runtime_flags = 0;
            jintArray gids = nullptr;
            jlong caps = 0;
            ServerSpecializeArgs_v1 args(uid, gid, gids, runtime_flags, caps, caps);
            mod.preServerSpecialize(&args);
            loaded.push_back(m.name);
        }
    }
}

/// Realtime-signal handler armed in system_server. Spawns the worker thread.
/// Only ever runs post-boot (the daemon gates the signal on boot_completed),
/// so creating a thread here is safe — the setcon single-thread requirement
/// applies only during SpecializeCommon, which finished long ago.
static void hotplug_signal_handler(int) {
    if (g_ss_ctx != nullptr && g_ss_vm != nullptr) {
        std::thread(hotplug_load_once).detach();
    }
}

void ZygiskContext::server_specialize_pre() {
    run_modules_pre();
    zygiskd::SystemServerStarted();
}

void ZygiskContext::server_specialize_post() {
    run_modules_post();

    // Arm the live hot-plug path — WITHOUT creating any thread here. See the
    // block comment above: a thread during specialize bootloops the device.
    static std::atomic<bool> armed{false};
    if (!armed.exchange(true)) {
        JavaVM *vm = nullptr;
        if (env->GetJavaVM(&vm) == JNI_OK && vm != nullptr) {
            g_ss_ctx = this;
            g_ss_vm = vm;
            struct sigaction sa {};
            sa.sa_handler = hotplug_signal_handler;
            sigemptyset(&sa.sa_mask);
            sa.sa_flags = SA_RESTART;
            sigaction(kHotplugSignal, &sa, nullptr);
            LOGI("hot-plug: armed live loader signal in system_server");
        }
    }
}

// -----------------------------------------------------------------

void ZygiskContext::nativeSpecializeAppProcess_pre() {
    process = env->GetStringUTFChars(args.app->nice_name, nullptr);
    LOGV("pre specialize [%s]", process);
    // App specialize does not check FD
    flags |= SKIP_CLOSE_LOG_PIPE;
    app_specialize_pre();
}

void ZygiskContext::nativeSpecializeAppProcess_post() {
    LOGV("post specialize [%s]", process);
    app_specialize_post();
}

void ZygiskContext::nativeForkSystemServer_pre() {
    LOGV("pre forkSystemServer");
    flags |= SERVER_FORK_AND_SPECIALIZE;

    for (auto &map : g_hook->cached_map_infos) {
        if (map.dev == 0 && map.inode == 0 && map.offset == 0 && map.is_private &&
            map.path == "[anon:stack_and_tls:main]") {
            if ((map.perms & PROT_READ) == 0) {
                LOGV("Skipping non-readable stack map at %p", reinterpret_cast<void *>(map.start));
                continue;
            }
            auto search_from = reinterpret_cast<char *>(map.start);
            auto search_to = reinterpret_cast<char *>(map.end);
            spoof_zygote_fossil(search_from, search_to, "ref_profiles");
            break;
        }
    }

    fork_pre();
    if (is_child()) {
        server_specialize_pre();
        zygiskd::CacheMountNamespace(getpid());
    }
    sanitize_fds();
}

void ZygiskContext::nativeForkSystemServer_post() {
    if (is_child()) {
        LOGV("post forkSystemServer");
        server_specialize_post();
    }
    fork_post();
}

bool abort_zygote_unmount(const std::vector<mount_info> &traces, uint32_t info_flags) {
    if (traces.size() == 0) {
        LOGV("abort unmounting zygote with an empty trace list");
        return true;
    }
    bool is_magisk = info_flags & PROCESS_ROOT_IS_MAGISK;
    for (const auto &trace : traces) {
        if (trace.target.rfind("/product", 0) == 0) {
            if (trace.target.rfind("/product/bin", 0) == 0) continue;
            if (!is_magisk && trace.target != "/product") continue;
            // workaround for zygote resource overlay (JingMatrix/NeoZygisk#26)
            LOGV("abort unmounting zygote due to prohibited target: [%s]", trace.raw_info.c_str());
            return true;
        }
    }
    return false;
}

void ZygiskContext::nativeForkAndSpecialize_pre() {
    process = env->GetStringUTFChars(args.app->nice_name, nullptr);
    LOGV("pre forkAndSpecialize [%s]", process);
    flags |= APP_FORK_AND_SPECIALIZE;

    if (!g_hook->zygote_unmounted && g_hook->zygote_traces.size() == 0) {
        info_flags = zygiskd::GetProcessFlags(args.app->uid);

        g_hook->zygote_traces = check_zygote_traces(info_flags);

        if (!abort_zygote_unmount(g_hook->zygote_traces, info_flags)) {
            auto removal_predicate = [](const mount_info &trace) {
                LOGV("unmounting %s (mnt_id: %u)", trace.target.c_str(), trace.id);
                if (umount2(trace.target.c_str(), MNT_DETACH) == 0) {
                    return true;  // Success: Mark for removal.
                } else {
                    LOGE("failed to unmount %s: %s", trace.target.c_str(), strerror(errno));
                    return false;  // Failure: Keep this trace in the vector.
                }
            };

            auto new_end = std::remove_if(g_hook->zygote_traces.begin(),
                                          g_hook->zygote_traces.end(), removal_predicate);

            g_hook->zygote_traces.erase(new_end, g_hook->zygote_traces.end());
            g_hook->zygote_unmounted = true;
        }
    }

    fork_pre();
    if (is_child()) {
        app_specialize_pre();
    }

    sanitize_fds();
}

void ZygiskContext::nativeForkAndSpecialize_post() {
    if (is_child()) {
        LOGV("post forkAndSpecialize [%s]", process);
        app_specialize_post();
    }
    fork_post();
}

// -----------------------------------------------------------------

bool ZygiskContext::update_mount_namespace(zygiskd::MountNamespace namespace_type) {
    const char *type_str = (namespace_type == zygiskd::MountNamespace::Clean ? "Clean" : "Root");
    LOGV("updating mount namespace to type %s", type_str);

    int ns_fd = zygiskd::UpdateMountNamespace(namespace_type);

    // Check for failure (Not cached or error)
    if (ns_fd < 0) {
        LOGW("mount namespace [%s] not available/cached", type_str);
        return false;
    }

    // Apply the namespace
    // setns works directly with the FD received from the socket.
    int ret = setns(ns_fd, CLONE_NEWNS);
    if (ret != 0) {
        PLOGE("setns failed for type %s", type_str);
        close(ns_fd);
        return false;
    }

    close(ns_fd);
    return true;
}
