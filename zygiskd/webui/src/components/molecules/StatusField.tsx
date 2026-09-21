import { cx } from "../../utils/cx";

export type StatusTone = "normal" | "error" | "pending" | "unavailable";

export interface StatusFieldProps {
	label: string;
	value: string;
	tone?: StatusTone;
	className?: string;
}

/**
 * Tone without hue. Colour used to carry this signal; now a leading glyph plus
 * weight does, and the value text always states the condition outright so a
 * screen reader receives the same information.
 */
export function StatusField({
	label,
	value,
	tone = "normal",
	className,
}: StatusFieldProps) {
	const isError = tone === "error";
	const isPending = tone === "pending";
	const isUnavailable = tone === "unavailable";

	return (
		<div
			className={cx(
				"flex min-w-0 flex-col gap-1",
				isError && "rounded-onx-sm px-2 py-1 ring-1 ring-onx-hairline-strong",
				className,
			)}
		>
			<span className="text-onx-caption text-onx-muted">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5">
				{isError ? (
					<span aria-hidden="true" className="text-onx-on text-onx-label">
						!
					</span>
				) : null}
				{isPending ? (
					<span
						aria-hidden="true"
						className="inline-block size-3 animate-spin rounded-full border-2 border-onx-divider border-t-onx-on"
					/>
				) : null}
				<span
					className={cx(
						"min-w-0 wrap-anywhere",
						isUnavailable
							? "text-onx-body text-onx-muted"
							: "text-onx-body-strong text-onx-on",
						isPending && "text-onx-muted",
					)}
				>
					{value}
				</span>
			</span>
		</div>
	);
}
