import type { HTMLAttributes } from "react";
import { cx } from "../../utils/cx";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
	pressable?: boolean;
	/**
	 * Default true. A `className` padding override cannot turn it off: two
	 * padding utilities in one class list are resolved by stylesheet order, not
	 * by the order they are written, so the card silently kept its padding.
	 */
	padded?: boolean;
}

/** Fill-based elevation: a container step, never a shadow. */
export function Card({
	pressable = false,
	padded = true,
	className,
	...rest
}: CardProps) {
	return (
		<div
			{...rest}
			className={cx(
				"rounded-onx-lg bg-onx-container",
				padded && "p-4",
				pressable && "transition-colors active:bg-onx-container-high",
				className,
			)}
		/>
	);
}
