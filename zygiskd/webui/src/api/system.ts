/* OnyxZygisk — data layer. One shell round-trip fetches full system state. */
import { exec } from "../bridge";
import type { ExecResult, FnNodeInfo, ModuleInfo, MonitorRow, StateData } from "../types";

const WORKDIR = "/data/adb/onyxzygisk";
const MODDIR = "/data/adb/modules/onyxzygisk";
const STAGED_MODDIR = "/data/adb/modules_update/onyxzygisk";
const MODULE_LOG_PATTERN = [
  "Hot-plug",
  "hot-plug",
  "zygiskd: hot-plug",
  "Module script",
  "FN ",
  "Installing FN",
  "Updating FN",
  "Removed FN",
  "Enabled FN",
  "Disabled FN",
  "Scheduling FN",
  "Scheduled [0-9]+ FN",
  "runtime module status",
  "mount mode",
  "daemon failed",
].join("|");

const STATUS_SCRIPT = [
  'ACTIVE="' + MODDIR + '"; STAGED="' + STAGED_MODDIR + '"; W="' + WORKDIR + '"',
  'MOD="$ACTIVE"; [ -f "$MOD/module.prop" ] || MOD="$STAGED"',
  'v=$(sed -n "s/^version=//p" "$MOD/module.prop" 2>/dev/null | head -n1)',
  "r=none",
  // Root provider detection: only a RUNNING daemon counts. Stale files from a
  // previous setup (leftover `apd` on a KernelSU device) or a magisk-compatible
  // binary in PATH on APatch/KernelSU devices must not win, so there are no
  // file/PATH fallbacks. FolkPatch keeps APatch's `apd` next to its own `fpd`,
  // so fpd wins when both daemons run.
  "pidof apd >/dev/null 2>&1 && r=APatch",
  "pidof fpd >/dev/null 2>&1 && r=FolkPatch",
  "[ -d /data/adb/ksu ] && r=KernelSU",
  "pidof magiskd >/dev/null 2>&1 && r=Magisk",
  // Print an empty label instead of "none" when nothing was detected.
  '[ "$r" = none ] && r=',
  'echo "status_protocol=1"',
  'echo "installed=$([ -f "$MOD/module.prop" ] && echo 1 || echo 0)"',
  'echo "runtime=$([ -s "$W/module.prop" ] && echo 1 || echo 0)"',
  'echo "version=$v"; echo "root=$r"',
  'pidof zygote64 >/dev/null 2>&1 && echo "z64=1" || echo "z64=0"',
  '(pidof zygote >/dev/null 2>&1 || pidof zygote_secondary >/dev/null 2>&1) && echo "z32=1" || echo "z32=0"',
  // The daemon is exec'd as `zygiskd64`/`zygiskd32` (ABI suffix), so a plain
  // `pidof zygiskd` never matches and the dashboard would always show it as
  // stopped. Match all three names.
  'echo "daemon=$(pidof zygiskd zygiskd64 zygiskd32 >/dev/null 2>&1 && echo 1 || echo 0)"',
  'echo "workdir=$W"',
  // Hot-plug master switch: off (WORKDIR/hotplug_off present) means staged
  // updates only apply at the root solution's own boot-time swap.
  'echo "hotplug=$([ -f "$W/hotplug_off" ] && echo 0 || echo 1)"',
  // Mount mode: revert (default) | setns | global. See setMountMode.
  'echo "mount_mode=$(cat "$W/mount_mode" 2>/dev/null || echo revert)"',
  'echo "@@monitor"',
  'cat "$W/module.prop" 2>/dev/null | head -c 600; echo',
  'echo "@@modules"',
  // Collect module ids from BOTH the active directory and the staging
  // directory, deduplicated. A genuinely new install lives only in
  // modules_update/ until the next reboot: KernelSU leaves a metadata-only
  // stub in modules/<id>/ with no .so, APatch leaves modules/<id>/ empty — so
  // iterating the active directory alone hides new installs entirely, and
  // then their hotplug switch can never appear. `id` is the directory
  // basename, matching how the daemon keys modules (and names the hotplug
  // flag; see zygiskd::eligible_modules / hotplug_opted_in).
  '  mids=""',
  "  for d in /data/adb/modules/*/ /data/adb/modules_update/*/; do",
  '    [ -d "$d" ] || continue',
  '    bn=${d%/}; bn=${bn##*/}',
  '    case " $mids " in *" $bn "*) ;; *) mids="$mids $bn" ;; esac',
  "  done",
  "  for id in $mids; do",
  '    ad="/data/adb/modules/$id"; ud="/data/adb/modules_update/$id"',
  // Is a *complete* staged update present for this id? Same signal the daemon
  // uses (zygiskd::staged_update_ready): module.prop plus at least one ABI's
  // Zygisk .so. The root solutions' own "update" flags are not reliable in
  // practice (ksud leaves only a metadata stub in modules/<id>, apd's global
  // flag is cleared at boot), so file completeness is the signal.
  '    pend=0',
  '    [ -f "$ud/module.prop" ] && { [ -f "$ud/zygisk/arm64-v8a.so" ] || [ -f "$ud/zygisk/armeabi-v7a.so" ] || [ -f "$ud/zygisk/x86_64.so" ] || [ -f "$ud/zygisk/x86.so" ]; } && pend=1',
  // Read metadata + the .so from the staged copy when a staged update is
  // present (it is the version that will run once applied), else the active
  // copy. `dis` always comes from the active dir — the disable flag lives
  // there and the daemon inherits it across the swap.
  '    msrc="$ad"; [ "$pend" = 1 ] && [ -f "$ud/module.prop" ] && msrc="$ud"',
  '    zsrc="$ad"; [ "$pend" = 1 ] && zsrc="$ud"',
  '    p="$msrc/module.prop"; [ -f "$p" ] || continue',
  '    zy=0; { [ -f "$zsrc/zygisk/arm64-v8a.so" ] || [ -f "$zsrc/zygisk/armeabi-v7a.so" ]; } && zy=1',
  // Only Zygisk-capable modules are shown in the WebUI.
  '    [ "$zy" = 0 ] && continue',
  '    nm=$(sed -n "s/^name=//p" "$p" | head -n1)',
  '    ver=$(sed -n "s/^version=//p" "$p" | head -n1)',
  '    au=$(sed -n "s/^author=//p" "$p" | head -n1)',
  '    ds=$(sed -n "s/^description=//p" "$p" | head -n1)',
  '    dis=0; { [ -f "$ad/disable" ] || [ -f "$ad/remove" ]; } && dis=1',
  '    hp=0; [ -f "$W/hotplug/$id" ] && hp=1',
  // Was this module hot-plugged into the active directory? Such modules keep
  // a plug/unplug switch (hotplug flag present = plugged), independent of
  // the pending-update state.
  '    hg=0; [ -f "$W/hotplug_activated/$id.post_fs_data" ] && hg=1',
  '    echo "M|$id|$nm|$ver|$au|$zy|$dis|$ds|$pend|$hp|$hg"',
  "  done",
  'echo "@@fn"',
  '  fids=""',
  'for d in "$W"/fn/*/ /data/adb/modules/*/; do',
  '  [ -d "$d" ] || continue; p="$d/fn.prop"; [ -f "$p" ] || continue',
  '  id=$(sed -n "s/^id=//p" "$p" | head -n1)',
  '  case " $fids " in *" $id "*) continue ;; esac',
  '  fids="$fids $id"',
  '  nm=$(sed -n "s/^name=//p" "$p" | head -n1)',
  '  ver=$(sed -n "s/^version=//p" "$p" | head -n1)',
  '  tr=$(sed -n "s/^trigger=//p" "$p" | head -n1)',
  '  sc=$(sed -n "s/^scope=//p" "$p" | head -n1)',
  '  st=enabled; [ -f "$d/disable" ] && st=disabled; [ -f "$d/remove" ] && st=pending_remove',
  '  echo "F|$id|$nm|$ver|$tr|$sc|$st"',
  "done",
  // A glob with no FN directory can leave some Android shells with the test
  // command's non-zero status even though the full protocol was emitted.
  // Make the read-only status script explicitly successful.
  ":",
  // Lines are joined with newlines, NOT "; ": a `; ` separator turns the
  // multi-line `for ...; do` loops into `do;` which is a shell syntax error.
].join("\n");

export function parseStatus(out: string): StateData {
  const data: StateData = { keys: {}, monitor: "", modules: [], fns: [] };
  let section: "keys" | "monitor" | "modules" | "fn" = "keys";
  for (const line of out.split("\n")) {
    if (line === "@@monitor") {
      section = "monitor";
      continue;
    }
    if (line === "@@modules") {
      section = "modules";
      continue;
    }
    if (line === "@@fn") {
      section = "fn";
      continue;
    }
    if (section === "keys") {
      const i = line.indexOf("=");
      if (i > 0) data.keys[line.slice(0, i)] = line.slice(i + 1);
    } else if (section === "monitor") {
      data.monitor += line + "\n";
    } else if (section === "modules" && line.startsWith("M|")) {
      const p = line.split("|");
      data.modules.push({
        id: p[1],
        name: p[2],
        version: p[3],
        author: p[4],
        zygisk: p[5] === "1",
        disabled: p[6] === "1",
        desc: p[7],
        pendingUpdate: p[8] === "1",
        hotplugEnabled: p[9] === "1",
        hotplugged: p[10] === "1",
      } as ModuleInfo);
    } else if (section === "fn" && line.startsWith("F|")) {
      const p = line.split("|");
      data.fns.push({
        id: p[1],
        name: p[2],
        version: p[3],
        trigger: p[4],
        scope: p[5],
        status: p[6],
      } as FnNodeInfo);
    }
  }
  return data;
}

export async function fetchState(): Promise<StateData> {
  const r = await exec(STATUS_SCRIPT);
  const data = parseStatus(r.stdout);
  // The protocol marker is authoritative. A few root-manager shells report a
  // non-zero callback errno after an otherwise complete multi-line script
  // (notably when its final glob is empty), so rejecting solely on errno turns
  // valid state into an error containing the entire status payload.
  if (data.keys.status_protocol !== "1") {
    const detail = (r.stdout || r.stderr).trim();
    throw new Error(detail || `status command returned incomplete data (exit ${r.errno})`);
  }
  return data;
}

async function execChecked(cmd: string, operation: string): Promise<ExecResult> {
  const r = await exec(cmd);
  if (r.errno !== 0) {
    const detail = (r.stdout || r.stderr).trim();
    throw new Error(detail || `${operation} failed (exit ${r.errno})`);
  }
  return r;
}

/** Parse the monitor status section of the workdir module.prop.
 * The ptrace monitor writes this file tab-prefixed: module metadata lines
 * ("key=value"), then live rows ("monitor: tracing", "zygote64: injected",
 * "daemon64: running"), then daemon detail lines indented deeper
 * ("Root: APatch", "Modules (2):", module names). Only the live rows and
 * detail lines are returned; metadata is skipped.
 */
export function parseMonitor(text: string): MonitorRow[] {
  const rows: MonitorRow[] = []; // label is null for plain detail lines
  for (const raw of String(text || "").split("\n")) {
    const s = raw.replace(/^\t+/, "").trim();
    if (!s) continue;
    // Module metadata ("key=value") and stray "=..." remnants from older
    // monitor builds are not status rows.
    if (/^[a-zA-Z][a-zA-Z0-9_]*=/.test(s) || s.startsWith("=")) continue;
    const m = /^([a-z][a-z0-9]*):\s*(.+)$/.exec(s);
    rows.push(m ? { label: m[1], value: m[2] } : { label: null, value: s });
  }
  return rows;
}

export async function fetchLogs(lines: number | string): Promise<string> {
  const parsed = parseInt(String(lines), 10);
  const n = Math.min(300, Math.max(20, Number.isFinite(parsed) ? parsed : 120));
  const readLimit = Math.min(500, Math.max(n * 3, 120));
  const r = await exec(
    `logcat -d -v brief -t ${readLimit} -s zygiskd:* zygisk-sh:* 2>/dev/null | grep -E '${MODULE_LOG_PATTERN}' | tail -n ${n}`,
  );
  const logcatOut = r.stdout.trim();
  if (logcatOut || r.errno === 0) return logcatOut;

  // Some root-manager WebUI bridges report a non-zero errno for `logcat`, or
  // run in a context where logcat is unavailable. KernelSU already captures a
  // full logcat snapshot, so fall back to that file instead of turning the log
  // panel into a red error box.
  const fallback = [
    `n=${n}`,
    `read=${readLimit}`,
    `pat='${MODULE_LOG_PATTERN}'`,
    "for f in /data/adb/ksu/log/logcat.log /data/adb/ksu/log/logcat.old.log; do",
    '  [ -r "$f" ] || continue',
    '  tail -n "$read" "$f" 2>/dev/null | grep -E "zygiskd|zygisk-sh" | grep -E "$pat" | tail -n "$n"',
    "  exit 0",
    "done",
    ":",
  ].join("\n");
  const fb = await exec(fallback);
  const fallbackOut = fb.stdout.trim();
  if (fallbackOut || fb.errno === 0) return fallbackOut;

  const detail = (r.stderr || fb.stderr || r.stdout || fb.stdout).trim();
  throw new Error(detail || `read logs failed (exit ${r.errno})`);
}

export async function setFnEnabled(id: string, enabled: boolean): Promise<void> {
  const flag = `${WORKDIR}/fn/${id}/disable`;
  await execChecked(enabled ? `rm -f '${flag}'` : `touch '${flag}'`, "update FN module");
}

/** Opt a module with a detected pending update into using it immediately —
 * the daemon only overlays a staged update when both this flag and the
 * hot-plug master switch are on. See zygiskd::eligible_modules. */
export async function setModuleHotplug(id: string, enabled: boolean): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error("invalid module id");
  }
  const dir = `${WORKDIR}/hotplug`;
  const flag = `${dir}/${id}`;
  await execChecked(
    enabled ? `mkdir -p '${dir}' && touch '${flag}'` : `rm -f '${flag}'`,
    "update hot-plug preference",
  );

  // Apply immediately through the bundled daemon CLI. It performs the staged
  // -> active transaction, runs module lifecycle scripts, then reboots the
  // device once so the module loads at the fresh system_server fork. Both
  // ABIs are tried, including a staged OnyxZygisk update whose binary may
  // not have moved into the active directory yet.
  const apply = [
    'bin=""',
    `for b in '${MODDIR}/bin/zygiskd64' '${MODDIR}/bin/zygiskd32' '${STAGED_MODDIR}/bin/zygiskd64' '${STAGED_MODDIR}/bin/zygiskd32'; do`,
    '  [ -x "$b" ] && { bin="$b"; break; }',
    "done",
    '[ -n "$bin" ] || { echo "OnyxZygisk daemon binary not found"; exit 127; }',
    `"$bin" hotplug '${id}' --workdir '${WORKDIR}'`,
  ].join("\n");
  await execChecked(apply, "apply hot-plug module");
}

/** Master switch for the hot-plug feature. When off, per-module opt-ins are
 * ignored and staged updates only apply at the root solution's boot-time
 * swap (a reboot). Flag file: WORKDIR/hotplug_off, absent = enabled.
 * See zygiskd::hotplug_master_enabled. */
export async function setHotplugMaster(enabled: boolean): Promise<void> {
  const flag = `${WORKDIR}/hotplug_off`;
  await execChecked(enabled ? `rm -f '${flag}'` : `touch '${flag}'`, "update hot-plug setting");
}

/** Mount mode for denylisted apps, applied by the daemon/loader on the next
 * app launch (no restart). One of:
 *  - "revert": unmount module/root traces directly from zygote (default);
 *  - "setns":  switch denylisted apps into a cached clean namespace;
 *  - "global": mount modules into every app, hide only su/root.
 * Stored in WORKDIR/mount_mode; see zygiskd::mount_mode_flag. */
export type MountMode = "revert" | "setns" | "global";
export async function setMountMode(mode: MountMode): Promise<void> {
  const flag = `${WORKDIR}/mount_mode`;
  // "revert" is the default — clear the file rather than storing it.
  await execChecked(
    mode === "revert" ? `rm -f '${flag}'` : `printf '%s' '${mode}' > '${flag}'`,
    "update mount mode",
  );
}

/** Normalize version display: strip a leading v/V then add one. */
export function fmtVer(v: string | undefined): string {
  const s = String(v || "?")
    .trim()
    .replace(/^[vV]/, "");
  return "v" + (s || "?");
}
