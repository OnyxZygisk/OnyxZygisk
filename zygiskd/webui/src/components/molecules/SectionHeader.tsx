import type { ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface SectionHeaderProps {
	children: ReactNode;
	className?: string;
}

export function SectionHeader({ children, className }: SectionHeaderProps) {
	return (
		<h2
			className={cx("px-4 pt-6 pb-1 text-onx-label text-onx-muted", className)}
		>
			{children}
		</h2>
	);
}
