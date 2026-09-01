// src/fn.rs

//! FN (Functional Node) module support for the OnyxZygisk daemon.
//!
//! FN nodes are declarative, scoped, hot-swappable units of functionality that
//! live under `<work-dir>/fn/<node-id>/`. This module scans and validates the
//! node directory, mutates the state-flag files (`disable`, `remove`), installs
//! node zips, runs node scripts at boot stages, and serializes the node list
//! for the daemon's IPC socket. See `docs/FN.md` for the authoritative format
//! specification.

use anyhow::{Context, Result, bail};
use log::{debug, info, warn};
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::constants;

/// Targeting scope of an FN node, declared by the `scope` key in `fn.prop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FnScope {
    /// The node applies to every app.
    All,
    /// The node applies only to the packages listed in `apps`.
    Allowlist,
    /// The node applies to every app except the packages listed in `apps`.
    Denylist,
}

impl FnScope {
    /// Stable wire representation used in the serialized node list.
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            FnScope::All => "all",
            FnScope::Allowlist => "allowlist",
            FnScope::Denylist => "denylist",
        }
    }
}

/// Scan-time status of an FN node, computed by the daemon (never inferred by the UI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FnStatus {
    Enabled,
    Disabled,
    PendingRemove,
    PendingUpdate,
    Malformed(String),
}

impl FnStatus {
    /// Stable wire representation used in the serialized node list.
    pub fn as_wire_str(&self) -> String {
        match self {
            FnStatus::Enabled => "enabled".to_string(),
            FnStatus::Disabled => "disabled".to_string(),
            FnStatus::PendingRemove => "pending_remove".to_string(),
            FnStatus::PendingUpdate => "pending_update".to_string(),
            FnStatus::Malformed(reason) => format!("malformed:{}", reason),
        }
    }
}

/// A single FN node discovered on disk, with its descriptor parsed from `fn.prop`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FnNode {
    pub id: String,
    /// On-disk node directory. This may be either workdir/fn/<id> or a
    /// standard Magisk module directory under /data/adb/modules/<id>.
    pub dir: PathBuf,
    pub name: String,
    pub version: String,
    pub version_code: i32,
    pub author: String,
    pub description: String,
    /// Native entry library path relative to the node dir, if declared.
    pub entry: Option<String>,
    /// Trigger points (e.g. `post_fs_data`, `boot`, `zygote`, `system_server`, `app`).
    pub triggers: Vec<String>,
    pub scope: FnScope,
    pub apps: Vec<String>,
    pub priority: i32,
    pub capabilities: Vec<String>,
    pub ui_summary: Option<String>,
    pub status: FnStatus,
}

/// Returns the directory holding all FN nodes for a given daemon work directory.
fn fn_root(work_dir: &str) -> PathBuf {
    Path::new(work_dir).join(constants::PATH_FN_DIR)
}

fn is_standard_magisk_module(dir: &Path) -> bool {
    dir.parent().is_some_and(|parent| {
        parent == Path::new(constants::PATH_MAGISK_MODULES_DIR)
    })
}

/// Checks that a node id is safe and spec-compliant (`[a-z0-9_\-]`).
///
/// Besides enforcing the spec, this prevents path traversal when the id
/// arrives over the IPC socket.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Parses a `key=value` property file (same syntax as `module.prop`).
fn parse_props(content: &str) -> HashMap<String, String> {
    let mut props = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            props.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    props
}

/// Splits a comma-separated list value, dropping empty items.
fn parse_list(value: Option<&String>) -> Vec<String> {
    value
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Parses and validates a single node directory. Never fails: invalid
/// descriptors yield a node with a `Malformed` status so the UI can offer
/// to remove the broken node.
fn parse_fn_node(dir: &Path) -> FnNode {
    let id = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let disabled = dir.join("disable").exists();
    let updated = dir.join("update").exists();

    let malformed = |reason: &str| FnNode {
        id: id.clone(),
        dir: dir.to_path_buf(),
        name: id.clone(),
        version: String::new(),
        version_code: 0,
        author: String::new(),
        description: String::new(),
        entry: None,
        triggers: Vec::new(),
        scope: FnScope::All,
        apps: Vec::new(),
        priority: 100,
        capabilities: Vec::new(),
        ui_summary: None,
        status: FnStatus::Malformed(reason.to_string()),
    };

    let prop_path = dir.join("fn.prop");
    let content = match fs::read_to_string(&prop_path) {
        Ok(content) => content,
        Err(e) => return malformed(&format!("unreadable fn.prop: {}", e)),
    };
    let props = parse_props(&content);

    // Required keys: id, name, version, versionCode.
    let declared_id = match props.get("id") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return malformed("missing id"),
    };
    if !is_valid_id(&declared_id) {
        return malformed("invalid id");
    }
    if declared_id != id {
        return malformed("id does not match directory name");
    }
    let name = match props.get("name") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return malformed("missing name"),
    };
    let version = match props.get("version") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return malformed("missing version"),
    };
    let version_code = match props.get("versionCode").map(|v| v.parse::<i32>()) {
        Some(Ok(value)) => value,
        _ => return malformed("invalid versionCode"),
    };

    // Optional keys.
    let entry = props.get("entry").filter(|v| !v.is_empty()).cloned();
    let triggers = match props.get("trigger") {
        Some(_) => parse_list(props.get("trigger")),
        None => vec!["app".to_string()],
    };
    let scope = match props.get("scope").map(String::as_str) {
        None | Some("all") => FnScope::All,
        Some("allowlist") => FnScope::Allowlist,
        Some("denylist") => FnScope::Denylist,
        Some(other) => return malformed(&format!("invalid scope `{}`", other)),
    };
    let apps = parse_list(props.get("apps"));
    let priority = props
        .get("priority")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(100);
    let capabilities = parse_list(props.get("capabilities"));
    let ui_summary = props.get("ui.summary").filter(|v| !v.is_empty()).cloned();

    // A node must have an entry library or at least one script.
    let has_entry = match &entry {
        Some(entry) => dir.join(entry).is_file(),
        None => false,
    };
    let has_script = dir.join("service.sh").is_file() || dir.join("post-fs-data.sh").is_file();
    if !has_entry && !has_script {
        return malformed("no entry library or script");
    }

    let status = if updated {
        FnStatus::PendingUpdate
    } else if disabled {
        FnStatus::Disabled
    } else {
        FnStatus::Enabled
    };

    FnNode {
        id,
        dir: dir.to_path_buf(),
        name,
        version,
        version_code,
        author: props.get("author").cloned().unwrap_or_default(),
        description: props.get("description").cloned().unwrap_or_default(),
        entry,
        triggers,
        scope,
        apps,
        priority,
        capabilities,
        ui_summary,
        status,
    }
}

/// Sweeps the FN node directory: deletes nodes flagged with `remove`, parses
/// the remaining descriptors, and returns the nodes sorted by priority then id.
pub fn scan_fn_nodes(work_dir: &str) -> Vec<FnNode> {
    let mut nodes = Vec::new();
    let roots = [
        fn_root(work_dir),
        Path::new(constants::PATH_MAGISK_MODULES_DIR).to_path_buf(),
    ];
    let mut seen_ids = std::collections::HashSet::new();

    for root in roots {
        let dir = match fs::read_dir(&root) {
            Ok(dir) => dir,
            Err(e) => {
                debug!("Failed to read FN node directory {:?}: {}", root, e);
                continue;
            }
        };

        for entry in dir.flatten() {
            let path = entry.path();
            if !path.is_dir()
                || (is_standard_magisk_module(&path) && !path.join("fn.prop").is_file())
            {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !seen_ids.insert(id.clone()) {
                continue;
            }

            if path.join("remove").exists() && is_standard_magisk_module(&path) {
                let mut node = parse_fn_node(&path);
                if !matches!(node.status, FnStatus::Malformed(_)) {
                    node.status = FnStatus::PendingRemove;
                }
                nodes.push(node);
                continue;
            }

            if path.join("remove").exists() {
                match fs::remove_dir_all(&path) {
                    Ok(()) => {
                        info!("Removed FN node `{}`", id);
                        continue;
                    }
                    Err(e) => {
                        warn!("Failed to remove FN node `{}`: {}", id, e);
                        let mut node = parse_fn_node(&path);
                        if !matches!(node.status, FnStatus::Malformed(_)) {
                            node.status = FnStatus::PendingRemove;
                        }
                        nodes.push(node);
                        continue;
                    }
                }
            }

            nodes.push(parse_fn_node(&path));
        }
    }

    nodes.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
    nodes
}

/// Creates or removes the `disable` state flag of a node.
pub fn set_fn_node_enabled(work_dir: &str, id: &str, enabled: bool) -> Result<()> {
    if !is_valid_id(id) {
        bail!("Invalid FN node id: `{}`", id);
    }
    let dir = scan_fn_nodes(work_dir)
        .into_iter()
        .find(|node| node.id == id)
        .map(|node| node.dir)
        .ok_or_else(|| anyhow::anyhow!("FN node `{}` does not exist", id))?;
    let flag = dir.join("disable");
    if enabled {
        match fs::remove_file(&flag) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e).context("Failed to remove disable flag"),
        }
        info!("Enabled FN node `{}`", id);
    } else {
        fs::write(&flag, []).context("Failed to create disable flag")?;
        info!("Disabled FN node `{}`", id);
    }
    Ok(())
}

/// Flags a node with `remove` and immediately sweeps it from disk.
pub fn mark_fn_node_removed(work_dir: &str, id: &str) -> Result<()> {
    if !is_valid_id(id) {
        bail!("Invalid FN node id: `{}`", id);
    }
    let dir = scan_fn_nodes(work_dir)
        .into_iter()
        .find(|node| node.id == id)
        .map(|node| node.dir)
        .ok_or_else(|| anyhow::anyhow!("FN node `{}` does not exist", id))?;
    fs::write(dir.join("remove"), []).context("Failed to create remove flag")?;
    if is_standard_magisk_module(&dir) {
        info!("Marked Magisk FN module `{}` for removal", id);
    } else {
        fs::remove_dir_all(&dir).context("Failed to sweep FN node")?;
        info!("Removed FN node `{}`", id);
    }
    Ok(())
}

/// Serializes the node list as a line-based record stream: `key=value` lines,
/// a blank line between node records, and a terminating empty record.
pub fn serialize_fn_nodes(nodes: &[FnNode]) -> String {
    let mut out = String::new();
    for node in nodes {
        out.push_str(&format!("id={}\n", node.id));
        out.push_str(&format!("name={}\n", node.name));
        out.push_str(&format!("version={}\n", node.version));
        out.push_str(&format!("versionCode={}\n", node.version_code));
        out.push_str(&format!("author={}\n", node.author));
        out.push_str(&format!("description={}\n", node.description));
        if let Some(entry) = &node.entry {
            out.push_str(&format!("entry={}\n", entry));
        }
        out.push_str(&format!("trigger={}\n", node.triggers.join(",")));
        out.push_str(&format!("scope={}\n", node.scope.as_wire_str()));
        out.push_str(&format!("apps={}\n", node.apps.join(",")));
        out.push_str(&format!("priority={}\n", node.priority));
        out.push_str(&format!("capabilities={}\n", node.capabilities.join(",")));
        if let Some(summary) = &node.ui_summary {
            out.push_str(&format!("ui.summary={}\n", summary));
        }
        out.push_str(&format!("status={}\n", node.status.as_wire_str()));
        // Blank line: end of this node's record.
        out.push('\n');
    }
    // Empty record: end of the stream.
    out.push('\n');
    out
}

// --- Installation ---
// The zip install path is currently driven from the daemon's own IPC surface;
// the WebUI-driven entry point (`install_fn_node`) is kept with its tests as
// the canonical programmatic installer.

/// File names allowed at the zip root. State flags (`disable`, `remove`,
/// `update`) are never taken from a zip — they are owned by the daemon.
#[allow(dead_code)]
const ROOT_ALLOWED: &[&str] = &["fn.prop", "service.sh", "post-fs-data.sh"];

/// Returns true for entry names that may be extracted, rejecting path
/// traversal (`..`, absolute paths) and anything outside the whitelist.
#[allow(dead_code)]
fn is_allowed_zip_entry(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') {
        return false;
    }
    if ROOT_ALLOWED.contains(&name) {
        return !name.contains("..");
    }
    // Native entry libraries live under `lib/<abi>/...`.
    if let Some(rest) = name.strip_prefix("lib/") {
        return !rest.is_empty() && !rest.contains("..");
    }
    false
}

/// Installs an FN node from a zip archive (`fn.prop` at the root).
///
/// The archive is fully validated *before* touching the on-disk node: the
/// descriptor must parse and the declared `id` must be spec-compliant. If a
/// node with the same id already exists, its contents are replaced in place
/// (the hot-swap semantics of the `update` flag applied immediately) and the
/// flag is cleared. Returns the freshly scanned node.
#[allow(dead_code)]
pub fn install_fn_node(work_dir: &str, zip_bytes: &[u8]) -> Result<FnNode> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .context("invalid zip archive")?;

    // Read and validate the descriptor first.
    let prop_content = {
        let mut prop_entry = archive.by_name("fn.prop").context("fn.prop missing at zip root")?;
        let mut content = String::new();
        prop_entry.read_to_string(&mut content)?;
        content
    };
    let props = parse_props(&prop_content);
    let id = match props.get("id") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => bail!("fn.prop missing required `id`"),
    };
    if !is_valid_id(&id) {
        bail!("invalid fn node id: `{}`", id);
    }
    if props.get("name").map_or(true, |v| v.is_empty()) {
        bail!("fn.prop missing required `name`");
    }
    if props.get("version").map_or(true, |v| v.is_empty()) {
        bail!("fn.prop missing required `version`");
    }
    if props.get("versionCode").map_or(true, |v| v.parse::<i32>().is_err()) {
        bail!("fn.prop missing or invalid `versionCode`");
    }

    let node_dir = fn_root(work_dir).join(&id);
    if node_dir.is_dir() {
        info!("Updating FN node `{}`", id);
    } else {
        info!("Installing FN node `{}`", id);
    }

    // Validate every entry before mutating the filesystem.
    for i in 0..archive.len() {
        let entry = archive.by_index(i).context("failed to index zip entry")?;
        if entry.is_dir() {
            continue;
        }
        if !is_allowed_zip_entry(entry.name()) {
            bail!("disallowed zip entry: `{}`", entry.name());
        }
    }

    // Replace the on-disk node contents.
    if node_dir.is_dir() {
        fs::remove_dir_all(&node_dir).context("failed to clear existing node")?;
    }
    fs::create_dir_all(&node_dir).context("failed to create node directory")?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).context("failed to index zip entry")?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let dest = node_dir.join(&name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).context("failed to create node subdirectory")?;
        }
        let mut file = fs::File::create(&dest).context("failed to create node file")?;
        std::io::copy(&mut entry, &mut file).context("failed to extract node file")?;

        // Scripts stay executable; libraries and the descriptor are 0644.
        let mode = if name == "service.sh" || name == "post-fs-data.sh" {
            0o755
        } else {
            0o644
        };
        fs::set_permissions(&dest, fs::Permissions::from_mode(mode))
            .context("failed to set node file permissions")?;
    }
    // The `update` flag, if any, was consumed by the direct replacement.
    let _ = fs::remove_file(node_dir.join("update"));

    let node = parse_fn_node(&node_dir);
    if matches!(node.status, FnStatus::Malformed(_)) {
        warn!("Installed FN node `{}` failed validation: {:?}", id, node.status);
    }
    Ok(node)
}

/// Returns the directory that holds a node's scripts, if it exists.
fn script_for_trigger(node_dir: &Path, trigger: &str) -> Option<PathBuf> {
    let name = match trigger {
        "post_fs_data" => "post-fs-data.sh",
        "boot" => "service.sh",
        _ => return None,
    };
    let script = node_dir.join(name);
    script.is_file().then_some(script)
}

/// Runs one node script, feeding its output into the daemon log so it is
/// visible both in logcat and on the WebUI's logs page.
fn run_script_logged(node: &FnNode, script: PathBuf, node_dir: PathBuf) {
    let output = Command::new("sh")
        .arg(&script)
        .current_dir(&node_dir)
        .env("MODDIR", &node_dir)
        .env("ONYX_FN_DAEMON", "1")
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stdout.is_empty() {
                info!("FN `{}` stdout:\n{}", node.id, stdout.trim_end());
            }
            if !stderr.is_empty() {
                warn!("FN `{}` stderr:\n{}", node.id, stderr.trim_end());
            }
            if !output.status.success() {
                warn!(
                    "FN `{}` {} script exited with {}",
                    node.id,
                    script.file_name().unwrap_or_default().to_string_lossy(),
                    output.status
                );
            }
        }
        Err(e) => {
            warn!("Failed to run FN `{}` script {}: {}", node.id, script.display(), e);
        }
    }
}

/// Runs the stage script (`post-fs-data.sh` or `service.sh`) of every enabled
/// workdir node whose `trigger` includes the given stage. Standard Magisk FN
/// modules own these scripts through Magisk's lifecycle and are skipped here,
/// preventing the same script from running twice.
pub fn run_fn_scripts(work_dir: &str, trigger: &str) {
    let script_name = match trigger {
        "post_fs_data" => "post-fs-data.sh",
        "boot" => "service.sh",
        _ => {
            debug!("No script stage for trigger `{}`", trigger);
            return;
        }
    };
    let mut scheduled = 0;
    for node in scan_fn_nodes(work_dir) {
        if node.status != FnStatus::Enabled {
            continue;
        }
        if is_standard_magisk_module(&node.dir) {
            continue;
        }
        if !node.triggers.iter().any(|t| t == trigger) {
            continue;
        }
        let node_dir = node.dir.clone();
        let Some(script) = script_for_trigger(&node_dir, trigger) else {
            continue;
        };
        info!("Scheduling FN `{}` {}", node.id, script_name);
        let node_clone = node;
        let dir_clone = node_dir.clone();
        std::thread::spawn(move || run_script_logged(&node_clone, script, dir_clone));
        scheduled += 1;
    }
    if scheduled > 0 {
        info!("Scheduled {} FN {} script(s)", scheduled, script_name);
    }
}

/// Returns the enabled nodes that declare a native entry library, sorted by
/// priority then id. This is the exact set the loader receives via the
/// `ReadFnModules` socket action, so companion/module-dir index resolution
/// must use the same ordering.
pub fn active_native_nodes(work_dir: &str) -> Vec<FnNode> {
    scan_fn_nodes(work_dir)
        .into_iter()
        .filter(|n| n.status == FnStatus::Enabled && n.entry.is_some())
        .collect()
}

/// Opens the directory of an installed node, for the loader's
/// `GetFnModuleDir` action.
pub fn get_fn_module_dir(work_dir: &str, id: &str) -> Result<fs::File> {
    if !is_valid_id(id) {
        bail!("Invalid FN node id: `{}`", id);
    }
    let dir = scan_fn_nodes(work_dir)
        .into_iter()
        .find(|node| node.id == id)
        .map(|node| node.dir)
        .ok_or_else(|| anyhow::anyhow!("FN node `{}` does not exist", id))?;
    fs::File::open(dir).context("Failed to open FN node directory")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A unique temporary work directory that is deleted on drop.
    struct TempWorkDir(PathBuf);

    impl TempWorkDir {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "zygiskd-fn-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&dir).unwrap();
            TempWorkDir(dir)
        }

        fn work_dir(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }

        /// Creates a node directory with the given `fn.prop` content.
        fn create_node(&self, id: &str, fn_prop: &str) -> PathBuf {
            let dir = self.0.join(constants::PATH_FN_DIR).join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("fn.prop"), fn_prop).unwrap();
            dir
        }
    }

    impl Drop for TempWorkDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const VALID_PROP: &str = "id=test_node\n\
         name=Test Node\n\
         version=1.0\n\
         versionCode=42\n";

    #[test]
    fn parses_full_descriptor() {
        let tmp = TempWorkDir::new();
        let prop = "id=full\n\
             name=Full Node\n\
             version=2.1\n\
             versionCode=7\n\
             author=someone\n\
             description=Does things\n\
             entry=lib/arm64-v8a/fn.so\n\
             trigger=app, zygote\n\
             scope=allowlist\n\
             apps=com.a, com.b\n\
             priority=10\n\
             capabilities=inject, mount\n\
             ui.summary=Nice node\n";
        let dir = tmp.create_node("full", prop);
        fs::create_dir_all(dir.join("lib/arm64-v8a")).unwrap();
        fs::write(dir.join("lib/arm64-v8a/fn.so"), []).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert_eq!(nodes.len(), 1);
        let node = &nodes[0];
        assert_eq!(node.id, "full");
        assert_eq!(node.name, "Full Node");
        assert_eq!(node.version, "2.1");
        assert_eq!(node.version_code, 7);
        assert_eq!(node.author, "someone");
        assert_eq!(node.description, "Does things");
        assert_eq!(node.entry.as_deref(), Some("lib/arm64-v8a/fn.so"));
        assert_eq!(node.triggers, vec!["app", "zygote"]);
        assert_eq!(node.scope, FnScope::Allowlist);
        assert_eq!(node.apps, vec!["com.a", "com.b"]);
        assert_eq!(node.priority, 10);
        assert_eq!(node.capabilities, vec!["inject", "mount"]);
        assert_eq!(node.ui_summary.as_deref(), Some("Nice node"));
        assert_eq!(node.status, FnStatus::Enabled);
    }

    #[test]
    fn applies_defaults_for_optional_keys() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("defaults", &VALID_PROP.replace("test_node", "defaults"));
        fs::write(dir.join("service.sh"), []).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert_eq!(nodes.len(), 1);
        let node = &nodes[0];
        assert_eq!(node.triggers, vec!["app"]);
        assert_eq!(node.scope, FnScope::All);
        assert!(node.apps.is_empty());
        assert_eq!(node.priority, 100);
        assert!(node.capabilities.is_empty());
        assert_eq!(node.ui_summary, None);
        assert_eq!(node.status, FnStatus::Enabled);
    }

    #[test]
    fn script_only_node_is_valid() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("scripted", &VALID_PROP.replace("test_node", "scripted"));
        fs::write(dir.join("post-fs-data.sh"), []).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].status, FnStatus::Enabled);
    }

    #[test]
    fn rejects_node_without_entry_or_script() {
        let tmp = TempWorkDir::new();
        tmp.create_node("empty", &VALID_PROP.replace("test_node", "empty"));

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0].status,
            FnStatus::Malformed("no entry library or script".to_string())
        );
    }

    #[test]
    fn rejects_missing_entry_library() {
        let tmp = TempWorkDir::new();
        let prop = format!("{}entry=lib/arm64-v8a/fn.so\n", VALID_PROP.replace("test_node", "ghost"));
        tmp.create_node("ghost", &prop);

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0].status,
            FnStatus::Malformed("no entry library or script".to_string())
        );
    }

    #[test]
    fn rejects_id_mismatch_and_bad_descriptors() {
        let tmp = TempWorkDir::new();
        // id does not match directory name
        let dir = tmp.create_node("dirname", VALID_PROP);
        fs::write(dir.join("service.sh"), []).unwrap();
        // invalid versionCode
        let dir = tmp.create_node("badver", "id=badver\nname=X\nversion=1\nversionCode=abc\n");
        fs::write(dir.join("service.sh"), []).unwrap();
        // missing required key
        let dir = tmp.create_node("noname", "id=noname\nversion=1\nversionCode=1\n");
        fs::write(dir.join("service.sh"), []).unwrap();
        // invalid scope
        let dir = tmp.create_node(
            "badscope",
            "id=badscope\nname=X\nversion=1\nversionCode=1\nscope=everywhere\n",
        );
        fs::write(dir.join("service.sh"), []).unwrap();
        // missing fn.prop entirely
        let dir = tmp.0.join(constants::PATH_FN_DIR).join("noprop");
        fs::create_dir_all(&dir).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert_eq!(nodes.len(), 5);
        assert!(nodes.iter().all(|n| matches!(n.status, FnStatus::Malformed(_))));
        let by_id: HashMap<_, _> = nodes.iter().map(|n| (n.id.as_str(), &n.status)).collect();
        assert_eq!(
            by_id["dirname"],
            &FnStatus::Malformed("id does not match directory name".to_string())
        );
        assert_eq!(
            by_id["badver"],
            &FnStatus::Malformed("invalid versionCode".to_string())
        );
        assert_eq!(
            by_id["noname"],
            &FnStatus::Malformed("missing name".to_string())
        );
        assert!(matches!(&by_id["badscope"], FnStatus::Malformed(r) if r.starts_with("invalid scope")));
        assert!(matches!(&by_id["noprop"], FnStatus::Malformed(r) if r.starts_with("unreadable fn.prop")));
    }

    #[test]
    fn computes_status_from_state_flags() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("disabled_node", &VALID_PROP.replace("test_node", "disabled_node"));
        fs::write(dir.join("service.sh"), []).unwrap();
        fs::write(dir.join("disable"), []).unwrap();
        let dir = tmp.create_node("updating_node", &VALID_PROP.replace("test_node", "updating_node"));
        fs::write(dir.join("service.sh"), []).unwrap();
        fs::write(dir.join("update"), []).unwrap();
        // update wins over disable
        fs::write(dir.join("disable"), []).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        let by_id: HashMap<_, _> = nodes.iter().map(|n| (n.id.as_str(), &n.status)).collect();
        assert_eq!(by_id["disabled_node"], &FnStatus::Disabled);
        assert_eq!(by_id["updating_node"], &FnStatus::PendingUpdate);
    }

    #[test]
    fn sweeps_remove_flagged_nodes() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("doomed", &VALID_PROP.replace("test_node", "doomed"));
        fs::write(dir.join("service.sh"), []).unwrap();
        fs::write(dir.join("remove"), []).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        assert!(nodes.is_empty());
        assert!(!dir.exists());
    }

    #[test]
    fn sorts_by_priority_then_id() {
        let tmp = TempWorkDir::new();
        for (id, priority) in [("b_low", 50), ("a_low", 50), ("z_default", 100), ("a_first", 1)] {
            let prop = format!(
                "id={}\nname=X\nversion=1\nversionCode=1\npriority={}\n",
                id, priority
            );
            let dir = tmp.create_node(id, &prop);
            fs::write(dir.join("service.sh"), []).unwrap();
        }

        let nodes = scan_fn_nodes(&tmp.work_dir());
        let order: Vec<_> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(order, vec!["a_first", "a_low", "b_low", "z_default"]);
    }

    #[test]
    fn toggles_disable_flag() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("toggle", &VALID_PROP.replace("test_node", "toggle"));
        fs::write(dir.join("service.sh"), []).unwrap();

        set_fn_node_enabled(&tmp.work_dir(), "toggle", false).unwrap();
        assert!(dir.join("disable").exists());
        assert_eq!(scan_fn_nodes(&tmp.work_dir())[0].status, FnStatus::Disabled);

        set_fn_node_enabled(&tmp.work_dir(), "toggle", true).unwrap();
        assert!(!dir.join("disable").exists());
        assert_eq!(scan_fn_nodes(&tmp.work_dir())[0].status, FnStatus::Enabled);

        // Enabling an already-enabled node is a no-op, not an error.
        set_fn_node_enabled(&tmp.work_dir(), "toggle", true).unwrap();

        // Unknown or malicious ids are rejected.
        assert!(set_fn_node_enabled(&tmp.work_dir(), "missing", true).is_err());
        assert!(set_fn_node_enabled(&tmp.work_dir(), "../evil", false).is_err());
    }

    #[test]
    fn marks_node_removed() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("gone", &VALID_PROP.replace("test_node", "gone"));
        fs::write(dir.join("service.sh"), []).unwrap();

        mark_fn_node_removed(&tmp.work_dir(), "gone").unwrap();
        assert!(!dir.exists());
        assert!(scan_fn_nodes(&tmp.work_dir()).is_empty());

        assert!(mark_fn_node_removed(&tmp.work_dir(), "gone").is_err());
        assert!(mark_fn_node_removed(&tmp.work_dir(), "../evil").is_err());
    }

    #[test]
    fn serializes_record_stream() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("one", &VALID_PROP.replace("test_node", "one"));
        fs::write(dir.join("service.sh"), []).unwrap();
        let dir = tmp.create_node("two", &VALID_PROP.replace("test_node", "two"));
        fs::write(dir.join("service.sh"), []).unwrap();
        fs::write(dir.join("disable"), []).unwrap();

        let nodes = scan_fn_nodes(&tmp.work_dir());
        let out = serialize_fn_nodes(&nodes);

        // Records are separated by blank lines and the stream ends with an
        // empty record.
        assert!(out.ends_with("\n\n"));
        let mut records: Vec<&str> = out.split("\n\n").collect();
        let terminator = records.pop().unwrap();
        assert_eq!(terminator, "\n");
        assert_eq!(records.len(), 2);

        let first: HashMap<_, _> = records[0]
            .lines()
            .map(|l| l.split_once('=').unwrap())
            .collect();
        assert_eq!(first["id"], "one");
        assert_eq!(first["versionCode"], "42");
        assert_eq!(first["trigger"], "app");
        assert_eq!(first["scope"], "all");
        assert_eq!(first["priority"], "100");
        assert_eq!(first["status"], "enabled");

        let second: HashMap<_, _> = records[1]
            .lines()
            .map(|l| l.split_once('=').unwrap())
            .collect();
        assert_eq!(second["id"], "two");
        assert_eq!(second["status"], "disabled");

        // An empty list serializes to just the empty-record terminator.
        assert_eq!(serialize_fn_nodes(&[]), "\n");
    }

    #[test]
    fn status_wire_strings_are_stable() {
        assert_eq!(FnStatus::Enabled.as_wire_str(), "enabled");
        assert_eq!(FnStatus::Disabled.as_wire_str(), "disabled");
        assert_eq!(FnStatus::PendingRemove.as_wire_str(), "pending_remove");
        assert_eq!(FnStatus::PendingUpdate.as_wire_str(), "pending_update");
        assert_eq!(
            FnStatus::Malformed("bad".to_string()).as_wire_str(),
            "malformed:bad"
        );
    }

    // --- Installation tests ---

    /// Builds a zip archive in memory from `(name, contents)` pairs.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn node_zip(id: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let prop = format!(
            "id={}\nname=Test\nversion=1.0\nversionCode=1\ntrigger=app\n",
            id
        );
        let mut entries = vec![("fn.prop", prop.as_bytes())];
        entries.extend_from_slice(extra);
        build_zip(&entries)
    }

    #[test]
    fn installs_valid_node() {
        let tmp = TempWorkDir::new();
        let zip = node_zip("installed", &[("service.sh", b"#!/system/bin/sh\n")]);
        let node = install_fn_node(&tmp.work_dir(), &zip).unwrap();
        assert_eq!(node.id, "installed");
        assert_eq!(node.status, FnStatus::Enabled);
        // The script landed on disk with executable permissions.
        let script = tmp.0.join(constants::PATH_FN_DIR).join("installed/service.sh");
        let mode = fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
        assert!(scan_fn_nodes(&tmp.work_dir()).iter().any(|n| n.id == "installed"));
    }

    #[test]
    fn installs_native_entry_library() {
        let tmp = TempWorkDir::new();
        let prop = "id=native\nname=Native\nversion=1.0\nversionCode=1\n\
             entry=lib/arm64-v8a/fn.so\n";
        let zip = build_zip(&[
            ("fn.prop", prop.as_bytes()),
            ("lib/arm64-v8a/fn.so", b"\x7fELF"),
            ("lib/armeabi-v7a/fn.so", b"\x7fELF"),
        ]);
        let node = install_fn_node(&tmp.work_dir(), &zip).unwrap();
        assert_eq!(node.status, FnStatus::Enabled);
        assert_eq!(node.entry.as_deref(), Some("lib/arm64-v8a/fn.so"));
        assert!(tmp
            .0
            .join(constants::PATH_FN_DIR)
            .join("native/lib/arm64-v8a/fn.so")
            .is_file());
    }

    #[test]
    fn rejects_invalid_zips() {
        let tmp = TempWorkDir::new();
        // Not a zip at all.
        assert!(install_fn_node(&tmp.work_dir(), b"not a zip").is_err());
        // Missing fn.prop.
        assert!(install_fn_node(&tmp.work_dir(), &build_zip(&[("x.txt", b"x")])).is_err());
        // Invalid id in fn.prop.
        assert!(install_fn_node(&tmp.work_dir(), &node_zip("Bad ID!", &[])).is_err());
        // Path traversal inside lib/.
        let zip = build_zip(&[
            ("fn.prop", b"id=evil\nname=X\nversion=1\nversionCode=1\n"),
            ("lib/../../etc/passwd", b"x"),
        ]);
        assert!(install_fn_node(&tmp.work_dir(), &zip).is_err());
        // State flags are not accepted from a zip.
        let zip = build_zip(&[
            ("fn.prop", b"id=evil2\nname=X\nversion=1\nversionCode=1\n"),
            ("disable", b""),
        ]);
        assert!(install_fn_node(&tmp.work_dir(), &zip).is_err());
        // Nothing was written by any of the failed attempts.
        assert!(scan_fn_nodes(&tmp.work_dir()).is_empty());
    }

    #[test]
    fn update_replaces_existing_node() {
        let tmp = TempWorkDir::new();
        let dir = tmp.create_node("upd", &VALID_PROP.replace("test_node", "upd"));
        fs::write(dir.join("service.sh"), b"old").unwrap();

        let zip = node_zip(
            "upd",
            &[("service.sh", b"new"), ("lib/arm64-v8a/fn.so", b"\x7fELF")],
        );
        let node = install_fn_node(&tmp.work_dir(), &zip).unwrap();
        assert_eq!(node.status, FnStatus::Enabled);
        assert_eq!(fs::read(dir.join("service.sh")).unwrap(), b"new");
        // The update flag, if previously set, is consumed.
        fs::write(dir.join("update"), []).unwrap();
        let zip = node_zip("upd", &[("service.sh", b"newer")]);
        install_fn_node(&tmp.work_dir(), &zip).unwrap();
        assert!(!dir.join("update").exists());
    }

    #[test]
    fn filters_active_native_nodes() {
        let tmp = TempWorkDir::new();
        // Enabled with entry.
        let dir = tmp.create_node(
            "with_lib",
            "id=with_lib\nname=X\nversion=1\nversionCode=1\nentry=lib/arm64-v8a/fn.so\n",
        );
        fs::create_dir_all(dir.join("lib/arm64-v8a")).unwrap();
        fs::write(dir.join("lib/arm64-v8a/fn.so"), []).unwrap();
        // Enabled but script-only.
        let dir = tmp.create_node("scripted", &VALID_PROP.replace("test_node", "scripted"));
        fs::write(dir.join("service.sh"), []).unwrap();
        // Disabled with entry.
        let dir = tmp.create_node(
            "disabled_lib",
            "id=disabled_lib\nname=X\nversion=1\nversionCode=1\nentry=lib/arm64-v8a/fn.so\n",
        );
        fs::create_dir_all(dir.join("lib/arm64-v8a")).unwrap();
        fs::write(dir.join("lib/arm64-v8a/fn.so"), []).unwrap();
        fs::write(dir.join("disable"), []).unwrap();

        let active = active_native_nodes(&tmp.work_dir());
        let ids: Vec<_> = active.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["with_lib"]);
    }

    #[test]
    fn allows_only_whitelisted_zip_entries() {
        assert!(is_allowed_zip_entry("fn.prop"));
        assert!(is_allowed_zip_entry("service.sh"));
        assert!(is_allowed_zip_entry("lib/arm64-v8a/fn.so"));
        assert!(is_allowed_zip_entry("lib/x"));
        assert!(!is_allowed_zip_entry("disable"));
        assert!(!is_allowed_zip_entry("remove"));
        assert!(!is_allowed_zip_entry("update"));
        assert!(!is_allowed_zip_entry("module.prop"));
        assert!(!is_allowed_zip_entry("../fn.prop"));
        assert!(!is_allowed_zip_entry("/etc/passwd"));
        assert!(!is_allowed_zip_entry("lib/../fn.prop"));
        assert!(!is_allowed_zip_entry(""));
    }
}
