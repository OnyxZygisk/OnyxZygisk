import type { ButtonHTMLAttributes } from "react";
import { cx } from "../../utils/cx";

export interface IconButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement> {
	/** Icon-only controls must always expose an accessible name. */
	"aria-label": string;
}

export function IconButton({
	className,
	children,
	type = "button",
	...rest
}: IconButtonProps) {
	return (
		<button
			{...rest}
			type={type}
			className={cx(
				"inline-flex size-10 shrink-0 items-center justify-center rounded-onx-md text-onx-on transition-colors",
				"hover:bg-onx-container active:bg-onx-container-high",
				"disabled:text-onx-disabled disabled:hover:bg-transparent",
				className,
			)}
		>
			{children}
		</button>
	);
}
