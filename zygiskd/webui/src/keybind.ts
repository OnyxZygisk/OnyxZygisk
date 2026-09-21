export type KeybindHandler = () => boolean | undefined;

export class Keybind {
	#callbacks = new Map<string, KeybindHandler[]>();

	constructor() {
		document.addEventListener("keydown", (event) => this.#handleKeydown(event));
	}

	#handleKeydown(event: KeyboardEvent): void {
		const key = this.#resolveEvent(event);
		if (key === null) return;
		// Claim the event only when a handler actually acts on it. A shortcut
		// layer that always calls preventDefault swallows keys other components
		// own — Escape in particular belongs to whichever dialog is open, and
		// Headless UI closes its own.
		if (!this.#emit(key)) return;
		event.preventDefault();
		event.stopPropagation();
	}

	#resolveEvent(event: KeyboardEvent): string | null {
		const key = event.key.toLowerCase();

		if (event.ctrlKey && key === "a") return "keybind-select-all";
		if (event.ctrlKey && key === "d") return "keybind-deselect-all";
		if (event.ctrlKey && key === "f") return "keybind-search";
		if (event.ctrlKey && key === "s") return "keybind-save";
		if (key === "escape") return "keybind-esc";

		return null;
	}

	/** @returns a disposer. A page that remounts must not stack handlers. */
	on(event: string, callback: KeybindHandler): () => void {
		const callbacks = this.#callbacks.get(event) ?? [];
		callbacks.push(callback);
		this.#callbacks.set(event, callbacks);
		return () => {
			const current = this.#callbacks.get(event);
			if (current === undefined) return;
			this.#callbacks.set(
				event,
				current.filter((candidate) => candidate !== callback),
			);
		};
	}

	/** @returns true when at least one handler claimed the event. */
	#emit(event: string): boolean {
		let handled = false;
		for (const callback of this.#callbacks.get(event) ?? []) {
			if (callback() === true) handled = true;
		}
		return handled;
	}
}
