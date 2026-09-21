import type { ComponentType, SVGProps } from "react";
import { cx } from "../../utils/cx";
import { Icon } from "../atoms/Icon";

export interface NavigationItem {
	id: string;
	label: string;
	icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export interface NavigationBarProps {
	items: readonly NavigationItem[];
	value: number;
	onChange: (index: number) => void;
	/** Accessible name for the <nav> landmark. */
	label: string;
	className?: string;
}

/**
 * Selected state is a `container-high` pill behind the icon plus a medium
 * label. With no hue available, the surface step is the strongest signal that
 * does not compete with the label for attention; an indicator bar would be a
 * second, redundant signal.
 */
export function NavigationBar({
	items,
	value,
	onChange,
	label,
	className,
}: NavigationBarProps) {
	return (
		<nav
			aria-label={label}
			style={{ paddingBottom: "var(--onx-bottom-inset)" }}
			className={cx(
				"sticky bottom-0 z-10 border-t border-onx-divider bg-onx-surface",
				className,
			)}
		>
			<ul
				className="m-0 flex list-none items-stretch p-0"
				style={{ height: "var(--onx-nav-height)" }}
			>
				{items.map((item, index) => {
					const selected = index === value;
					return (
						<li key={item.id} className="flex-1">
							<button
								type="button"
								onClick={() => onChange(index)}
								aria-current={selected ? "page" : undefined}
								className={cx(
									"flex h-full w-full flex-col items-center justify-center gap-0.5",
									selected ? "text-onx-on" : "text-onx-muted",
								)}
							>
								<span
									className={cx(
										"flex h-7 w-12 items-center justify-center rounded-full transition-colors",
										selected && "bg-onx-container-high",
									)}
								>
									<Icon as={item.icon} size="md" />
								</span>
								<span
									className={cx("text-onx-caption", selected && "font-medium")}
								>
									{item.label}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
