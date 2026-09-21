import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../utils/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	busy?: boolean;
	leading?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
	primary: "bg-onx-accent text-onx-on-accent",
	secondary: "border border-onx-divider text-onx-on",
	ghost: "text-onx-on",
};

const PADDING: Record<ButtonVariant, string> = {
	primary: "px-5",
	secondary: "px-5",
	ghost: "px-3",
};

export function Button({
	variant = "primary",
	busy = false,
	leading,
	disabled,
	className,
	children,
	type = "button",
	...rest
}: ButtonProps) {
	const inert = busy || disabled === true;
	return (
		<button
			{...rest}
			type={type}
			disabled={inert}
			aria-busy={busy || undefined}
			className={cx(
				"inline-flex h-10 items-center justify-center gap-2 rounded-onx-md text-onx-label transition-colors",
				PADDING[variant],
				VARIANTS[variant],
				!inert && variant !== "primary" && "active:bg-onx-container-high",
				!inert && variant !== "primary" && "hover:bg-onx-container",
				disabled === true && "text-onx-disabled",
				disabled === true &&
					variant === "primary" &&
					"bg-onx-divider text-onx-disabled",
				disabled === true &&
					variant !== "primary" &&
					"border-onx-divider text-onx-disabled",
				className,
			)}
		>
			{busy ? <CircularGlyph /> : leading}
			{children}
		</button>
	);
}

function CircularGlyph() {
	return (
		<span
			aria-hidden="true"
			className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
		/>
	);
}
