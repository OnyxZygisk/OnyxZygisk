// src/constants.rs

//! Defines global constants, enums, and bitflags used throughout the project.

use bitflags::bitflags;
use konst::primitive::parse_i32;
use konst::unwrap_ctx;
use log::LevelFilter;
use num_enum::TryFromPrimitive;

// --- Versioning Constants ---
// These are set at compile time from environment variables.

/// The minimum compatible version of APatch.
pub const MIN_APATCH_VERSION: i32 = unwrap_ctx!(parse_i32(env!("MIN_APATCH_VERSION")));
/// The minimum compatible version of KernelSU.
pub const MIN_KSU_VERSION: i32 = unwrap_ctx!(parse_i32(env!("MIN_KSU_VERSION")));
/// The maximum compatible version of KernelSU.
pub const MAX_KSU_VERSION: i32 = unwrap_ctx!(parse_i32(env!("MAX_KSU_VERSION")));
/// The minimum compatible version of Magisk.
pub const MIN_MAGISK_VERSION: i32 = unwrap_ctx!(parse_i32(env!("MIN_MAGISK_VERSION")));
/// The version of the OnyxZygisk daemon itself.
pub const ZKSU_VERSION: &str = env!("ZKSU_VERSION");

// --- Configuration Constants ---

/// The maximum log level for the daemon. Set to `Trace` for debug builds and `Info` for release builds.
#[cfg(debug_assertions)]
pub const MAX_LOG_LEVEL: LevelFilter = LevelFilter::Trace;
#[cfg(not(debug_assertions))]
pub const MAX_LOG_LEVEL: LevelFilter = LevelFilter::Info;

/// The relative path to the directory where Zygisk modules are stored.
pub const PATH_MODULES_DIR: &str = "..";
/// Absolute path to the staging directory KernelSU's `ksud` and APatch's
/// `apd` both extract new/updated modules into, ahead of swapping them into
/// `PATH_MODULES_DIR` at the next boot. Consulted directly — once that root
/// solution's own "install finished" signal says it is safe to (see
/// `zygiskd::staged_update_ready`) — so a freshly installed or updated
/// module can become injectable on the very next process fork instead of
/// requiring a reboot.
pub const PATH_MODULES_UPDATE_DIR: &str = "/data/adb/modules_update";
/// APatch's global "an install/update just finished" flag (`apd`'s own
/// `mark_update`), written as the last step of installing or updating any
/// module.
pub const PATH_APATCH_UPDATE_FLAG: &str = "/data/adb/ap/update";
/// The name of the FN (Functional Node) directory inside the daemon work directory.
pub const PATH_FN_DIR: &str = "fn";

// --- IPC Constants ---
// These are magic numbers used in communication with the controller.

/// IPC code indicating that Zygote has been successfully injected.
pub const ZYGOTE_INJECTED: i32 = 4;
/// IPC code for sending daemon status information.
pub const DAEMON_SET_INFO: i32 = 5;
/// IPC code for sending daemon error information.
pub const DAEMON_SET_ERROR_INFO: i32 = 6;
/// IPC code indicating that the Android system server has started.
pub const SYSTEM_SERVER_STARTED: i32 = 7;

/// Defines the set of actions that can be requested from the daemon over its main Unix socket.
///
/// New variants are appended at the end only, so that a controller built
/// against an older protocol revision stays wire-compatible.
#[derive(Debug, Eq, PartialEq, TryFromPrimitive, Copy, Clone)]
#[repr(u8)]
pub enum DaemonSocketAction {
    PingHeartbeat,
    GetProcessFlags,
    CacheMountNamespace,
    UpdateMountNamespace,
    ReadModules,
    RequestCompanionSocket,
    GetModuleDir,
    ZygoteRestart,
    SystemServerStarted,
    ListFnNodes,
    SetFnNodeEnabled,
    RemoveFnNode,
    /// Streams the active FN entry libraries (with scope metadata) as memfds.
    ReadFnModules,
    /// Opens an FN node's directory by node id.
    GetFnModuleDir,
}

bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct ProcessFlags: u32 {
        /// The process has been granted root privileges.
        const PROCESS_GRANTED_ROOT = 1 << 0;
        /// The process is on the denylist and module mounts should be hidden.
        const PROCESS_ON_DENYLIST = 1 << 1;
        /// Mount mode "namespace switch": hide by setns-ing denylisted apps into
        /// the cached clean namespace instead of unmounting from zygote. Neither
        /// this nor MOUNT_MODE_GLOBAL set = "revert only" (unmount from zygote).
        const MOUNT_MODE_SETNS = 1 << 2;
        /// Mount mode "global": mount modules into every app, never unmount for
        /// the denylist. Only su/root visibility is hidden.
        const MOUNT_MODE_GLOBAL = 1 << 3;
        /// The process is the root manager application itself.
        const PROCESS_IS_MANAGER = 1 << 27;
        /// The active root solution is APatch.
        const PROCESS_ROOT_IS_APATCH = 1 << 28;
        /// The active root solution is KernelSU.
        const PROCESS_ROOT_IS_KSU = 1 << 29;
        /// The active root solution is Magisk.
        const PROCESS_ROOT_IS_MAGISK = 1 << 30;
    }
}
