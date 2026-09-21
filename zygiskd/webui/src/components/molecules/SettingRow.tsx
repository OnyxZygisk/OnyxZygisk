import type { ReactNode } from "react";
import { cx } from "../../utils/cx";
import { Divider } from "../atoms/Divider";
import { Switch } from "../atoms/Switch";

export interface SettingRowProps {
	icon?: ReactNode;
	title: string;
	summary?: string;
	trailing?: ReactNode;
	disabled?: boolean;
	/** Present makes the whole row an activatable button. */
	onPress?: () => void;
	className?: string;
}

const ROW = "flex w-full items-start gap-3 px-4 text-start";

function RowText({
	icon,
	title,
	summary,
	trailing,
	disabled = false,
}: SettingRowProps) {
	return (
		<>
			{icon ? (
				<span
					className={cx(
						"mt-3.5 flex size-6 items-center",
						disabled ? "text-onx-disabled" : "text-onx-muted",
					)}
				>
					{icon}
				</span>
			) : null}
			<span className="flex min-w-0 flex-1 flex-col justify-center py-3.5">
				<span
					className={cx(
						"text-onx-body-strong",
						disabled ? "text-onx-disabled" : "text-onx-on",
					)}
				>
					{title}
				</span>
				{summary ? (
					<span
						className={cx(
							"text-onx-caption",
							disabled ? "text-onx-disabled" : "text-onx-muted",
						)}
					>
						{summary}
					</span>
				) : null}
			</span>
			{trailing ? (
				<span className="flex shrink-0 items-center self-center">
					{trailing}
				</span>
			) : null}
		</>
	);
}

/**
 * The shared row anatomy: a `button` when it navigates, a `div` when it is
 * inert.
 *
 * A row that owns a toggle is neither. It is the control itself — see
 * `SettingRowSwitch` — because a `<label>` that wraps a control *and* points
 * at it with `htmlFor` forwards the activation a second time, toggling the
 * value back to where it started.
 */
export function SettingRow({
	onPress,
	disabled = false,
	className,
	...content
}: SettingRowProps) {
	const body = <RowText {...content} disabled={disabled} />;
	const base = cx(ROW, "min-h-14", className);

	if (onPress !== undefined) {
		return (
			<button
				type="button"
				onClick={onPress}
				disabled={disabled}
				className={cx(base, "transition-colors active:bg-onx-container-high")}
			>
				{body}
			</button>
		);
	}
	return (
		<div aria-disabled={disabled || undefined} className={base}>
			{body}
		</div>
	);
}

export interface SettingRowControlProps
	extends Omit<SettingRowProps, "trailing" | "onPress" | "className"> {
	checked: boolean;
	onChange: (checked: boolean) => void;
	controlId: string;
	/**
	 * Accessible name for the control. Defaults to the row title, which is right
	 * for a row whose toggle *is* the fact it describes; a row that owns a
	 * narrower toggle (a per-module hot-plug switch inside a row named after the
	 * module) passes the narrower label instead.
	 */
	controlLabel?: string;
	className?: string;
}

export function SettingRowSwitch({
	checked,
	onChange,
	controlId,
	...row
}: SettingRowControlProps) {
	return (
		<Switch
			id={controlId}
			checked={checked}
			onChange={onChange}
			disabled={row.disabled}
			/*
			 * The control carries its own name. Headless UI renders a
			 * `role="switch"` button, and Chromium's accessible-name computation
			 * for a button does not consume the surrounding text, so without this
			 * the switch is unnamed — a failure axe only reports as
			 * `aria-input-field-name`.
			 */
			aria-label={row.controlLabel ?? row.title}
			className={cx("min-h-14", row.className)}
		>
			<RowText {...row} />
		</Switch>
	);
}

export interface SettingRowListProps {
	children: ReactNode;
	className?: string;
}

/** A card-like group whose rows are separated by inset hairlines. */
export function SettingRowList({ children, className }: SettingRowListProps) {
	return (
		<div
			className={cx(
				"overflow-hidden rounded-onx-lg bg-onx-container",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function SettingRowSeparator() {
	return <Divider inset />;
}
