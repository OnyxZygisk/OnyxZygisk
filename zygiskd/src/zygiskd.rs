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
use crate::r#fn;
use crate::mount::{MountNamespace, MountNamespaceManager};
use crate::utils::{self, UnixStreamExt};
use crate::{constants, lp_select, root_impl};
use anyhow::{Context as AnyhowContext, Result, bail};
use log::{debug, error, info, trace, warn};
use passfd::FdPassingExt;
use rustix::io::{FdFlags, fcntl_setfd};
use std::fs;
use std::io::{Error, ErrorKind};
use std::os::fd::AsRawFd;
use std::os::fd::{AsFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::{
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
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
    // Cross-boot circuit breaker: resolve a hot-plug restart guard left over
    // from a crashed session BEFORE any module library is served.
    resolve_stale_restart_guard();
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
            handle_hotplug_restart_guard();
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

fn refresh_controller_info() {
    match load_modules(false).and_then(|modules| send_startup_info(&modules)) {
        Ok(()) => info!("Hot-plug: refreshed runtime module status"),
        Err(e) => warn!("Hot-plug: failed to refresh runtime module status: {}", e),
    }
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
            || dir.join("zygisk/armeabi-v7a.so").exists()
            || dir.join("zygisk/x86_64.so").exists()
            || dir.join("zygisk/x86.so").exists())
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
    Path::new(TMP_PATH.get().unwrap())
        .join("hotplug")
        .join(name)
        .exists()
}

/// Master switch for the whole hot-plug feature (`WORKDIR/hotplug_off`
/// present). When off, every per-module opt-in is ignored and staged updates
/// only take effect through the root solution's own boot-time swap — i.e. a
/// reboot. Absent by default, so hot-plug is on out of the box.
fn hotplug_master_enabled() -> bool {
    !Path::new(TMP_PATH.get().unwrap())
        .join("hotplug_off")
        .exists()
}

fn valid_module_id(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// Cross-process lock: both ABI daemons and the WebUI CLI can activate a
/// module concurrently, so a process-local Mutex cannot protect the swap.
struct HotplugFileLock(fs::File);

impl Drop for HotplugFileLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn acquire_hotplug_lock() -> Result<HotplugFileLock> {
    let work = Path::new(TMP_PATH.get().unwrap());
    fs::create_dir_all(work)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(work.join("hotplug.lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(Error::last_os_error()).context("failed to lock hot-plug transaction");
    }
    Ok(HotplugFileLock(file))
}

fn activation_markers() -> PathBuf {
    Path::new(TMP_PATH.get().unwrap()).join("hotplug_activated")
}

fn activation_marker(name: &str, suffix: &str) -> PathBuf {
    activation_markers().join(format!("{name}.{suffix}"))
}

fn write_activation_marker(name: &str, suffix: &str) {
    let marker = activation_marker(name, suffix);
    if let Some(parent) = marker.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(marker, b"1");
}

fn clear_activation_markers(name: &str) {
    for suffix in ["post_fs_data", "service", "restarted", "applying", "state"] {
        let _ = fs::remove_file(activation_marker(name, suffix));
    }
}

/// Move a complete staged module into the real active directory with rollback.
fn swap_staged_module(name: &str, module_dir: &Path) -> Result<PathBuf> {
    if !valid_module_id(name) {
        bail!("invalid hot-plug module id: {name}");
    }
    let expected = Path::new(constants::PATH_MODULES_UPDATE_DIR).join(name);
    if module_dir != expected || !staged_update_ready(name) {
        bail!("staged module {name} is missing or incomplete");
    }

    let _lock = acquire_hotplug_lock()?;
    if !staged_update_ready(name) {
        bail!("staged module {name} was already activated");
    }
    if !fs::symlink_metadata(module_dir)?.file_type().is_dir() {
        bail!(
            "staged module path is not a real directory: {}",
            module_dir.display()
        );
    }

    let active_dir = Path::new(constants::PATH_MODULES_DIR).join(name);
    let backup_dir =
        Path::new(constants::PATH_MODULES_UPDATE_DIR).join(format!(".onyx-hotplug-backup-{name}"));
    if backup_dir.exists() {
        fs::remove_dir_all(&backup_dir).with_context(|| {
            format!(
                "failed to remove stale hot-plug backup {}",
                backup_dir.display()
            )
        })?;
    }

    let had_active = active_dir.exists();
    if had_active {
        if !fs::symlink_metadata(&active_dir)?.file_type().is_dir() {
            bail!(
                "active module path is not a real directory: {}",
                active_dir.display()
            );
        }
        if active_dir.join("disable").exists() && !module_dir.join("disable").exists() {
            fs::write(module_dir.join("disable"), b"")?;
        }
        fs::rename(&active_dir, &backup_dir).with_context(|| {
            format!("failed to preserve active module {}", active_dir.display())
        })?;
    }

    if let Err(swap_error) = fs::rename(module_dir, &active_dir) {
        if had_active {
            if let Err(restore_error) = fs::rename(&backup_dir, &active_dir) {
                error!(
                    "Hot-plug rollback failed for \"{}\": swap={}, restore={}",
                    name, swap_error, restore_error
                );
            }
        }
        return Err(swap_error).with_context(|| {
            format!("failed to move staged module into {}", active_dir.display())
        });
    }

    if had_active {
        if let Err(e) = fs::remove_dir_all(&backup_dir) {
            warn!(
                "Hot-plug: could not remove backup {}: {}",
                backup_dir.display(),
                e
            );
        }
    }

    clear_activation_markers(name);
    write_activation_marker(name, "applying");
    info!(
        "Hot-plug: swapped staged module \"{}\" into the active directory",
        name
    );
    Ok(active_dir)
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
                // Once a module was moved into the active directory by our
                // hot-plug transaction, its per-module switch remains
                // authoritative.  Turning the switch off must actually stop
                // serving the library to newly forked processes; merely
                // removing the preference file while continuing to enumerate
                // every active module made "unplug" ineffective.
                let was_hotplugged = activation_marker(&name, "post_fs_data").exists();
                if was_hotplugged && !hotplug_opted_in(&name) {
                    continue;
                }
                let disabled =
                    module_dir.join("disable").exists() || module_dir.join("remove").exists();
                modules.insert(name, (module_dir, disabled));
            }
        }
    } else {
        warn!(
            "Failed to read modules directory: {}",
            constants::PATH_MODULES_DIR
        );
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

fn parse_daemon_nice_name(script: &str) -> Option<String> {
    let marker = "--nice-name=";
    let start = script.find(marker)? + marker.len();
    let rest = &script[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
        .unwrap_or(rest.len());
    let name = rest[..end].trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn process_cmdline_matches<F>(mut pred: F) -> bool
where
    F: FnMut(&[String]) -> bool,
{
    let Ok(dir) = fs::read_dir("/proc") else {
        return false;
    };
    for entry in dir.flatten() {
        if entry.file_name().to_string_lossy().parse::<i32>().is_err() {
            continue;
        }
        let Ok(cmdline) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if cmdline.is_empty() {
            continue;
        }
        let args: Vec<String> = cmdline
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        if pred(&args) {
            return true;
        }
    }
    false
}

fn module_daemon_running(module_dir: &Path, nice_name: Option<&str>) -> bool {
    let daemon_path = module_dir.join("daemon").to_string_lossy().into_owned();
    process_cmdline_matches(|args| {
        if let Some(first) = args.first() {
            if nice_name.is_some_and(|name| first == name) {
                return true;
            }
        }
        args.iter().any(|arg| arg == &daemon_path)
    })
}

/// Some modules start a long-lived daemon from service.sh and swallow its
/// stderr (Vector's daemon redirects app_process to /dev/null). If service.sh
/// was invoked from a live hot-plug transaction but the daemon process never
/// appears, retry the module's daemon directly from the real active directory
/// and keep its early stderr in WORKDIR/hotplug_activated/<id>.daemon.log.
fn ensure_module_daemon_started(name: &str, module_dir: &Path) {
    let daemon = module_dir.join("daemon");
    if !daemon.is_file() {
        return;
    }

    let script = fs::read_to_string(&daemon).unwrap_or_default();
    let nice_name = parse_daemon_nice_name(&script);
    thread::sleep(Duration::from_secs(1));
    if module_daemon_running(module_dir, nice_name.as_deref()) {
        info!(
            "Hot-plug: daemon for \"{}\" is running{}",
            name,
            nice_name
                .as_deref()
                .map(|n| format!(" ({n})"))
                .unwrap_or_default()
        );
        return;
    }

    warn!(
        "Hot-plug: daemon for \"{}\" did not appear after service.sh; retrying direct start",
        name
    );
    let log_path = activation_marker(name, "daemon.log");
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();
    let stdout = log_file
        .as_ref()
        .and_then(|file| file.try_clone().ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let stderr = log_file
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);

    let mut command = Command::new("sh");
    command.arg(&daemon);
    if script.contains("system-server-max-retry") || nice_name.as_deref() == Some("vectord") {
        command.arg("--system-server-max-retry=3");
    }

    match command
        .current_dir(module_dir)
        .env("MODDIR", module_dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
    {
        Ok(child) => info!(
            "Hot-plug: spawned fallback daemon for \"{}\" as pid {}",
            name,
            child.id()
        ),
        Err(e) => warn!(
            "Hot-plug: failed to spawn fallback daemon for \"{}\": {}",
            name, e
        ),
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
    let dir = match swap_staged_module(name, module_dir) {
        Ok(dir) => dir,
        Err(e) => {
            warn!(
                "Hot-plug: failed to activate staged module \"{}\": {:#}",
                name, e
            );
            return;
        }
    };

    let name = name.to_string();
    info!(
        "Hot-plug: scheduling lifecycle scripts for swapped module \"{}\"",
        name
    );
    std::thread::spawn(move || {
        let post = dir.join("post-fs-data.sh");
        if post.is_file() {
            run_module_script(&dir, &post);
        }
        write_activation_marker(&name, "post_fs_data");

        if system_server_ready() {
            let service = dir.join("service.sh");
            if service.is_file() {
                run_module_script(&dir, &service);
            }
            ensure_module_daemon_started(&name, &dir);
            write_activation_marker(&name, "service");
            let _ = fs::write(activation_marker(&name, "state"), b"1");
            let _ = fs::remove_file(activation_marker(&name, "applying"));
            refresh_controller_info();
            reboot_device_to_activate(&name, false);
        } else {
            // run_pending_staged_services() finishes service + restart later.
            let _ = fs::remove_file(activation_marker(&name, "applying"));
        }
    });
}

/// Apply the WebUI's current per-module hot-plug preference immediately.
pub fn apply_hotplug(tmp_path: Option<&str>, name: &str) -> Result<()> {
    initialize_globals(tmp_path)?;
    if !valid_module_id(name) {
        bail!("invalid hot-plug module id: {name}");
    }

    let enabled = hotplug_opted_in(name);
    if enabled && !hotplug_master_enabled() {
        bail!("hot-plug master switch is disabled");
    }

    let active_dir = Path::new(constants::PATH_MODULES_DIR).join(name);
    if enabled && active_dir.join("remove").exists() {
        bail!("module {name} is pending removal");
    }

    // The hot-plug preference and the root manager's `disable` marker are
    // separate files.  KernelSU safe mode (or a previous manual disable) can
    // therefore leave the switch visually on while every module scan skips
    // the library.  An explicit ON request means "make this module active",
    // so reconcile the real module state before swapping/serving it.  The UI
    // presents a disabled+opted-in module as unchecked, making this action an
    // intentional second click rather than silently overriding safe mode.
    let reenabled = enabled && active_dir.join("disable").exists();
    if reenabled {
        fs::remove_file(active_dir.join("disable"))
            .with_context(|| format!("failed to re-enable module {name}"))?;
        let _ = fs::remove_file(activation_marker(name, "crash_blocked"));
        info!(
            "Hot-plug: removed stale disable marker for module \"{}\"",
            name
        );
    }
    let mut swapped = false;
    if enabled && staged_update_ready(name) {
        let staged_dir = Path::new(constants::PATH_MODULES_UPDATE_DIR).join(name);
        swap_staged_module(name, &staged_dir)?;
        swapped = true;
    }

    if enabled && !active_dir.is_dir() {
        bail!("module {name} is not installed in the active directory");
    }

    if swapped {
        let post = active_dir.join("post-fs-data.sh");
        if post.is_file() {
            run_module_script(&active_dir, &post);
        }
        write_activation_marker(name, "post_fs_data");

        if !system_server_ready() {
            let _ = fs::remove_file(activation_marker(name, "applying"));
            bail!("system_server is not ready; service activation was deferred");
        }
        let service = active_dir.join("service.sh");
        if service.is_file() {
            run_module_script(&active_dir, &service);
        }
        ensure_module_daemon_started(name, &active_dir);
        write_activation_marker(name, "service");
        let _ = fs::remove_file(activation_marker(name, "applying"));
    }

    // The WebUI writes the preference before invoking this CLI.  Persist it
    // for status/recovery, but do not use the old value to suppress an
    // explicit request: the preference may have been changed by the restart
    // guard or safe mode while this marker still says `1`.  That stale-state
    // combination made turning the visible switch back on a no-op.  The
    // per-system_server PID marker in reboot_device_to_activate provides the
    // correct idempotency for duplicate bridge deliveries.
    let state_marker = activation_marker(name, "state");
    let target_state = if enabled { "1" } else { "0" };
    fs::write(&state_marker, target_state.as_bytes())?;

    refresh_controller_info();
    if !reboot_device_to_activate(name, true) {
        bail!("device could not be rebooted to apply the change");
    }
    Ok(())
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

fn hotplug_restart_guard() -> PathBuf {
    Path::new(TMP_PATH.get().unwrap()).join("hotplug_restart_guard")
}

/// Stable identifier for the current kernel boot.  Unlike process IDs this
/// cannot accidentally compare equal across two reboots, and both ABI daemon
/// instances see the same value.
fn current_boot_id() -> Option<String> {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.contains(':'))
}

/// Startup half of the hot-plug circuit breaker.
///
/// `handle_hotplug_restart_guard` can only advance while the daemon is alive
/// to see `SystemServerStarted` events, so every boot re-evaluates whatever
/// guard the previous session left behind (post-fs-data deliberately no
/// longer deletes it):
///
/// The guard contains the kernel boot UUID, so the 32-bit and 64-bit daemons
/// can distinguish "another daemon started in this boot" from "the device
/// booted again".  Without it, daemon #1 changed `rebooting` to `confirming`
/// and daemon #2 immediately treated that as a second reboot and unplugged
/// the module.
///
/// - `rebooting` — on the first *different* boot, keep the module active and
///   advance to `confirming`; the first SystemServerStarted of this boot will
///   move it to `observing`.
///   Also clear the `restarted` marker here: it was written by the previous
///   session to dedupe the reboot request, and the reboot has now happened,
///   so leaving it would make a later apply_hotplug no-op even though the
///   module is only just being activated this boot.
/// - `confirming` — the device rebooted AGAIN before the framework ever
///   confirmed itself: the module broke the boot path (e.g. a zygote crash
///   escalated by init).  Unplug it before its library is served anywhere.
/// - `observing` — a full reboot crossed the restart/stability window
///   (crash evidence, e.g. `zygote reboot by service`).  Unplug.
///
/// Better one false positive (the user re-enables the switch) than an
/// infinite boot loop.
fn resolve_stale_restart_guard() {
    let guard = hotplug_restart_guard();
    let Ok(content) = fs::read_to_string(&guard) else {
        return; // No guard: the previous session ended cleanly.
    };
    let Some(boot_id) = current_boot_id() else {
        // Never disable a module merely because the kernel boot identity was
        // unavailable.  The live PID-based guard still handles framework
        // restarts inside this boot.
        warn!("Hot-plug: kernel boot id is unavailable; skipping cross-boot guard resolution");
        return;
    };
    let mut parts = content.trim().split(':');
    let (stage, name) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let recorded_boot = parts.next().unwrap_or("").trim();
    if !valid_module_id(name) {
        let _ = fs::remove_file(&guard);
        return;
    }

    // v1.0.6 initially stored only a decimal system_server PID.  It cannot
    // identify a boot reliably, so discard that legacy guard instead of
    // falsely unplugging a healthy module after upgrading this fix.
    if recorded_boot.parse::<i32>().is_ok() || recorded_boot.is_empty() {
        warn!(
            "Hot-plug: discarding legacy restart guard for module \"{}\"",
            name
        );
        let _ = fs::remove_file(&guard);
        let _ = fs::remove_file(activation_marker(name, "restarted"));
        return;
    }
    match stage {
        "rebooting" => {
            if recorded_boot == boot_id {
                // The reboot command was issued in this boot and another ABI
                // daemon reached startup before shutdown completed.
                return;
            }
            info!(
                "Hot-plug: booting to activate module \"{}\"; awaiting framework confirmation",
                name
            );
            // The cold reboot requested by the previous session has now
            // happened, so the `restarted` marker it wrote to dedupe that
            // request is no longer meaningful.  Clear it so a later
            // apply_hotplug on this boot (WebUI reconnect, root bridge
            // reattach) can re-arm if needed instead of no-oping on the
            // stale marker.
            let _ = fs::remove_file(activation_marker(name, "restarted"));
            let _ = fs::write(&guard, format!("confirming:{name}:{boot_id}").as_bytes());
        }
        "confirming" | "observing" if recorded_boot == boot_id => {
            // A second ABI daemon (or a daemon restart) in the same kernel
            // boot is not crash evidence.  Leave the live guard untouched.
        }
        "confirming" | "observing" => {
            error!(
                "Hot-plug: restart guard \"{}:{}\" survived a reboot; unplugging module \"{}\" as the likely crash cause",
                stage, name, name
            );
            let _ = fs::remove_file(
                Path::new(TMP_PATH.get().unwrap())
                    .join("hotplug")
                    .join(name),
            );
            let _ = fs::write(activation_marker(name, "state"), b"0");
            let _ = fs::write(activation_marker(name, "crash_blocked"), b"1");
            let _ = fs::remove_file(&guard);
        }
        _ => {
            let _ = fs::remove_file(&guard);
        }
    }
}

/// Circuit breaker for a module that makes system_server crash immediately
/// after hot-plugging.  The first SystemServerStarted after our intentional
/// cold reboot (guard stage `rebooting`/`confirming`) begins a stability
/// window.  A second, different PID inside that window means the framework
/// restarted again without a user request: unplug the module so the device
/// can recover on the next (user-initiated) reboot.
///
/// NOTE: the old soft-restart path used to SIGKILL system_server here to
/// force a respawn from the now-unplugged module list.  With the cold-reboot
/// activation model that is wrong — killing system_server IS a soft restart,
/// which is exactly what we are trying to avoid.  The unplugged module is
/// already gone from the active list, so the next ordinary app fork will be
/// served without it; no kill is needed or safe.
fn handle_hotplug_restart_guard() {
    let guard = hotplug_restart_guard();
    let Ok(contents) = fs::read_to_string(&guard) else {
        return;
    };
    let mut parts = contents.trim().split(':');
    let Some(stage) = parts.next() else { return };
    let Some(name) = parts.next() else { return };
    let Some(recorded_boot) = parts.next() else {
        return;
    };
    let recorded_pid = parts.next().and_then(|p| p.parse::<i32>().ok());
    let Some(boot_id) = current_boot_id() else {
        return;
    };
    if !valid_module_id(name) {
        let _ = fs::remove_file(&guard);
        return;
    }
    let Some(current_pid) = pidof_system_server() else {
        return;
    };

    if stage == "rebooting" {
        // Still in the boot that requested the cold reboot.  Do not turn an
        // unrelated SystemServerStarted event into a successful activation.
        if recorded_boot == boot_id {
            return;
        }
    } else if stage != "confirming" || recorded_boot != boot_id {
        if stage != "observing" || recorded_boot != boot_id || recorded_pid == Some(current_pid) {
            return;
        }

        warn!(
            "Hot-plug: detected system_server restart loop after activating \"{}\"; automatically unplugging it",
            name
        );
        let _ = fs::remove_file(
            Path::new(TMP_PATH.get().unwrap())
                .join("hotplug")
                .join(name),
        );
        let _ = fs::write(activation_marker(name, "state"), b"0");
        let _ = fs::write(activation_marker(name, "crash_blocked"), b"1");
        let _ = fs::remove_file(&guard);
        refresh_controller_info();
        return;
    }

    // `confirming` belongs to this boot (or `rebooting` was recovered before
    // startup resolution).  PID values commonly repeat across cold boots, so
    // the boot UUID, not PID inequality, is what proves activation booted.
    {
        let observing = format!("observing:{name}:{boot_id}:{current_pid}");
        if fs::write(&guard, observing.as_bytes()).is_err() {
            return;
        }
        let guard_clone = guard.clone();
        let name_clone = name.to_string();
        let boot_clone = boot_id;
        let pid_clone = current_pid;
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(30));
            let expected = format!("observing:{name_clone}:{boot_clone}:{pid_clone}");
            if fs::read_to_string(&guard_clone)
                .map(|value| value.trim() == expected)
                .unwrap_or(false)
                && pidof_system_server() == Some(pid_clone)
            {
                // Activation succeeded and the framework stayed up.  Clear
                // the restart marker too so a later apply_hotplug (WebUI
                // reconnect, root bridge reattach) does not no-op on the
                // stale `restarted` marker and can re-arm if the user
                // toggles the module again.
                let _ = fs::remove_file(&guard_clone);
                let _ = fs::remove_file(activation_marker(&name_clone, "restarted"));
                info!(
                    "Hot-plug: system_server pid {} remained stable after activating \"{}\"; restart marker cleared",
                    pid_clone, name_clone
                );
            }
        });
        return;
    }
}

/// Activate a freshly hot-plugged framework module (LSPosed) by rebooting
/// the device.  The module must be loaded at the fresh system_server
/// fork/specialize — the ONLY point a framework module activates — and we
/// used to get that cheaply by killing system_server (a ~15s framework
/// "soft reboot").  That proved unsafe: a module that misbehaves on the
/// soft-restarted framework makes zygote/netd restart repeatedly, and
/// Android init escalates that into a hard reboot — looping the device.
/// A full cold reboot re-runs the entire injection chain against a fresh
/// zygote — the same, well-tested path a module takes after a normal
/// install — and reliably lands the module in the new system_server.
///
/// Guarded by a one-shot marker so it happens once per hot-plug, never on
/// an ordinary boot (where the module is already active and no swap runs).
fn reboot_device_to_activate(name: &str, force: bool) -> bool {
    // Serialize marker inspection and PID reservation across the 32/64-bit
    // daemons plus WebUI CLI processes.  The old check-then-kill sequence was
    // racy: several concurrent module scans could all observe a missing marker
    // and kill system_server in succession.
    let _lock = match acquire_hotplug_lock() {
        Ok(lock) => lock,
        Err(e) => {
            warn!("Hot-plug: failed to lock system_server restart: {}", e);
            return false;
        }
    };
    let marker = activation_marker(name, "restarted");
    if marker.exists() && !force {
        return true;
    }
    match pidof_system_server() {
        Some(pid) => {
            // Reserve this exact system_server generation before triggering
            // the reboot.  A duplicate explicit request racing with us sees
            // the same PID in the marker and becomes a no-op.  A later
            // legitimate state transition sees a different PID and may
            // reboot once.
            if fs::read_to_string(&marker)
                .ok()
                .and_then(|value| value.trim().parse::<i32>().ok())
                == Some(pid)
            {
                info!(
                    "Hot-plug: system_server pid {} was already reserved for restart",
                    pid
                );
                return true;
            }
            if fs::write(&marker, pid.to_string().as_bytes()).is_err() {
                warn!("Hot-plug: failed to reserve system_server restart marker");
                return false;
            }
            // Mark the reboot as intentional: resolve_stale_restart_guard
            // turns this into "confirming" at the next boot, so only a
            // framework that then fails to stabilize gets the module
            // unplugged.
            let Some(boot_id) = current_boot_id() else {
                let _ = fs::remove_file(&marker);
                warn!("Hot-plug: kernel boot id is unavailable; refusing an unguarded reboot");
                return false;
            };
            let guard = format!("rebooting:{name}:{boot_id}:{pid}");
            if fs::write(hotplug_restart_guard(), guard.as_bytes()).is_err() {
                let _ = fs::remove_file(&marker);
                warn!("Hot-plug: failed to arm the system_server restart guard");
                return false;
            }
            info!(
                "Hot-plug: rebooting device to activate framework module \"{}\" (system_server pid {})",
                name, pid
            );
            // Graceful reboot via init (stops services, syncs, unmounts).
            // Fall back to the toybox reboot binary if the property cannot
            // be set.
            if let Err(e) = utils::set_property("sys.powerctl", "reboot") {
                warn!(
                    "Hot-plug: sys.powerctl reboot failed ({}); falling back to `reboot`",
                    e
                );
                let _ = Command::new("reboot").status();
            }
            true
        }
        None => {
            warn!(
                "Hot-plug: system_server pid not found; cannot reboot to activate \"{}\"",
                name
            );
            false
        }
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
        // Atomically claim the deferred lifecycle job before spawning it.
        // load_modules() is called concurrently by many forks, so checking a
        // marker without creating it here schedules service.sh many times.
        let applying = markers.join(format!("{name}.applying"));
        match fs::OpenOptions::new().write(true).create_new(true).open(&applying) {
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => {
                warn!("Hot-plug: failed to claim deferred service for \"{}\": {}", name, e);
                continue;
            }
        }
        let dir_clone = active_dir.clone();
        let marker_clone = markers.join(format!("{name}.service"));
        let applying_clone = applying.clone();
        let name_clone = name.to_string();
        std::thread::spawn(move || {
            let p = dir_clone.join("service.sh");
            if p.is_file() {
                run_module_script(&dir_clone, &p);
            }
            ensure_module_daemon_started(&name_clone, &dir_clone);
            let _ = fs::write(&marker_clone, b"1");
            let _ = fs::write(activation_marker(&name_clone, "state"), b"1");
            let _ = fs::remove_file(&applying_clone);
            // Reboot once so this freshly hot-plugged framework module
            // activates at specialize. See reboot_device_to_activate.
            refresh_controller_info();
            reboot_device_to_activate(&name_clone, false);
        });
        info!(
            "Hot-plug: scheduling deferred service.sh for swapped module \"{}\"",
            name
        );
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

    flags |= mount_mode_flag();

    trace!("Flags for UID {}: {:?}", uid, flags);
    stream.write_u32(flags.bits())?;
    Ok(())
}

/// The user-selected mount mode, read fresh from `WORKDIR/mount_mode` (so a
/// change takes effect on the next app launch, no restart). Values: `setns`,
/// `global`, or anything else / missing = the default "revert only". Rides
/// along in the process flags so the loader can apply it per fork.
fn mount_mode_flag() -> ProcessFlags {
    let path = Path::new(TMP_PATH.get().unwrap()).join("mount_mode");
    match fs::read_to_string(path).ok().as_deref().map(str::trim) {
        Some("setns") => ProcessFlags::MOUNT_MODE_SETNS,
        Some("global") => ProcessFlags::MOUNT_MODE_GLOBAL,
        _ => ProcessFlags::empty(), // "revert" (default)
    }
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
            error!(
                "Failed to send companion socket FD for module `{}`: {}",
                name, e
            );
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
    let lib_path = node.dir.join(entry);
    let lib_fd = create_library_fd(Path::new(&lib_path))?;

    let companions = &mut *context.fn_companions.lock().unwrap();
    let cell = companions.entry(node.id.clone()).or_default();
    let mut companion = cell.lock().unwrap();
    if let Some(sock) = companion.as_ref() {
        if !utils::is_socket_alive(sock) {
            error!(
                "Companion for FN node `{}` appears to have crashed.",
                node.id
            );
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
                warn!(
                    "FN node `{}` does not have a companion entry point.",
                    node.id
                );
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
        fs::File::open(&node.dir)?
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
        let lib_path = node.dir.join(entry);
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
