import { cx } from "../../utils/cx";

export interface ProgressIndicatorProps {
	variant?: "circular" | "linear";
	size?: number;
	className?: string;
	"aria-label"?: string;
}

export function ProgressIndicator({
	variant = "circular",
	size = 24,
	className,
	"aria-label": ariaLabel,
}: ProgressIndicatorProps) {
	if (variant === "linear") {
		return (
			<div
				role="progressbar"
				aria-label={ariaLabel}
				className={cx(
					"h-0.5 w-full overflow-hidden rounded-full bg-onx-container-high",
					className,
				)}
			>
				<div className="h-full w-1/3 animate-pulse rounded-full bg-onx-accent" />
			</div>
		);
	}

	return (
		<span
			role="progressbar"
			aria-label={ariaLabel}
			style={{ width: size, height: size }}
			className={cx(
				"inline-block animate-spin rounded-full border-2 border-onx-divider border-t-onx-on",
				className,
			)}
		/>
	);
}
