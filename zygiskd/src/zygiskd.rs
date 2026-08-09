// src/zygiskd.rs

//! The core logic for the Zygisk daemon (`zygiskd`).
//!
//! This module is responsible for:
//! - Initializing paths and communication channels.
//! - Loading Zygisk modules from the designated directory.
//! - Listening on a Unix domain socket for requests from the Zygisk injector.
//! - Handling requests such as providing module libraries, querying process flags,
//!   and managing companion processes.

use crate::constants::{DaemonSocketAction, ProcessFlags, ZKSU_VERSION};
use crate::mount::{MountNamespace, MountNamespaceManager};
use crate::r#fn;
use crate::utils::{self, UnixStreamExt};
use crate::{constants, lp_select, root_impl};
use anyhow::{Context as AnyhowContext, Result, bail};
use log::{debug, error, info, trace, warn};
use passfd::FdPassingExt;
use rustix::io::{FdFlags, fcntl_setfd};
use std::fs;
use std::io::Error;
use std::os::fd::AsRawFd;
use std::os::fd::{AsFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::{
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
};

/// A classic Zygisk module, as scanned fresh from `PATH_MODULES_DIR`.
///
/// Transient: built by `load_modules()` for a single request and dropped
/// afterwards. Its companion socket, if any, lives in
/// `AppContext::module_companions` (keyed by `name`) rather than here, so it
/// survives across repeated re-scans of the module directory.
struct Module {
    name: String,
    lib_fd: OwnedFd,
}

/// The shared context for the daemon: a mount namespace manager plus the
/// persistent companion-socket caches. Module and FN node *lists* are
/// intentionally not cached here — both are re-scanned from disk on every
/// request (see `load_modules`, `r#fn::scan_fn_nodes`), so installing,
/// enabling or disabling one takes effect on the very next process fork
/// instead of requiring the daemon (and thus the device) to restart.
struct AppContext {
    mount_manager: Arc<MountNamespaceManager>,
    /// Companion sockets for classic modules, keyed by module name.
    module_companions: Mutex<std::collections::HashMap<String, Mutex<Option<UnixStream>>>>,
    /// Companion sockets for FN nodes, keyed by node id.
    fn_companions: Mutex<std::collections::HashMap<String, Mutex<Option<UnixStream>>>>,
}

// Global paths, initialized once at startup.
static TMP_PATH: OnceLock<String> = OnceLock::new();

/// Sticky cache for `system_server_ready()`: sets once the property check
/// first observes boot complete, so later calls skip the property read.
static SYSTEM_SERVER_UP: AtomicBool = AtomicBool::new(false);
static CONTROLLER_SOCKET: OnceLock<String> = OnceLock::new();
static DAEMON_SOCKET_PATH: OnceLock<String> = OnceLock::new();

/// The main function for the zygiskd daemon.
pub fn main(tmp_path: Option<&str>) -> Result<()> {
    info!("Welcome to OnyxZygisk ({}) !", ZKSU_VERSION);

    initialize_globals(tmp_path)?;
    // One-time snapshot for the startup log only; every actual request re-scans
    // fresh (see `load_modules`), so this does not need to stay in sync with
    // modules installed/removed later. activate=false: must not run/rename a
    // staged module here — see `load_modules`'s doc comment.
    let startup_modules = load_modules(false)?;
    scan_fn_nodes_at_startup();
    // FN `post-fs-data` scripts run right after startup, mirroring Magisk's
    // post-fs-data stage.
    r#fn::run_fn_scripts(TMP_PATH.get().unwrap(), "post_fs_data");
    // The controller (ptrace monitor) may be absent when the daemon is started
    // manually (e.g. for debugging); that must not kill the daemon.
    if let Err(e) = send_startup_info(&startup_modules) {
        warn!("Failed to send startup info to controller: {}", e);
    }

    let mount_manager = Arc::new(MountNamespaceManager::new());
    let context = Arc::new(AppContext {
        mount_manager,
        module_companions: Mutex::new(std::collections::HashMap::new()),
        fn_companions: Mutex::new(std::collections::HashMap::new()),
    });
    let listener = create_daemon_socket()?;

    info!("Daemon listening on {}", DAEMON_SOCKET_PATH.get().unwrap());

    // Main event loop: accept and handle incoming connections.
    for stream in listener.incoming() {
        let stream = stream.context("Failed to accept incoming connection")?;
        let context = Arc::clone(&context);
        if let Err(e) = handle_connection(stream, context) {
            warn!("Error handling connection: {}", e);
        }
    }

    Ok(())
}

/// Handles a single incoming connection from Zygisk.
fn handle_connection(mut stream: UnixStream, context: Arc<AppContext>) -> Result<()> {
    let action = stream.read_u8()?;
    let action = DaemonSocketAction::try_from(action)
        .with_context(|| format!("Invalid daemon action code: {}", action))?;
    trace!("New daemon action: {:?}", action);

    match action {
        // These actions are lightweight and handled synchronously.
        DaemonSocketAction::CacheMountNamespace => {
            let pid = stream.read_u32()? as i32;
            context
                .mount_manager
                .save_mount_namespace(pid, MountNamespace::Clean)?;
            context
                .mount_manager
                .save_mount_namespace(pid, MountNamespace::Root)?;
        }
        DaemonSocketAction::PingHeartbeat => {
            let value = constants::ZYGOTE_INJECTED;
            utils::unix_datagram_sendto(CONTROLLER_SOCKET.get().unwrap(), &value.to_le_bytes())?;
        }
        DaemonSocketAction::ZygoteRestart => {
            info!("Zygote restarted, cleaning up companion sockets.");
            for companion in context.module_companions.lock().unwrap().values() {
                companion.lock().unwrap().take();
            }
            for companion in context.fn_companions.lock().unwrap().values() {
                companion.lock().unwrap().take();
            }
        }
        DaemonSocketAction::SystemServerStarted => {
            let value = constants::SYSTEM_SERVER_STARTED;
            utils::unix_datagram_sendto(CONTROLLER_SOCKET.get().unwrap(), &value.to_le_bytes())?;
            // FN `boot` (service.sh) scripts run at late-start, after
            // system_server is up — the same point Magisk runs service.sh.
            r#fn::run_fn_scripts(TMP_PATH.get().unwrap(), "boot");
            // Deferred service.sh of hot-plugged staged modules (lspd etc.)
            // can only start now, on a prepared framework.
            run_pending_staged_services();
        }
        // Heavier actions are spawned into a separate thread.
        _ => {
            thread::spawn(move || {
                if let Err(e) = handle_threaded_action(action, stream, &context) {
                    warn!(
                        "Error handling daemon action '{:?}': {:?}\nBacktrace: {}",
                        action,
                        e,
                        e.backtrace()
                    );
                }
            });
        }
    }
    Ok(())
}

/// Handles potentially long-running actions in a dedicated thread.
fn handle_threaded_action(
    action: DaemonSocketAction,
    mut stream: UnixStream,
    context: &AppContext,
) -> Result<()> {
    match action {
        DaemonSocketAction::GetProcessFlags => handle_get_process_flags(&mut stream),
        DaemonSocketAction::UpdateMountNamespace => {
            handle_update_mount_namespace(&mut stream, context)
        }
        DaemonSocketAction::ReadModules => handle_read_modules(&mut stream),
        DaemonSocketAction::RequestCompanionSocket => {
            handle_request_companion_socket(&mut stream, context)
        }
        DaemonSocketAction::GetModuleDir => handle_get_module_dir(&mut stream),
        DaemonSocketAction::ListFnNodes => handle_list_fn_nodes(&mut stream),
        DaemonSocketAction::SetFnNodeEnabled => handle_set_fn_node_enabled(&mut stream),
        DaemonSocketAction::RemoveFnNode => handle_remove_fn_node(&mut stream),
        DaemonSocketAction::ReadFnModules => handle_read_fn_modules(&mut stream),
        DaemonSocketAction::GetFnModuleDir => handle_get_fn_module_dir(&mut stream),
        // Other cases are handled synchronously and won't reach here.
        _ => unreachable!(),
    }
}

/// Initializes global path variables from the daemon work directory.
fn initialize_globals(tmp_path: Option<&str>) -> Result<()> {
    let tmp_path = match tmp_path {
        // The normal path: the loader passes the work directory via `--workdir`.
        Some(path) if !path.is_empty() => path.to_owned(),
        Some(_) => bail!("TMP_PATH daemon argument is empty"),
        // Escape hatch for manual invocation without `--workdir`.
        None => std::env::var("TMP_PATH").context("TMP_PATH environment variable not set")?,
    };
    TMP_PATH.set(tmp_path).unwrap();

    CONTROLLER_SOCKET
        .set(format!("{}/init_monitor", TMP_PATH.get().unwrap()))
        .unwrap();
    DAEMON_SOCKET_PATH
        .set(format!(
            "{}/{}",
            TMP_PATH.get().unwrap(),
            lp_select!("/cp32.sock", "/cp64.sock")
        ))
        .unwrap();
    Ok(())
}

/// Sends initial status information to the controller.
fn send_startup_info(modules: &[Module]) -> Result<()> {
    let mut msg = Vec::<u8>::new();
    let info = match root_impl::get() {
        root_impl::RootImpl::APatch
        | root_impl::RootImpl::KernelSU
        | root_impl::RootImpl::Magisk => {
            msg.extend_from_slice(&constants::DAEMON_SET_INFO.to_le_bytes());
            let module_names: Vec<_> = modules.iter().map(|m| m.name.as_str()).collect();
            if !module_names.is_empty() {
                format!(
                    "\t\tRoot: {:?}\n\t\tModules ({}):\n\t\t\t{}",
                    root_impl::get(),
                    modules.len(),
                    module_names.join("\n\t\t\t")
                )
            } else {
                format!("\t\tRoot: {:?}", root_impl::get())
            }
        }
        _ => {
            msg.extend_from_slice(&constants::DAEMON_SET_ERROR_INFO.to_le_bytes());
            format!("\t\tInvalid root implementation: {:?}", root_impl::get())
        }
    };
    msg.extend_from_slice(&(info.len() as u32 + 1).to_le_bytes());
    msg.extend_from_slice(info.as_bytes());
    msg.push(0); // Null terminator
    utils::unix_datagram_sendto(CONTROLLER_SOCKET.get().unwrap(), &msg)
        .context("Failed to send startup info to controller")
}

/// Detects the device architecture.
fn get_arch() -> Result<&'static str> {
    let system_arch = utils::get_property("ro.product.cpu.abi")?;
    if system_arch.contains("arm") {
        Ok(lp_select!("armeabi-v7a", "arm64-v8a"))
    } else if system_arch.contains("x86") {
        Ok(lp_select!("x86", "x86_64"))
    } else if system_arch.is_empty() {
        // No property service (host runs, manual startup): fall back to the
        // compiled-in ABI. Android always sets the property.
        Ok(lp_select!("armeabi-v7a", "arm64-v8a"))
    } else {
        bail!("Unsupported system architecture: {}", system_arch)
    }
}

/// Whether a staged update for `name` sitting in `PATH_MODULES_UPDATE_DIR` is
/// complete and safe to read.
///
/// The root solutions' own "install/update finished" flags are not reliable
/// across KernelSU / APatch / FolkPatch in practice: ksud only leaves a
/// metadata stub in `modules/<id>/` (no `.so`) and apd's global
/// `/data/adb/ap/update` flag is cleared at boot. So file completeness of the
/// staged entry itself is the signal — `module.prop` plus at least one ABI's
/// Zygisk `.so`, the exact payload this daemon needs to serve the module.
///
/// Magisk has no staging directory at all, so this is always false there — a
/// fresh or updated module still needs a reboot before this daemon can see it.
fn staged_update_ready(name: &str) -> bool {
    let dir = Path::new(constants::PATH_MODULES_UPDATE_DIR).join(name);
    dir.join("module.prop").exists()
        && (dir.join("zygisk/arm64-v8a.so").exists()
            || dir.join("zygisk/armeabi-v7a.so").exists())
}

/// Whether the user explicitly opted `name` into using its staged update
/// early, via the WebUI's per-module switch (`WORKDIR/hotplug/<name>`,
/// touched/removed exactly like the `disable`/`update`/`remove` flags
/// elsewhere in this project).
///
/// `staged_update_ready` alone only proves the staged copy is *safe* to
/// read; it says nothing about whether the user *wants* it read before the
/// root solution's own official boot-time commit. Requiring this opt-in too
/// turns that automatic behavior into an explicit, per-module confirmation.
fn hotplug_opted_in(name: &str) -> bool {
    Path::new(TMP_PATH.get().unwrap()).join("hotplug").join(name).exists()
}

/// Master switch for the whole hot-plug feature (`WORKDIR/hotplug_off`
/// present). When off, every per-module opt-in is ignored and staged updates
/// only take effect through the root solution's own boot-time swap — i.e. a
/// reboot. Absent by default, so hot-plug is on out of the box.
fn hotplug_master_enabled() -> bool {
    !Path::new(TMP_PATH.get().unwrap()).join("hotplug_off").exists()
}

/// Names and directories of every module eligible for Zygisk injection,
/// sorted by name. Two sources are merged:
///
/// - `PATH_MODULES_DIR`, the active directory — today's baseline;
/// - any module with a *complete* staged update in `PATH_MODULES_UPDATE_DIR`
///   that the user has also explicitly opted into, while the hot-plug master
///   switch is on (see `staged_update_ready`, `hotplug_master_enabled` and
///   `hotplug_opted_in`). A staged entry wins over an active one with the
///   same name (it is the newer version); its disabled state is inherited
///   from the active entry, mirroring exactly what `ksud`'s / `apd`'s own
///   boot-time swap does ("if the old module is disabled, the new one starts
///   disabled too").
///
/// This is what lets a freshly installed or updated module become
/// injectable on the very next process fork, instead of waiting for the
/// boot-time swap the root solution itself performs — once the user
/// confirms it, via the WebUI's per-module switch.
///
/// Hot-plug is inherently Zygisk-only: both sources only accept entries that
/// carry `zygisk/<arch>.so` for the running ABI.
///
/// Sorting keeps the order deterministic across the several independent
/// re-scans a single process specialize can trigger (`ReadModules`, then
/// possibly `RequestCompanionSocket`/`GetModuleDir` for the same loader-side
/// index), the same way FN nodes stay ordered by `scan_fn_nodes`.
fn eligible_modules(arch: &str) -> Vec<(String, PathBuf)> {
    // name -> (module_dir, disabled)
    let mut modules: std::collections::HashMap<String, (PathBuf, bool)> =
        std::collections::HashMap::new();

    if let Ok(dir) = fs::read_dir(constants::PATH_MODULES_DIR) {
        for entry in dir.flatten() {
            let name = entry.file_name().into_string().unwrap_or_default();
            let module_dir = entry.path();
            if module_dir.join(format!("zygisk/{arch}.so")).exists() {
                let disabled = module_dir.join("disable").exists();
                modules.insert(name, (module_dir, disabled));
            }
        }
    } else {
        warn!("Failed to read modules directory: {}", constants::PATH_MODULES_DIR);
    }

    // Unplug: a module that was hot-plugged into the active directory stays
    // served only while its hotplug opt-in flag exists. Removing the flag
    // (the WebUI switch off) stops injection into newly forked processes —
    // no restart involved.
    let unplugged: Vec<String> = modules
        .iter()
        .filter(|(name, (_, disabled))| {
            if *disabled {
                return false;
            }
            let activated = Path::new(TMP_PATH.get().unwrap())
                .join("hotplug_activated")
                .join(format!("{name}.post_fs_data"));
            activated.exists() && !hotplug_opted_in(name)
        })
        .map(|(name, _)| name.clone())
        .collect();
    for name in unplugged {
        info!("Hot-plug: module `{}` unplugged, not served", name);
        if let Some((dir, _)) = modules.get(&name) {
            modules.insert(name, (dir.clone(), true));
        }
    }

    for (name, module_dir) in opted_in_staged_modules() {
        if !module_dir.join(format!("zygisk/{arch}.so")).exists() {
            continue;
        }
        let disabled = modules.get(&name).is_some_and(|(_, d)| *d);
        modules.insert(name, (module_dir, disabled)); // staged wins
    }

    let mut found: Vec<(String, PathBuf)> = modules
        .into_iter()
        .filter(|(_, (_, disabled))| !disabled)
        .map(|(name, (dir, _))| (name, dir))
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// Scans for eligible modules fresh, and creates memfds for their libraries.
///
/// Called on every `ReadModules` request rather than once at startup, so
/// installing, enabling or disabling a module takes effect on the very next
/// process fork instead of requiring the daemon to restart.
/// `activate` gates the staged-module activation side effect (directory
/// rename + spawning post-fs-data.sh/service.sh, see `activate_staged_module`
/// and `run_pending_staged_services`) — pass `false` for a read-only listing.
///
/// This matters at daemon startup specifically: the hot-plug opt-in flag
/// (`WORKDIR/hotplug/<name>`) is a plain file that survives a reboot, so on
/// every boot where a module was left opted-in from a previous session, an
/// unconditional call here would activate it as a side effect of what is
/// only meant to be a passive startup log snapshot. `main()` passes `false`
/// for that snapshot; the real per-request path (`handle_read_modules`)
/// passes `true`.
///
/// `activate: true` alone is *not* enough to actually perform the swap,
/// though: `system_server` goes through this exact same `ReadModules` call
/// as part of its own specialize (`nativeForkSystemServer_pre` ->
/// `run_modules_pre`), which on a fresh boot is close to the first
/// `activate: true` call of the whole boot — so gating only the *caller*
/// does not move the swap out of that fragile window, only which code path
/// happens to trigger it. The actual mutation — directory rename and
/// spawning a shell to run scripts — additionally requires
/// `system_server_ready()`. Before that, a module is still injected straight
/// from its staged `.so` (loading via memfd does not care where the source
/// file lives, unlike running a script/binary as a subprocess, which is
/// exactly the file-context problem `activate_staged_module` exists to
/// avoid) — only the disruptive part waits.
fn load_modules(activate: bool) -> Result<Vec<Module>> {
    let arch = get_arch()?;
    debug!("Daemon architecture: {arch}");

    // Opportunistic catch-up: schedules any hot-plugged module's service.sh
    // that missed the live SystemServerStarted event for this daemon
    // instance (see `system_server_ready`). Cheap no-op once nothing is
    // pending.
    if activate {
        run_pending_staged_services();
    }

    let mut modules = Vec::new();
    for (name, module_dir) in eligible_modules(arch) {
        // A staged entry needs activation: swap into the active directory and
        // run its lifecycle scripts once (see `activate_staged_module`).
        // Deferred until system_server_ready(): see this function's doc
        // comment for why `activate` alone does not avoid the fragile window.
        if activate
            && system_server_ready()
            && module_dir.starts_with(constants::PATH_MODULES_UPDATE_DIR)
        {
            activate_staged_module(&name, &module_dir);
        }
        // Activation may have moved the module into the active directory —
        // resolve the .so from there when it exists, else load it straight
        // from the staged copy (module_dir) so injection works even before
        // system_server_ready() allows the real swap.
        let active_dir = Path::new(constants::PATH_MODULES_DIR).join(&name);
        let so_path = if active_dir.join(format!("zygisk/{arch}.so")).exists() {
            active_dir.join(format!("zygisk/{arch}.so"))
        } else {
            module_dir.join(format!("zygisk/{arch}.so"))
        };
        info!("Loading module `{}`...", name);
        match create_library_fd(&so_path) {
            Ok(lib_fd) => modules.push(Module { name, lib_fd }),
            Err(e) => warn!("Failed to create memfd for `{}`: {}", name, e),
        }
    }
    Ok(modules)
}

/// Sweeps the FN node directory once at startup and logs the result.
fn scan_fn_nodes_at_startup() {
    let nodes = r#fn::scan_fn_nodes(TMP_PATH.get().unwrap());
    let enabled = nodes
        .iter()
        .filter(|n| matches!(n.status, r#fn::FnStatus::Enabled))
        .count();
    info!("FN nodes: {} enabled / {} total", enabled, nodes.len());
}

/// Runs one lifecycle script of a (staged) module against its own directory,
/// mirroring how the root solution's boot-time swap runs module scripts.
fn run_module_script(module_dir: &Path, script: &Path) {
    let output = Command::new("sh")
        .arg(script)
        .current_dir(module_dir)
        .env("MODDIR", module_dir)
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stdout.is_empty() {
                info!("Module script stdout:\n{}", stdout.trim_end());
            }
            if !stderr.is_empty() {
                warn!("Module script stderr:\n{}", stderr.trim_end());
            }
            if !output.status.success() {
                warn!(
                    "Module script {} exited with {}",
                    script.file_name().unwrap_or_default().to_string_lossy(),
                    output.status
                );
            }
        }
        Err(e) => {
            warn!("Failed to run module script {}: {}", script.display(), e);
        }
    }
}

/// Whether system_server is up enough for `service.sh`-stage daemons (lspd
/// etc.) to start safely — they crash on an unprepared framework.
///
/// Trusting only the one-shot `SystemServerStarted` socket message (sent by
/// the loader exactly once, when zygote forks system_server) is not enough:
/// if *this* daemon process started after that already happened in the
/// current zygote lifetime, the message has already fired and will not fire
/// again this boot, so a purely event-driven flag would stay false forever.
/// That is the common case here — flashing a new OnyxZygisk build does not
/// restart the already-running daemon, only a device reboot does, and this
/// feature's whole point is working without one.
///
/// `sys.boot_completed` is a standard Android property, independent of any
/// root solution, queryable at any time — checking it directly is
/// self-healing regardless of when the daemon happened to start. Sticky
/// once observed true: further calls skip the property read.
fn system_server_ready() -> bool {
    if SYSTEM_SERVER_UP.load(Ordering::Relaxed) {
        return true;
    }
    let ready = utils::get_property("sys.boot_completed")
        .map(|v| v.trim() == "1")
        .unwrap_or(false);
    if ready {
        SYSTEM_SERVER_UP.store(true, Ordering::Relaxed);
    }
    ready
}

/// Activates a hot-plugged staged module: swaps it into the active
/// directory and runs its lifecycle scripts exactly once.
///
/// Module binaries must run from `/data/adb/modules/<id>` — the same
/// location the root solution's boot-time swap uses. Running them from
/// `modules_update/` is not equivalent: lspd (LSPosed) crashes
/// deterministically with SIGSEGV (pc=sp=0x314, uninitialized stack) when
/// started from the staged directory, because the file context differs.
/// So the staged copy is moved into place first (mirroring what ksud/apd
/// do at boot), then the scripts run from the real location:
///
/// - `post-fs-data.sh` runs immediately (marker
///   `WORKDIR/hotplug_activated/<name>.post_fs_data`);
/// - `service.sh` waits for system_server (see `system_server_ready`):
///   immediate when hot-plugging mid-session on an already-booted device,
///   otherwise caught on the next `load_modules()` call or the
///   `SystemServerStarted` event, whichever comes first (marker `...service`).
///
/// After the swap the module is a normal active module: served from the
/// active dir, and the root solution's next boot-time swap finds nothing
/// left in modules_update/.
fn activate_staged_module(name: &str, module_dir: &Path) {
    let active_dir = Path::new(constants::PATH_MODULES_DIR).join(name);
    // Swap the staged copy into the active directory (preserving a possible
    // disable flag from the active stub, like the boot-time swap inherits
    // the disabled state).
    if let Ok(md) = fs::metadata(&active_dir) {
        if md.is_dir() {
            let _ = fs::rename(active_dir.join("disable"), module_dir.join("disable"));
            let _ = fs::remove_dir_all(&active_dir);
        }
    }
    if let Err(e) = fs::rename(module_dir, &active_dir) {
        warn!(
            "Hot-plug: failed to swap staged module \"{}\" into {}: {}",
            name, active_dir.display(), e
        );
        return;
    }
    info!("Hot-plug: swapped staged module \"{}\" into the active directory", name);

    let dir = active_dir;
    let marker_post = Path::new(TMP_PATH.get().unwrap())
        .join("hotplug_activated")
        .join(format!("{name}.post_fs_data"));
    if !marker_post.exists() {
        let dir_clone = dir.clone();
        let marker_clone = marker_post.clone();
        std::thread::spawn(move || {
            let p = dir_clone.join("post-fs-data.sh");
            if p.is_file() {
                run_module_script(&dir_clone, &p);
            }
            if let Some(parent) = marker_clone.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&marker_clone, b"1");
        });
    }
    let marker_svc = Path::new(TMP_PATH.get().unwrap())
        .join("hotplug_activated")
        .join(format!("{name}.service"));
    if !marker_svc.exists() && system_server_ready() {
        let dir_clone = dir.clone();
        let marker_clone = marker_svc.clone();
        let name_clone = name.to_string();
        std::thread::spawn(move || {
            let p = dir_clone.join("service.sh");
            if p.is_file() {
                run_module_script(&dir_clone, &p);
            }
            if let Some(parent) = marker_clone.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&marker_clone, b"1");
            // lspd (and any service.sh daemon) is now up. Re-fork
            // system_server once so this freshly hot-plugged framework module
            // loads at specialize and actually activates — no full reboot.
            restart_system_server_once(&name_clone);
        });
        info!("Hot-plug: scheduling service.sh for swapped module \"{}\"", name);
    }
}

/// Opted-in staged modules (master switch on, staged copy complete, per-module
/// opt-in flag present). Shared by the module scan and the script stages.
fn opted_in_staged_modules() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if !hotplug_master_enabled() {
        return out;
    }
    if let Ok(dir) = fs::read_dir(constants::PATH_MODULES_UPDATE_DIR) {
        for entry in dir.flatten() {
            let name = entry.file_name().into_string().unwrap_or_default();
            if !staged_update_ready(&name) || !hotplug_opted_in(&name) {
                continue;
            }
            out.push((name, entry.path()));
        }
    }
    out
}

/// Runs the deferred `service.sh` of hot-plugged modules once system_server
/// is ready (see `system_server_ready`) — the same point Magisk/KernelSU run
/// service.sh. After the swap the module lives in the active directory, so
/// this walks the activation markers: names with a `.post_fs_data` marker
/// but no `.service` marker yet, whose active dir carries a Zygisk `.so`.
///
/// Called both from the live `SystemServerStarted` event and opportunistically
/// from every `load_modules()` call, so a module activated on a daemon
/// instance that never received that event (started after system_server was
/// already up) still gets its service.sh scheduled on the very next app
/// launch instead of never. Cheap to call liberally: a directory scan plus
/// marker checks, and each module is scheduled for real work at most once
/// (guarded by the marker file itself).
/// The pid of the running `system_server`, found by scanning `/proc`.
fn pidof_system_server() -> Option<i32> {
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if let Ok(cmdline) = fs::read_to_string(format!("/proc/{pid}/cmdline")) {
            if cmdline.split('\0').next() == Some("system_server") {
                return Some(pid);
            }
        }
    }
    None
}

/// Restart just system_server (a ~15s framework "soft reboot", not a device
/// reboot) so a freshly hot-plugged framework module (LSPosed) is loaded at
/// the fresh fork/specialize — the ONLY point a framework module activates.
/// Killing system_server makes init respawn zygote's system_server; our
/// nativeForkSystemServer hook then injects the now-active module the normal,
/// crash-free way. Guarded by a one-shot marker so it happens once per
/// hot-plug, never on an ordinary boot (where the module is already active and
/// no swap runs).
fn restart_system_server_once(name: &str) {
    let marker = Path::new(TMP_PATH.get().unwrap())
        .join("hotplug_activated")
        .join(format!("{name}.restarted"));
    if marker.exists() {
        return;
    }
    if let Some(parent) = marker.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&marker, b"1");
    match pidof_system_server() {
        Some(pid) => {
            info!(
                "Hot-plug: restarting system_server (pid {}) to activate framework module \"{}\"",
                pid, name
            );
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        None => warn!("Hot-plug: system_server pid not found; cannot restart to activate \"{}\"", name),
    }
}

fn run_pending_staged_services() {
    if !system_server_ready() {
        return;
    }
    let markers = Path::new(TMP_PATH.get().unwrap()).join("hotplug_activated");
    let Ok(dir) = fs::read_dir(&markers) else {
        return;
    };
    for entry in dir.flatten() {
        let fname = entry.file_name().to_string_lossy().into_owned();
        let Some(name) = fname.strip_suffix(".post_fs_data") else {
            continue;
        };
        if markers.join(format!("{name}.service")).exists() {
            continue;
        }
        let active_dir = Path::new(constants::PATH_MODULES_DIR).join(name);
        let has_so = ["zygisk/arm64-v8a.so", "zygisk/armeabi-v7a.so"]
            .iter()
            .any(|p| active_dir.join(p).exists());
        if !has_so {
            continue;
        }
        let dir_clone = active_dir.clone();
        let marker_clone = markers.join(format!("{name}.service"));
        let name_clone = name.to_string();
        std::thread::spawn(move || {
            let p = dir_clone.join("service.sh");
            if p.is_file() {
                run_module_script(&dir_clone, &p);
            }
            let _ = fs::write(&marker_clone, b"1");
            // Re-fork system_server once so this freshly hot-plugged framework
            // module activates at specialize — no full reboot. See
            // restart_system_server_once.
            restart_system_server_once(&name_clone);
        });
        info!("Hot-plug: scheduling deferred service.sh for swapped module \"{}\"", name);
    }
}

/// Creates a sealed, read-only memfd containing the module's shared library.
/// This is a security measure to prevent the library from being tampered with after loading.
fn create_library_fd(so_path: &Path) -> Result<OwnedFd> {
    let opts = memfd::MemfdOptions::default().allow_sealing(true);
    let memfd = opts.create("zygisk-module")?;

    // Copy the library content into the memfd.
    let file = fs::File::open(so_path)?;
    let mut reader = std::io::BufReader::new(file);
    let mut writer = memfd.as_file();
    std::io::copy(&mut reader, &mut writer)?;

    // Apply seals to make the memfd immutable.
    let mut seals = memfd::SealsHashSet::new();
    seals.insert(memfd::FileSeal::SealShrink);
    seals.insert(memfd::FileSeal::SealGrow);
    seals.insert(memfd::FileSeal::SealWrite);
    seals.insert(memfd::FileSeal::SealSeal);

    if let Err(e) = memfd.add_seals(&seals) {
        // Ignore errors for the sake of compatibility
        warn!("Failed to add seals : {}", e);
    }

    Ok(OwnedFd::from(memfd.into_file()))
}

/// Creates and binds the main daemon Unix socket.
fn create_daemon_socket() -> Result<UnixListener> {
    utils::set_socket_create_context("u:r:zygote:s0")?;
    let listener = utils::unix_listener_from_path(DAEMON_SOCKET_PATH.get().unwrap())?;
    Ok(listener)
}

/// Spawns a companion process for a module.
///
/// This involves forking, setting up a communication channel (Unix socket pair),
/// and re-executing the daemon binary with special arguments (`companion <fd>`).
fn spawn_companion(name: &str, lib_fd: RawFd) -> Result<Option<UnixStream>> {
    let (mut daemon_sock, companion_sock) = UnixStream::pair()?;

    // FIXME: A more robust way to get the current executable path is desirable.
    let self_exe = std::env::args().next().unwrap();
    let nice_name = self_exe.split('/').last().unwrap_or("zygiskd");

    // The fork/exec logic is now handled directly here.
    // # Safety
    // This is highly unsafe because it uses `fork()` and `exec()`. The child
    // process must not call any non-async-signal-safe functions before `exec()`.
    unsafe {
        let pid = libc::fork();
        if pid < 0 {
            // Fork failed
            bail!(Error::last_os_error());
        }

        if pid == 0 {
            // --- Child Process ---
            drop(daemon_sock); // Child doesn't need the daemon's end of the socket.

            // The companion socket FD must be passed to the new process,
            // so we must remove the `FD_CLOEXEC` flag.
            fcntl_setfd(companion_sock.as_fd(), FdFlags::empty())
                .expect("Failed to clear CLOEXEC on companion socket");

            // The first argument (`arg0`) is used to set a descriptive process name.
            let arg0 = format!("{}-{}", nice_name, name);
            let companion_fd_str = format!("{}", companion_sock.as_raw_fd());

            // exec replaces the current process; it does not return on success.
            let err = Command::new(&self_exe)
                .arg0(arg0)
                .arg("companion")
                .arg(companion_fd_str)
                .exec();

            // If exec returns, it's always an error.
            bail!("exec failed: {}", err);
        }

        // --- Parent Process ---
        drop(companion_sock); // Parent doesn't need the companion's end of the socket.

        // Now, establish communication with the newly spawned companion.
        daemon_sock.write_string(name)?;
        daemon_sock.send_fd(lib_fd)?;

        // Wait for the companion's response to know if it loaded the module successfully.
        match daemon_sock.read_u8()? {
            0 => Ok(None),              // Module has no companion entry point or failed to load.
            1 => Ok(Some(daemon_sock)), // Companion is ready.
            _ => bail!("Invalid response from companion setup"),
        }
    }
}

// --- Action Handlers ---

fn handle_get_process_flags(stream: &mut UnixStream) -> Result<()> {
    let uid = stream.read_u32()? as i32;
    let mut flags = ProcessFlags::empty();

    if root_impl::uid_is_manager(uid) {
        flags |= ProcessFlags::PROCESS_IS_MANAGER;
    } else {
        if root_impl::uid_granted_root(uid) {
            flags |= ProcessFlags::PROCESS_GRANTED_ROOT;
        }
        if root_impl::uid_should_umount(uid) {
            flags |= ProcessFlags::PROCESS_ON_DENYLIST;
        }
    }

    match root_impl::get() {
        root_impl::RootImpl::APatch => flags |= ProcessFlags::PROCESS_ROOT_IS_APATCH,
        root_impl::RootImpl::KernelSU => flags |= ProcessFlags::PROCESS_ROOT_IS_KSU,
        root_impl::RootImpl::Magisk => flags |= ProcessFlags::PROCESS_ROOT_IS_MAGISK,
        _ => (), // No flag for None, TooOld, or Multiple
    }

    trace!("Flags for UID {}: {:?}", uid, flags);
    stream.write_u32(flags.bits())?;
    Ok(())
}

fn handle_update_mount_namespace(stream: &mut UnixStream, context: &AppContext) -> Result<()> {
    let namespace_type = MountNamespace::try_from(stream.read_u8()?)?;
    if let Some(fd) = context.mount_manager.get_namespace_fd(namespace_type) {
        // Namespace is already cached, send the FD to the client.
        // SUCCESS: Send Status '1', then the FD.
        stream.write_u8(1)?;
        stream.send_fd(fd)?;
    } else {
        // FAILURE: Send Status '0'. 
        // Do NOT send an FD or random u32 bytes, just stop here.
        warn!("Namespace {:?} is not cached yet.", namespace_type);
        stream.write_u8(0)?;
    }
    Ok(())
}

fn handle_read_modules(stream: &mut UnixStream) -> Result<()> {
    // Re-scanned fresh on every call — see `load_modules`.
    let modules = load_modules(true)?;
    stream.write_usize(modules.len())?;
    for module in &modules {
        stream.write_string(&module.name)?;
        stream.send_fd(module.lib_fd.as_raw_fd())?;
    }
    Ok(())
}

fn handle_request_companion_socket(stream: &mut UnixStream, context: &AppContext) -> Result<()> {
    let index = stream.read_usize()?;
    let arch = get_arch()?;
    let modules = eligible_modules(arch);

    // FN nodes are addressed with an index offset past the classic modules
    // (see `handle_read_fn_modules`); resolve them against a fresh scan.
    if index >= modules.len() {
        return handle_request_fn_companion_socket(stream, context, index - modules.len());
    }
    let (name, module_dir) = &modules[index];

    // Companion is keyed by module name (not the index above, which only
    // holds for this one scan) so it survives repeated re-scans of the
    // module directory, mirroring `handle_request_fn_companion_socket`.
    let companions = &mut *context.module_companions.lock().unwrap();
    let cell = companions.entry(name.clone()).or_default();
    let mut companion = cell.lock().unwrap();

    // Check if the existing companion socket is still alive.
    if let Some(sock) = companion.as_ref() {
        if !utils::is_socket_alive(sock) {
            error!("Companion for module `{}` appears to have crashed.", name);
            companion.take();
        }
    }

    // If no companion exists, try to spawn one. The library is only memfd'd
    // here, on the cold path — most requests hit an already-alive companion
    // above and never need it. `module_dir` may be a staged-update directory
    // rather than the active one — see `eligible_modules`.
    if companion.is_none() {
        let so_path = module_dir.join(format!("zygisk/{arch}.so"));
        match create_library_fd(&so_path).and_then(|fd| spawn_companion(name, fd.as_raw_fd())) {
            Ok(Some(sock)) => {
                trace!("Spawned new companion for `{}`.", name);
                *companion = Some(sock);
            }
            Ok(None) => {
                warn!("Module `{}` does not have a companion entry point.", name);
            }
            Err(e) => {
                warn!("Failed to spawn companion for `{}`: {}", name, e);
            }
        };
    }

    // Send the companion FD to the client if available.
    if let Some(sock) = companion.as_ref() {
        if let Err(e) = sock.send_fd(stream.as_raw_fd()) {
            error!("Failed to send companion socket FD for module `{}`: {}", name, e);
            // Inform client of failure.
            stream.write_u8(0)?;
        }
        // If successful, the companion itself will notify the client.
    } else {
        // Inform client that no companion is available.
        stream.write_u8(0)?;
    }
    Ok(())
}

/// Companion resolution for FN nodes: the companion is keyed by node id so
/// that it survives re-scans of the node directory.
fn handle_request_fn_companion_socket(
    stream: &mut UnixStream,
    context: &AppContext,
    fn_index: usize,
) -> Result<()> {
    let nodes = r#fn::active_native_nodes(TMP_PATH.get().unwrap());
    let Some(node) = nodes.get(fn_index) else {
        warn!("FN companion requested for unknown index {}", fn_index);
        stream.write_u8(0)?;
        return Ok(());
    };
    let entry = node.entry.as_deref().unwrap_or_default();
    let lib_path = format!("{}/fn/{}/{}", TMP_PATH.get().unwrap(), node.id, entry);
    let lib_fd = create_library_fd(Path::new(&lib_path))?;

    let companions = &mut *context.fn_companions.lock().unwrap();
    let cell = companions.entry(node.id.clone()).or_default();
    let mut companion = cell.lock().unwrap();
    if let Some(sock) = companion.as_ref() {
        if !utils::is_socket_alive(sock) {
            error!("Companion for FN node `{}` appears to have crashed.", node.id);
            companion.take();
        }
    }
    if companion.is_none() {
        match spawn_companion(&node.id, lib_fd.as_raw_fd()) {
            Ok(Some(sock)) => {
                trace!("Spawned new companion for FN node `{}`.", node.id);
                *companion = Some(sock);
            }
            Ok(None) => {
                warn!("FN node `{}` does not have a companion entry point.", node.id);
            }
            Err(e) => {
                warn!("Failed to spawn companion for FN node `{}`: {}", node.id, e);
            }
        };
    }

    if let Some(sock) = companion.as_ref() {
        if let Err(e) = sock.send_fd(stream.as_raw_fd()) {
            error!(
                "Failed to send companion socket FD for FN node `{}`: {}",
                node.id, e
            );
            stream.write_u8(0)?;
        }
    } else {
        stream.write_u8(0)?;
    }
    Ok(())
}

fn handle_get_module_dir(stream: &mut UnixStream) -> Result<()> {
    let index = stream.read_usize()?;
    let modules = eligible_modules(get_arch()?);
    let dir = if index < modules.len() {
        // `module_dir` may be a staged-update directory rather than the
        // active one — see `eligible_modules`.
        let (_, module_dir) = &modules[index];
        fs::File::open(module_dir)?
    } else {
        // FN node directory, addressed with the offset index space.
        let nodes = r#fn::active_native_nodes(TMP_PATH.get().unwrap());
        let fn_index = index - modules.len();
        let Some(node) = nodes.get(fn_index) else {
            bail!("Unknown module index {}", index);
        };
        r#fn::get_fn_module_dir(TMP_PATH.get().unwrap(), &node.id)?
    };
    stream.send_fd(dir.as_raw_fd())?;
    Ok(())
}

fn handle_list_fn_nodes(stream: &mut UnixStream) -> Result<()> {
    let nodes = r#fn::scan_fn_nodes(TMP_PATH.get().unwrap());
    stream.write_string(&r#fn::serialize_fn_nodes(&nodes))?;
    Ok(())
}

fn handle_set_fn_node_enabled(stream: &mut UnixStream) -> Result<()> {
    let id = stream.read_string()?;
    let enabled = stream.read_u8()? != 0;
    match r#fn::set_fn_node_enabled(TMP_PATH.get().unwrap(), &id, enabled) {
        Ok(()) => stream.write_u8(1)?,
        Err(e) => {
            warn!("Failed to set FN node `{}` enabled={}: {}", id, enabled, e);
            stream.write_u8(0)?;
        }
    }
    Ok(())
}

fn handle_remove_fn_node(stream: &mut UnixStream) -> Result<()> {
    let id = stream.read_string()?;
    match r#fn::mark_fn_node_removed(TMP_PATH.get().unwrap(), &id) {
        Ok(()) => stream.write_u8(1)?,
        Err(e) => {
            warn!("Failed to remove FN node `{}`: {}", id, e);
            stream.write_u8(0)?;
        }
    }
    Ok(())
}

/// Streams the active FN entry libraries to the loader: count, then per node
/// `id`, `triggers`, `scope` (0=all, 1=allowlist, 2=denylist), `apps`,
/// `priority` (u32), and the entry library as a sealed memfd. The ordering —
/// priority ascending, then id — defines the FN index space used by
/// `RequestCompanionSocket` and `GetModuleDir` (offset by the classic module
/// count, see `handle_request_fn_companion_socket`).
fn handle_read_fn_modules(stream: &mut UnixStream) -> Result<()> {
    let nodes = r#fn::active_native_nodes(TMP_PATH.get().unwrap());
    stream.write_usize(nodes.len())?;
    for node in &nodes {
        let entry = node.entry.as_deref().unwrap_or_default();
        let lib_path = format!("{}/fn/{}/{}", TMP_PATH.get().unwrap(), node.id, entry);
        let lib_fd = create_library_fd(Path::new(&lib_path))?;

        stream.write_string(&node.id)?;
        stream.write_string(&node.triggers.join(","))?;
        stream.write_u8(match node.scope {
            r#fn::FnScope::All => 0,
            r#fn::FnScope::Allowlist => 1,
            r#fn::FnScope::Denylist => 2,
        })?;
        stream.write_string(&node.apps.join(","))?;
        stream.write_u32(node.priority as u32)?;
        stream.send_fd(lib_fd.as_raw_fd())?;
        trace!("Sent FN module `{}` ({} bytes) to loader", node.id, entry);
    }
    Ok(())
}

fn handle_get_fn_module_dir(stream: &mut UnixStream) -> Result<()> {
    let id = stream.read_string()?;
    match r#fn::get_fn_module_dir(TMP_PATH.get().unwrap(), &id) {
        Ok(dir) => {
            stream.send_fd(dir.as_raw_fd())?;
            Ok(())
        }
        Err(e) => {
            warn!("Failed to open FN node dir `{}`: {}", id, e);
            Ok(())
        }
    }
}
