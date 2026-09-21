import { useState } from "react";
import { cx } from "../../utils/cx";
import { Dialog } from "./Dialog";
import { SettingRow } from "./SettingRow";

export interface LanguageRowLabels {
	title: string;
	dialogTitle: string;
	automatic: string;
}

export interface LanguageRowProps {
	controlId: string;
	/** The stored preference, or `default`. */
	value: string;
	/** The language actually in effect after detection. */
	current: string;
	languages: Record<string, string>;
	labels: LanguageRowLabels;
}

/**
 * Language selection. Changing the language reloads the document, because the
 * i18n manager re-reads every locale module rather than swapping a dictionary
 * in place.
 */
export function LanguageRow({
	controlId,
	value,
	current,
	languages,
	labels,
}: LanguageRowProps) {
	const [open, setOpen] = useState(false);
	const summary =
		value === "default" ? labels.automatic : (languages[value] ?? value);

	const options: Array<[string, string]> = [
		["default", labels.automatic],
		...Object.entries(languages).sort(([, a], [, b]) => a.localeCompare(b)),
	];

	return (
		<>
			<SettingRow
				title={labels.title}
				summary={summary}
				onPress={() => setOpen(true)}
				trailing={
					<span
						className="text-onx-body text-onx-muted"
						data-testid={`${controlId}-value`}
					>
						{current}
					</span>
				}
			/>
			<Dialog
				open={open}
				onClose={() => setOpen(false)}
				title={labels.dialogTitle}
			>
				<ul className="onx-scroll m-0 flex min-h-0 flex-1 list-none flex-col gap-1 p-0">
					{options.map(([code, label]) => {
						const selected =
							code === "default" ? value === "default" : value === code;
						return (
							<li key={code}>
								<button
									type="button"
									aria-pressed={selected}
									onClick={() => {
										setOpen(false);
										import("../../i18n").then(({ i18n }) =>
											i18n.setLanguage(code),
										);
									}}
									className={cx(
										"flex h-12 w-full items-center rounded-onx-md px-4 text-start text-onx-body",
										selected
											? "bg-onx-container-high text-onx-on"
											: "text-onx-on",
									)}
								>
									{label}
								</button>
							</li>
						);
					})}
				</ul>
			</Dialog>
		</>
	);
}
