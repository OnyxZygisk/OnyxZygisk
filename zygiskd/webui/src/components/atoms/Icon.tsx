import type { ComponentType, SVGProps } from "react";
import { cx } from "../../utils/cx";

export type IconSize = "sm" | "md" | "lg";

const PIXELS: Record<IconSize, number> = { sm: 16, md: 20, lg: 24 };

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
	/** A `~icons/<collection>/<name>` component. */
	as: ComponentType<SVGProps<SVGSVGElement>>;
	size?: IconSize;
}

/**
 * Decorative by default: screen readers read the adjacent label instead.
 * Pass an explicit `aria-label` and `role="img"` when an icon is the only
 * carrier of meaning.
 */
export function Icon({
	as: Glyph,
	size = "lg",
	className,
	...rest
}: IconProps) {
	const pixels = PIXELS[size];
	return (
		<Glyph
			aria-hidden="true"
			focusable="false"
			height={pixels}
			width={pixels}
			className={cx("shrink-0", className)}
			{...rest}
		/>
	);
}
