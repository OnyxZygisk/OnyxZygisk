import type { ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface TopAppBarProps {
	title: string;
	onBack?: () => void;
	backLabel?: string;
	actions?: ReactNode;
	className?: string;
}

/**
 * Always titled with the module name. A drill-down adds a back button instead
 * of a page title: the navigation bar already marks which page is current, so
 * repeating it here only costs the title the width it needs.
 */
export function TopAppBar({
	title,
	onBack,
	backLabel = "Back",
	actions,
	className,
}: TopAppBarProps) {
	return (
		<header
			style={{ paddingTop: "var(--onx-top-inset)" }}
			className={cx(
				"sticky top-0 z-10 border-b border-onx-divider bg-onx-surface",
				className,
			)}
		>
			<div
				style={{ height: "var(--onx-appbar-height)" }}
				className="flex items-center gap-2 px-2"
			>
				{onBack ? (
					<button
						type="button"
						onClick={onBack}
						aria-label={backLabel}
						className="inline-flex size-10 shrink-0 items-center justify-center rounded-onx-md text-onx-on active:bg-onx-container-high"
					>
						<svg
							aria-hidden="true"
							focusable="false"
							viewBox="0 0 24 24"
							className="size-6 fill-none stroke-current stroke-2"
						>
							<path
								d="M15 5 8 12l7 7"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				) : null}
				<h1 className="min-w-0 flex-1 truncate px-2 text-onx-title text-onx-on">
					{title}
				</h1>
				{actions ? (
					<div className="flex shrink-0 items-center gap-1">{actions}</div>
				) : null}
			</div>
		</header>
	);
}
