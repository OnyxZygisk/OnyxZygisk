import { useEffect, useRef } from "react";
import { history } from "./app";

export interface OverlayEntry {
	/** Stable identifier for this overlay in the history stack. */
	key: string;
	open: boolean;
	close: () => void;
}

/**
 * Keeps the browser history stack in step with the overlays that are open, so
 * the Android back gesture closes the topmost overlay instead of leaving the
 * WebUI or doing nothing.
 *
 * The host sets `backHandler` and `backInterceptor: native`, which hands back
 * presses to the page, and a native WebView has no other way to reach React
 * state.
 *
 * The diff runs after every render rather than on a dependency list: overlay
 * identity is what matters here, not any single value.
 */
export function useOverlayHistory(overlays: readonly OverlayEntry[]): void {
	const tracked = useRef(new Set<string>());
	const latest = useRef(overlays);
	latest.current = overlays;

	useEffect(() => {
		const current = new Map(latest.current.map((entry) => [entry.key, entry]));

		for (const key of [...tracked.current]) {
			const entry = current.get(key);
			if (entry === undefined || !entry.open) {
				tracked.current.delete(key);
				history.consume(key);
			}
		}

		for (const entry of latest.current) {
			if (!entry.open || tracked.current.has(entry.key)) continue;
			tracked.current.add(entry.key);
			history.push(entry.key, () => {
				tracked.current.delete(entry.key);
				latest.current
					.find((candidate) => candidate.key === entry.key)
					?.close();
			});
		}
	});
}
