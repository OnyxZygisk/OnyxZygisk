import {
	type ExecOptions,
	type ExecResult,
	exec as ksuExec,
	isKsuWebui as ksuIsKsuWebui,
} from "kernelsu-alt";

export type { ExecOptions, ExecResult };

/** Which host bridge is in effect. `dev` is the PC/Playwright stand-in. */
export type BridgeHost = "ksu" | "mmrl" | "dev";

/**
 * The single seam between application code and the host WebView bridge.
 *
 * Production resolves it to `kernelsu-alt` (KernelSU and APatch inject the
 * same `window.ksu` object) or to the MMRL adapter, because OnyxZygisk ships
 * to all three hosts. Tests install a fake through `setBridge()` so no spec
 * needs a real device.
 */
export interface Bridge {
	readonly host: BridgeHost;
	/** Whether a host bridge is actually present in this WebView. */
	isWebui(): boolean;
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export const ksuBridge: Bridge = {
	host: "ksu",
	isWebui: ksuIsKsuWebui,
	exec: ksuExec,
};

interface MmrlResult {
	code?: number;
	errno?: number;
	stdout?: string;
	stderr?: string;
}

interface MmrlGlobal {
	exec(
		command: string,
		callback?: (result: MmrlResult) => void,
	): Promise<MmrlResult> | undefined;
}

function mmrlGlobal(): MmrlGlobal | undefined {
	return (globalThis as { mmrl?: MmrlGlobal }).mmrl;
}

/**
 * MMRL exposes `window.mmrl.exec` rather than KernelSU's callback-name form.
 * Its return shape has moved between releases — a promise in some builds, a
 * callback in others — so both are accepted and normalised here rather than in
 * every caller.
 */
export const mmrlBridge: Bridge = {
	host: "mmrl",
	isWebui: () => typeof mmrlGlobal()?.exec === "function",
	exec: (command) => {
		const mmrl = mmrlGlobal();
		if (mmrl === undefined) {
			return Promise.resolve({
				errno: 1,
				stdout: "",
				stderr: "mmrl is not defined",
			});
		}
		try {
			const pending = mmrl.exec(command);
			if (pending !== undefined && typeof pending.then === "function") {
				return pending.then((result) => ({
					errno: result.code ?? result.errno ?? 0,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				}));
			}
		} catch {
			/* fall through to the callback form */
		}
		return new Promise((resolve) => {
			try {
				mmrl.exec(command, (result) =>
					resolve({
						errno: result?.code ?? result?.errno ?? 0,
						stdout: result?.stdout ?? "",
						stderr: result?.stderr ?? "",
					}),
				);
			} catch (error) {
				resolve({ errno: 1, stdout: "", stderr: String(error) });
			}
		});
	},
};

/** The host bridge present in this WebView, or null outside a WebView. */
export function detectHostBridge(): Bridge | null {
	if (ksuBridge.isWebui()) return ksuBridge;
	if (mmrlBridge.isWebui()) return mmrlBridge;
	return null;
}

let current: Bridge | null = null;

export function getBridge(): Bridge {
	if (current === null) current = detectHostBridge() ?? ksuBridge;
	return current;
}

/** Replaces the active bridge. Intended for tests and the dev preview. */
export function setBridge(next: Bridge): void {
	current = next;
}

export function resetBridge(): void {
	current = null;
}
