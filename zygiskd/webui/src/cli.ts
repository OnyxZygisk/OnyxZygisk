import { type ExecResult, getBridge } from "./bridge";
import {
	decodeBase64Utf8,
	isValidModuleId,
	type MountMode,
	parseLogLineCount,
	parseStatus,
	type SystemState,
	shellQuote,
} from "./cli_parse";
import { WORKDIR } from "./module_info";

const MODDIR = "/data/adb/modules/onyxzygisk";
const STAGED_MODDIR = "/data/adb/modules_update/onyxzygisk";

/**
 * Lines the logs tab keeps. The daemon and the module scripts all log through
 * this tag, so the filter is the difference between a readable operations log
 * and the whole device logcat.
 */
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

/**
 * One round trip fetches the whole system state, so every tab renders from a
 * single shell invocation.
 *
 * Lines are joined with newlines, NOT "; ": a `; ` separator turns the
 * multi-line `for ...; do` loops into `do;` which is a shell syntax error.
 */
export const STATUS_SCRIPT = [
	'ACTIVE="' +
		MODDIR +
		'"; STAGED="' +
		STAGED_MODDIR +
		'"; W="' +
		WORKDIR +
		'"',
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
	// Mount mode: revert (default) | setns | global.
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
	// basename, matching how the daemon keys modules.
	'  mids=""',
	"  for d in /data/adb/modules/*/ /data/adb/modules_update/*/; do",
	'    [ -d "$d" ] || continue',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX expansion in shell code.
	"    bn=${d%/}; bn=${bn##*/}",
	'    case " $mids " in *" $bn "*) ;; *) mids="$mids $bn" ;; esac',
	"  done",
	"  for id in $mids; do",
	'    ad="/data/adb/modules/$id"; ud="/data/adb/modules_update/$id"',
	// Is a *complete* staged update present for this id? Same signal the daemon
	// uses: module.prop plus at least one ABI's Zygisk .so. The root solutions'
	// own "update" flags are not reliable in practice, so file completeness is
	// the signal.
	"    pend=0",
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
	// a plug/unplug switch, independent of the pending-update state.
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
].join("\n");

export class Cli {
	async readState(): Promise<SystemState> {
		const result = await this.#exec(STATUS_SCRIPT);
		const state = parseStatus(result.stdout);
		// The protocol marker is authoritative. A few root-manager shells report
		// a non-zero callback errno after an otherwise complete multi-line script
		// (notably when its final glob is empty), so rejecting solely on errno
		// turns valid state into an error containing the entire status payload.
		if (state.keys.status_protocol !== "1") {
			const detail = (result.stdout || result.stderr).trim();
			throw new Error(
				detail ||
					`status command returned incomplete data (exit ${result.errno})`,
			);
		}
		return state;
	}

	async fetchLogs(lines: number | string): Promise<string> {
		const count = parseLogLineCount(lines);
		const readLimit = Math.min(500, Math.max(count * 3, 120));
		const probe = await this.#exec(
			"logcat -d -v brief -t " +
				readLimit +
				" -s zygiskd:* zygisk-sh:* 2>/dev/null | grep -E " +
				shellQuote(MODULE_LOG_PATTERN) +
				" | tail -n " +
				count,
		);
		const logcatOutput = probe.stdout.trim();
		if (logcatOutput !== "" || probe.errno === 0) return logcatOutput;

		// Some root-manager WebUI bridges report a non-zero errno for `logcat`,
		// or run in a context where logcat is unavailable. KernelSU already
		// captures a full logcat snapshot, so fall back to that file instead of
		// turning the log panel into an error box.
		const fallback = [
			`n=${count}`,
			`read=${readLimit}`,
			`pat=${shellQuote(MODULE_LOG_PATTERN)}`,
			"for f in /data/adb/ksu/log/logcat.log /data/adb/ksu/log/logcat.old.log; do",
			'  [ -r "$f" ] || continue',
			'  tail -n "$read" "$f" 2>/dev/null | grep -E "zygiskd|zygisk-sh" | grep -E "$pat" | tail -n "$n"',
			"  exit 0",
			"done",
			":",
		].join("\n");
		const fb = await this.#exec(fallback);
		const fallbackOutput = fb.stdout.trim();
		if (fallbackOutput !== "" || fb.errno === 0) return fallbackOutput;

		const detail = (
			probe.stderr ||
			fb.stderr ||
			probe.stdout ||
			fb.stdout
		).trim();
		throw new Error(detail || `read logs failed (exit ${probe.errno})`);
	}

	/** Enable/disable an FN node through its `disable` flag file. */
	async setFnEnabled(id: string, enabled: boolean): Promise<void> {
		if (!isValidModuleId(id)) throw new Error("invalid FN node id");
		const flag = `${WORKDIR}/fn/${id}/disable`;
		await this.#runChecked(
			enabled ? `rm -f ${shellQuote(flag)}` : `touch ${shellQuote(flag)}`,
			"update FN node",
		);
	}

	/**
	 * Opt a module with a detected pending update into using it immediately.
	 * The daemon only overlays a staged update when both this flag and the
	 * hot-plug master switch are on.
	 */
	async setModuleHotplug(id: string, enabled: boolean): Promise<void> {
		if (!isValidModuleId(id)) throw new Error("invalid module id");
		const directory = `${WORKDIR}/hotplug`;
		const flag = `${directory}/${id}`;
		await this.#runChecked(
			enabled
				? `mkdir -p ${shellQuote(directory)} && touch ${shellQuote(flag)}`
				: `rm -f ${shellQuote(flag)}`,
			"update hot-plug preference",
		);

		// Apply immediately through the bundled daemon CLI. It performs the
		// staged -> active transaction, runs module lifecycle scripts, then
		// reboots the device once so the module loads at the fresh
		// system_server fork. Both ABIs are tried, including a staged OnyxZygisk
		// update whose binary may not have moved into the active directory yet.
		const apply = [
			'bin=""',
			"for b in " +
				[
					`${MODDIR}/bin/zygiskd64`,
					`${MODDIR}/bin/zygiskd32`,
					`${STAGED_MODDIR}/bin/zygiskd64`,
					`${STAGED_MODDIR}/bin/zygiskd32`,
				]
					.map(shellQuote)
					.join(" ") +
				"; do",
			'  [ -x "$b" ] && { bin="$b"; break; }',
			"done",
			'[ -n "$bin" ] || { echo "OnyxZygisk daemon binary not found"; exit 127; }',
			`"$bin" hotplug ${shellQuote(id)} --workdir ${shellQuote(WORKDIR)}`,
		].join("\n");
		await this.#runChecked(apply, "apply hot-plug module");
	}

	/**
	 * Master switch for the hot-plug feature. When off, per-module opt-ins are
	 * ignored and staged updates only apply at the root solution's boot-time
	 * swap. Flag file: WORKDIR/hotplug_off, absent = enabled.
	 */
	async setHotplugMaster(enabled: boolean): Promise<void> {
		const flag = `${WORKDIR}/hotplug_off`;
		await this.#runChecked(
			enabled ? `rm -f ${shellQuote(flag)}` : `touch ${shellQuote(flag)}`,
			"update hot-plug setting",
		);
	}

	/**
	 * Mount mode for denylisted apps, applied by the daemon/loader on the next
	 * app launch (no restart). `revert` is the default — clear the file rather
	 * than storing it.
	 */
	async setMountMode(mode: MountMode): Promise<void> {
		const flag = `${WORKDIR}/mount_mode`;
		await this.#runChecked(
			mode === "revert"
				? `rm -f ${shellQuote(flag)}`
				: `printf '%s' ${shellQuote(mode)} > ${shellQuote(flag)}`,
			"update mount mode",
		);
	}

	async #runChecked(command: string, operation: string): Promise<ExecResult> {
		const result = await this.#exec(command);
		if (result.errno !== 0) {
			const detail = (result.stdout || result.stderr).trim();
			throw new Error(detail || `${operation} failed (exit ${result.errno})`);
		}
		return result;
	}

	/**
	 * Runs a command through the host bridge with its output base64-wrapped.
	 *
	 * The WebView bridge mangles non-ASCII bytes on the way back from the shell,
	 * and the module names and descriptions this WebUI renders are routinely
	 * Chinese or emoji, so stdout is transported as base64 and decoded as UTF-8
	 * here. Piping straight into `base64` would make the pipeline report
	 * base64's (usually zero) status, which previously turned every failed
	 * write into a fake success — hence the explicit `rc` round trip.
	 */
	async #exec(command: string): Promise<ExecResult> {
		const wrapped = [
			'out="$({',
			command,
			'} 2>&1)"',
			"rc=$?",
			'printf "%s" "$out" | base64',
			'exit "$rc"',
		].join("\n");
		const result = await getBridge().exec(wrapped);
		return {
			errno: result.errno,
			stdout: decodeBase64Utf8(result.stdout),
			stderr: result.stderr,
		};
	}
}
