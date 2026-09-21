import { Switch as HeadlessSwitch } from "@headlessui/react";
import type { ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface SwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	id?: string;
	/**
	 * When provided the control renders as a full-width row with this content
	 * beside it. The row and the control are then the same element, so one tap
	 * activates it once — a <label> wrapping a control it also points at
	 * forwards the click a second time and cancels the toggle out.
	 */
	children?: ReactNode;
	className?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
}

const TRACK =
	"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors";

export function Switch({
	checked,
	onChange,
	disabled = false,
	id,
	children,
	className,
	...aria
}: SwitchProps) {
	const track = cx(
		TRACK,
		checked
			? "border-onx-accent bg-onx-accent"
			: "border-onx-divider bg-onx-container-high",
	);
	const thumb = (
		<span
			className={cx(
				"inline-block size-4 rounded-full transition-transform duration-150",
				checked
					? "translate-x-4 bg-onx-on-accent"
					: "translate-x-0.5 bg-onx-on",
			)}
		/>
	);

	return (
		<HeadlessSwitch
			checked={checked}
			onChange={onChange}
			disabled={disabled}
			id={id}
			{...aria}
			className={cx(
				children === undefined
					? cx(track, "align-middle", disabled && "opacity-50", className)
					: cx(
							"flex w-full items-center gap-3 px-4 text-start",
							disabled && "text-onx-disabled",
							className,
						),
			)}
		>
			{children}
			{children === undefined ? (
				thumb
			) : (
				<span className={cx(track, disabled && "opacity-50")}>{thumb}</span>
			)}
		</HeadlessSwitch>
	);
}
