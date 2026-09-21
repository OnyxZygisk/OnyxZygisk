import { useEffect, useState } from "react";
import { cx } from "../../utils/cx";

export type SnackbarTone = "normal" | "error";

export interface SnackbarItem {
	id: number;
	message: string;
	tone: SnackbarTone;
}

const DURATION_MS = 4000;

type Listener = (items: readonly SnackbarItem[]) => void;

/**
 * A queue of transient messages. Kept outside React so any module can report
 * feedback without threading a context through the tree.
 */
class SnackbarStore {
	#items: readonly SnackbarItem[] = [];
	#listeners = new Set<Listener>();
	#nextId = 1;
	#timers = new Map<number, ReturnType<typeof setTimeout>>();

	show(message: string, tone: SnackbarTone = "normal"): number {
		const id = this.#nextId++;
		this.#items = [...this.#items, { id, message, tone }];
		this.#emit();
		this.#timers.set(
			id,
			setTimeout(() => this.dismiss(id), DURATION_MS),
		);
		return id;
	}

	dismiss(id: number): void {
		const timer = this.#timers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(id);
		}
		this.#items = this.#items.filter((item) => item.id !== id);
		this.#emit();
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		listener(this.#items);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(): void {
		for (const listener of this.#listeners) listener(this.#items);
	}
}

export const snackbar = new SnackbarStore();

/**
 * Inverse surface: the only element allowed to invert. Tone is carried by a
 * leading glyph and a boundary, never by hue.
 */
export function SnackbarHost({ className }: { className?: string }) {
	const [items, setItems] = useState<readonly SnackbarItem[]>([]);

	useEffect(() => snackbar.subscribe(setItems), []);

	return (
		<div
			aria-live="polite"
			aria-atomic="false"
			style={{ paddingBottom: "calc(var(--onx-bottom-inset) + 16px)" }}
			className={cx(
				"pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-4",
				className,
			)}
		>
			{items.map((item) => (
				<output
					key={item.id}
					className={cx(
						"pointer-events-auto flex min-h-12 w-full max-w-100 items-center gap-2 rounded-onx-md bg-onx-on px-4 py-3 text-onx-body text-onx-bg",
						item.tone === "error" && "ring-1 ring-onx-hairline-strong",
					)}
				>
					{item.tone === "error" ? (
						<span aria-hidden="true" className="text-onx-label">
							!
						</span>
					) : null}
					<span className="min-w-0 wrap-anywhere">{item.message}</span>
				</output>
			))}
		</div>
	);
}
