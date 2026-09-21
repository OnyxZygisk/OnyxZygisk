import {
	DialogPanel,
	DialogTitle,
	Dialog as HeadlessDialog,
} from "@headlessui/react";
import type { ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface DialogProps {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	className?: string;
}

/** Modal: centred panel over a scrim, with a fresh focus trap per opening. */
export function Dialog({
	open,
	onClose,
	title,
	children,
	className,
}: DialogProps) {
	return (
		<HeadlessDialog
			open={open}
			onClose={onClose}
			className="fixed inset-0 z-50"
		>
			<div
				aria-hidden="true"
				className="fixed inset-0 bg-onx-scrim transition-opacity duration-200"
			/>
			<div className="fixed inset-0 flex items-center justify-center p-4">
				{/*
				 * The panel owns the height limit and is a flex column, so a long
				 * child list fills the remaining space and clips at the panel edge.
				 * Capping the list itself with a fixed height instead puts the cut
				 * wherever that number happens to fall — often on an item boundary,
				 * which reads as "the list ends here".
				 */}
				<DialogPanel
					className={cx(
						"flex max-h-[85dvh] w-full max-w-90 flex-col rounded-onx-lg bg-onx-surface p-4",
						className,
					)}
				>
					<DialogTitle className="text-onx-title text-onx-on">
						{title}
					</DialogTitle>
					<div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
				</DialogPanel>
			</div>
		</HeadlessDialog>
	);
}
