/** Parsed `key=value` header of the status script output. */
export interface StatusKeys {
	status_protocol?: string;
	installed?: string;
	runtime?: string;
	version?: string;
	root?: string;
	z64?: string;
	z32?: string;
	daemon?: string;
	hotplug?: string;
	mount_mode?: string;
	workdir?: string;
	[key: string]: string | undefined;
}

/** A Zygisk module row (`M|id|name|version|author|zygisk|disabled|desc|pending|hotplug|hotplugged`). */
export interface ModuleInfo {
	id: string;
	name: string;
	version: string;
	author: string;
	zygisk: boolean;
	disabled: boolean;
	desc: string;
	/**
	 * A newer version is staged, confirmed fully written, and waiting for the
	 * next reboot's official swap into the active directory.
	 */
	pendingUpdate: boolean;
	/**
	 * The user opted in to the daemon using the staged version early, ahead of
	 * that reboot. Only meaningful when `pendingUpdate` is true.
	 */
	hotplugEnabled: boolean;
	/**
	 * This module was hot-plugged into the active directory. It keeps a
	 * plug/unplug switch independent of the pending-update state.
	 */
	hotplugged: boolean;
}

/** An FN node row (`F|id|name|version|trigger|scope|status`). */
export interface FnNodeInfo {
	id: string;
	name: string;
	version: string;
	trigger: string;
	scope: string;
	status: string;
}

/**
 * One row of the monitor status text. The ptrace monitor writes tab-prefixed
 * lines into the workdir module.prop: module metadata (`key=value`), then live
 * rows (`monitor: tracing`), then deeper detail lines. `label` is null for
 * plain detail lines.
 */
export interface MonitorRow {
	label: string | null;
	value: string;
}

/** Everything one `STATUS_SCRIPT` round trip yields. */
export interface SystemState {
	keys: StatusKeys;
	monitor: MonitorRow[];
	modules: ModuleInfo[];
	fns: FnNodeInfo[];
}

export type MountMode = "revert" | "setns" | "global";

export const MOUNT_MODES: readonly MountMode[] = ["revert", "setns", "global"];

/** Module ids are directory basenames; anything else is a malformed payload. */
const MODULE_ID = /^[A-Za-z0-9._-]+$/;

export function isValidModuleId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value !== "" &&
		value !== "." &&
		value !== ".." &&
		MODULE_ID.test(value)
	);
}

/** Single-quote a value for `/system/bin/sh`. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** base64 → UTF-8. `atob` gives a binary string; TextDecoder makes it UTF-8. */
export function decodeBase64Utf8(encoded: string): string {
	const clean = String(encoded).replace(/\s+/g, "");
	if (clean === "") return "";
	try {
		const binary = atob(clean);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}
		return new TextDecoder("utf-8").decode(bytes);
	} catch {
		return String(encoded);
	}
}

/** Clamp a user-supplied log line count onto the supported range. */
export function parseLogLineCount(value: number | string): number {
	const parsed = Number.parseInt(String(value), 10);
	return Math.min(300, Math.max(20, Number.isFinite(parsed) ? parsed : 120));
}

/** Normalise version display: strip a leading v/V then add one. */
export function formatVersion(value: string | undefined): string {
	const stripped = String(value ?? "")
		.trim()
		.replace(/^[vV]/, "");
	return `v${stripped === "" ? "?" : stripped}`;
}

export function parseStatus(output: string): SystemState {
	const data: SystemState = { keys: {}, monitor: [], modules: [], fns: [] };
	let monitorText = "";
	let section: "keys" | "monitor" | "modules" | "fn" = "keys";
	for (const line of output.split("\n")) {
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
			const separator = line.indexOf("=");
			if (separator > 0) {
				data.keys[line.slice(0, separator)] = line.slice(separator + 1);
			}
		} else if (section === "monitor") {
			monitorText += `${line}\n`;
		} else if (section === "modules" && line.startsWith("M|")) {
			const parts = line.split("|");
			data.modules.push({
				id: parts[1] ?? "",
				name: parts[2] ?? "",
				version: parts[3] ?? "",
				author: parts[4] ?? "",
				zygisk: parts[5] === "1",
				disabled: parts[6] === "1",
				desc: parts[7] ?? "",
				pendingUpdate: parts[8] === "1",
				hotplugEnabled: parts[9] === "1",
				hotplugged: parts[10] === "1",
			});
		} else if (section === "fn" && line.startsWith("F|")) {
			const parts = line.split("|");
			data.fns.push({
				id: parts[1] ?? "",
				name: parts[2] ?? "",
				version: parts[3] ?? "",
				trigger: parts[4] ?? "",
				scope: parts[5] ?? "",
				status: parts[6] ?? "",
			});
		}
	}
	data.monitor = parseMonitor(monitorText);
	return data;
}

/**
 * Parse the monitor status section of the workdir module.prop.
 *
 * The ptrace monitor writes this file tab-prefixed: module metadata lines
 * (`key=value`), then live rows (`monitor: tracing`, `zygote64: injected`,
 * `daemon64: running`), then daemon detail lines indented deeper
 * (`Root: APatch`, `Modules (2):`, module names). Only the live rows and
 * detail lines are returned; metadata is skipped.
 */
export function parseMonitor(text: string): MonitorRow[] {
	const rows: MonitorRow[] = [];
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.replace(/^\t+/, "").trim();
		if (line === "") continue;
		// Module metadata ("key=value") and stray "=..." remnants from older
		// monitor builds are not status rows.
		if (/^[a-zA-Z][a-zA-Z0-9_]*=/.test(line) || line.startsWith("=")) continue;
		const match = /^([a-z][a-z0-9]*):\s*(.+)$/.exec(line);
		rows.push(
			match
				? { label: match[1] ?? null, value: match[2] ?? "" }
				: { label: null, value: line },
		);
	}
	return rows;
}

/** How a snapshot came back, once a load attempt has settled. */
export type StatusLevel = "loading" | "ready" | "error";

/**
 * The framework's state in one plain word.
 *
 * The per-fact rows answer "what exactly is running". This answers "is it
 * working" — the question someone who has never heard of `tracing` or
 * `not injected` actually has. It lives here rather than in the view so the
 * rules stay testable without a DOM.
 */
export type OverallState =
	| "checking"
	| "error"
	| "working"
	| "stopped"
	| "installed_inactive"
	| "unknown";

export function deriveOverallState(
	level: StatusLevel,
	state: SystemState | null,
): OverallState {
	if (level === "loading") return "checking";
	if (level === "error") return "error";
	if (state === null) return "unknown";

	// Only the labelled rows are live status; the rest are detail lines.
	const rows = state.monitor.filter((row) => row.label !== null);
	const installed = state.keys.installed === "1";
	const runtimeReady = state.keys.runtime === "1";
	const daemonRunning = state.keys.daemon === "1";

	// No monitor rows at all: an older build, or a monitor that never started.
	if (rows.length === 0) {
		if (daemonRunning) return "working";
		if (installed) return "installed_inactive";
		return "unknown";
	}

	// The `monitor` row is authoritative for whether the framework is running.
	const monitor = rows.find((row) => row.label === "monitor")?.value ?? "";
	if (/stopped|exited/i.test(monitor)) return "stopped";
	if (rows.some((row) => /crashed/i.test(row.value))) return "stopped";

	/*
	 * Tracing means the framework is up and watching, so it reads as working.
	 * A zygote that has not been injected yet only means no app has forked since
	 * boot; it must not water this down to "stopped" for the whole time between
	 * boot and the first fork.
	 */
	if (/tracing/i.test(monitor)) return "working";
	/*
	 * Only a *positive* live row counts. "not injected" contains "injected", so
	 * the negative forms have to be excluded before the healthy ones are looked
	 * for, or a zygote that simply has not forked yet would read as working.
	 */
	const healthy = rows.some(
		(row) =>
			!/not injected|stopped|exited|crashed|invalid/i.test(row.value) &&
			/tracing|injected|running/i.test(row.value),
	);
	if (healthy) return "working";

	if (installed && !runtimeReady) return "installed_inactive";
	return "unknown";
}
