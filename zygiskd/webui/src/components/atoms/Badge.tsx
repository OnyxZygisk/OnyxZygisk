import type { ReactNode } from "react";
import { cx } from "../../utils/cx";

export type BadgeVariant = "solid" | "outline";

export interface BadgeProps {
	variant?: BadgeVariant;
	children: ReactNode;
	className?: string;
}

const VARIANTS: Record<BadgeVariant, string> = {
	solid: "bg-onx-accent text-onx-on-accent",
	outline: "border border-onx-divider text-onx-muted",
};

export function Badge({
	variant = "outline",
	children,
	className,
}: BadgeProps) {
	return (
		<span
			className={cx(
				"inline-flex h-5 shrink-0 items-center rounded-onx-sm px-1.5 text-onx-caption",
				VARIANTS[variant],
				className,
			)}
		>
			{children}
		</span>
	);
}
