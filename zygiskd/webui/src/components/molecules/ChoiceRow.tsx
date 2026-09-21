import { useState } from "react";
import { cx } from "../../utils/cx";
import { Dialog } from "./Dialog";
import { SettingRow } from "./SettingRow";

export interface ChoiceRowLabels {
	title: string;
	/** Optional: a one-word key such as "Mode" reads as a stray label here. */
	summary?: string;
	dialogTitle: string;
	options: Record<string, string>;
}

export interface ChoiceRowProps {
	value: string;
	onChange: (value: string) => void;
	choices: readonly string[];
	labels: ChoiceRowLabels;
	controlId: string;
}

/**
 * A copy-free picker: every visible string arrives through `labels`, so the
 * owning view supplies it from i18n rather than the component hard-coding one.
 * Appearance and mount mode are the same control with different options, so
 * they share this component rather than each growing a `<select>` — the WebUI
 * is touch-only and a native dropdown renders as a desktop popup in a WebView.
 */
export function ChoiceRow({
	value,
	onChange,
	choices,
	labels,
	controlId,
}: ChoiceRowProps) {
	const [open, setOpen] = useState(false);

	return (
		<>
			<SettingRow
				title={labels.title}
				summary={labels.summary}
				onPress={() => setOpen(true)}
				trailing={
					<span
						className="text-onx-body text-onx-muted"
						data-testid={`${controlId}-value`}
					>
						{labels.options[value] ?? value}
					</span>
				}
			/>
			<Dialog
				open={open}
				onClose={() => setOpen(false)}
				title={labels.dialogTitle}
			>
				<ul className="onx-scroll m-0 flex min-h-0 flex-1 list-none flex-col gap-1 p-0">
					{choices.map((choice) => {
						const selected = choice === value;
						return (
							<li key={choice}>
								<button
									type="button"
									aria-pressed={selected}
									onClick={() => {
										onChange(choice);
										setOpen(false);
									}}
									className={cx(
										"flex h-12 w-full items-center justify-between rounded-onx-md px-4 text-start text-onx-body",
										selected
											? "bg-onx-container-high text-onx-on"
											: "text-onx-on",
									)}
								>
									<span>{labels.options[choice] ?? choice}</span>
									{selected ? (
										<svg
											aria-hidden="true"
											focusable="false"
											viewBox="0 0 16 16"
											className="size-4 fill-none stroke-current stroke-[2.5]"
										>
											<path
												d="M3 8.5 6.2 11.5 13 4.5"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
			</Dialog>
		</>
	);
}
