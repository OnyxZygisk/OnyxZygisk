import { useState } from "react";
import IconArticle from "~icons/material-symbols/article";
import IconChevron from "~icons/material-symbols/chevron-right";
import IconFunctions from "~icons/material-symbols/functions";
import IconHome from "~icons/material-symbols/home";
import IconSettings from "~icons/material-symbols/settings";
import IconWidgets from "~icons/material-symbols/widgets";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Card } from "../components/atoms/Card";
import { Icon } from "../components/atoms/Icon";
import { IconButton } from "../components/atoms/IconButton";
import { ProgressIndicator } from "../components/atoms/ProgressIndicator";
import { Slider } from "../components/atoms/Slider";
import { Switch } from "../components/atoms/Switch";
import { ChoiceRow } from "../components/molecules/ChoiceRow";
import { NavigationBar } from "../components/molecules/NavigationBar";
import { SectionHeader } from "../components/molecules/SectionHeader";
import {
	SettingRow,
	SettingRowList,
	SettingRowSeparator,
	SettingRowSwitch,
} from "../components/molecules/SettingRow";
import { snackbar } from "../components/molecules/Snackbar";
import { StatusField } from "../components/molecules/StatusField";
import { TopAppBar } from "../components/molecules/TopAppBar";

/**
 * Local review surface for the design standard. Vite drops this from
 * production builds, so it never reaches the module's webroot.
 */
const TYPE_ROLES = [
	["text-onx-display", "28 / 600"],
	["text-onx-title", "20 / 600"],
	["text-onx-body", "16 / 400"],
	["text-onx-body-strong", "16 / 500"],
	["text-onx-label", "14 / 500"],
	["text-onx-caption", "13 / 400"],
	["text-onx-mono", "13 / mono"],
] as const;

const SURFACES = [
	["background", "bg-onx-bg"],
	["surface", "bg-onx-surface"],
	["container", "bg-onx-container"],
	["container-high", "bg-onx-container-high"],
] as const;

const THEME_VALUES = ["light", "dark", "amoled"] as const;

const APPEARANCE_OPTIONS = ["auto", "light", "dark", "amoled"] as const;

/** Long enough to prove status values wrap instead of clipping. */
const LONG_VALUE =
	"/data/adb/modules/onyxzygisk/webroot/assets/index-4f2a9c1e9b7d.js";

export interface GalleryViewProps {
	/** The concrete theme currently applied to the document. */
	theme: string;
	/** The stored preference, which may be `auto`. */
	appearance: string;
	onAppearanceChange: (mode: string) => void;
	scale: number;
	onScaleChange: (value: number) => void;
}

export function GalleryView({
	theme,
	appearance,
	onAppearanceChange,
	scale,
	onScaleChange,
}: GalleryViewProps) {
	const [nav, setNav] = useState(0);
	const [switched, setSwitched] = useState(true);

	return (
		<div className="min-h-dvh bg-onx-bg pb-8 text-onx-on">
			<TopAppBar
				title="Design gallery"
				actions={
					<IconButton aria-label="Settings">
						<Icon as={IconSettings} />
					</IconButton>
				}
			/>

			<SectionHeader>Appearance</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<ChoiceRow
						controlId="g-appearance"
						value={appearance}
						onChange={onAppearanceChange}
						choices={APPEARANCE_OPTIONS}
						labels={{
							title: "Appearance",
							dialogTitle: "Appearance",
							options: {
								auto: "Automatic",
								light: "Light",
								dark: "Night",
								amoled: "Night (pure black)",
							},
						}}
					/>
					<SettingRowSeparator />
					<SettingRow
						title="Resolved theme"
						summary="What the document is actually using"
						trailing={
							<span className="text-onx-body text-onx-muted">{theme}</span>
						}
					/>
				</SettingRowList>
				<div className="mt-3 flex flex-wrap gap-2">
					{THEME_VALUES.map((value) => (
						<Button
							key={value}
							variant={theme === value ? "primary" : "secondary"}
							aria-pressed={theme === value}
							aria-label={`Preview: ${value}`}
							onClick={() => onAppearanceChange(value)}
						>
							{value}
						</Button>
					))}
				</div>
			</div>

			<SectionHeader>Typography</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-3">
					{TYPE_ROLES.map(([token, meta]) => (
						<div
							key={token}
							className="flex items-baseline justify-between gap-3"
						>
							<span className={token}>The quick brown fox</span>
							<span className="shrink-0 text-onx-mono text-onx-muted">
								{meta}
							</span>
						</div>
					))}
				</Card>
			</div>

			<SectionHeader>Surfaces</SectionHeader>
			<div className="px-4">
				<div className="overflow-hidden rounded-onx-lg border border-onx-divider">
					{SURFACES.map(([name, cls]) => (
						<div
							key={name}
							className={`${cls} flex items-center justify-between px-4 py-3`}
						>
							<span className="text-onx-body-strong">{name}</span>
							<span className="text-onx-mono text-onx-muted">{cls}</span>
						</div>
					))}
				</div>
			</div>

			<SectionHeader>Buttons</SectionHeader>
			<div className="flex flex-col gap-3 px-4">
				<Card className="flex flex-wrap items-center gap-2">
					<Button>Primary</Button>
					<Button variant="secondary">Secondary</Button>
					<Button variant="ghost">Ghost</Button>
				</Card>
				<Card className="flex flex-wrap items-center gap-2">
					<Button busy>Primary</Button>
					<Button variant="secondary" busy>
						Secondary
					</Button>
					<Button disabled aria-label="Primary disabled">
						Disabled
					</Button>
					<Button variant="secondary" disabled aria-label="Secondary disabled">
						Disabled
					</Button>
					<IconButton aria-label="Browse">
						<Icon as={IconHome} />
					</IconButton>
					<IconButton aria-label="Open settings" disabled>
						<Icon as={IconSettings} />
					</IconButton>
				</Card>
				<Card className="flex flex-wrap items-center gap-2">
					<Badge>outline</Badge>
					<Badge variant="solid">solid</Badge>
					<ProgressIndicator aria-label="Loading" />
					<ProgressIndicator
						variant="linear"
						aria-label="Loading"
						className="max-w-32"
					/>
				</Card>
				<Card className="flex flex-wrap gap-2">
					<Button
						variant="secondary"
						onClick={() => snackbar.show("Hot-plug applied.")}
					>
						Show snackbar
					</Button>
					<Button
						variant="secondary"
						onClick={() =>
							snackbar.show("The daemon rejected the request.", "error")
						}
					>
						Show error snackbar
					</Button>
				</Card>
			</div>

			<SectionHeader>Settings rows</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<SettingRowSwitch
						controlId="g-switch"
						title="Switch row"
						summary="Off is a bounded container, on is an accent fill."
						checked={switched}
						onChange={setSwitched}
					/>
					<SettingRowSeparator />
					<SettingRow
						title="Navigate row"
						summary="Rendered as a real button."
						onPress={() => undefined}
						trailing={
							<Icon as={IconChevron} size="md" className="text-onx-muted" />
						}
					/>
					<SettingRowSeparator />
					<SettingRow
						title="Value row"
						onPress={() => undefined}
						trailing={
							<span className="flex items-center gap-1">
								<span className="text-onx-body text-onx-muted">revert</span>
								<Icon as={IconChevron} size="md" className="text-onx-muted" />
							</span>
						}
					/>
					<SettingRowSeparator />
					<SettingRow
						title="Slider row"
						summary={`Interface scale: ${scale}%`}
						trailing={
							<span className="flex w-32 items-center">
								<Slider
									aria-label="Interface scale"
									value={scale}
									min={80}
									max={120}
									step={5}
									onChange={onScaleChange}
								/>
							</span>
						}
					/>
					<SettingRowSeparator />
					<SettingRow
						title="Disabled row"
						summary="Inert, and it says so."
						disabled
						trailing={
							<Switch
								checked={false}
								onChange={() => undefined}
								aria-label="Disabled row"
								disabled
							/>
						}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>Status tones</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-4">
					<StatusField label="State" value="Working" />
					<StatusField label="Monitor" value="tracing" />
					<StatusField label="Daemon" value="Stopped" tone="error" />
					<StatusField label="Runtime" value="Checking" tone="pending" />
					<StatusField
						label="Module files"
						value="Not installed"
						tone="unavailable"
					/>
					<StatusField label="Work directory" value={LONG_VALUE} />
				</Card>
			</div>

			<SectionHeader>Raw controls</SectionHeader>
			<div className="flex items-center gap-6 px-4">
				<Switch
					checked={switched}
					onChange={setSwitched}
					aria-label="Raw switch"
				/>
				<span className="w-40">
					<Slider
						aria-label="Raw slider"
						value={scale}
						min={80}
						max={120}
						step={5}
						onChange={onScaleChange}
					/>
				</span>
			</div>

			<SectionHeader>Log rows</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-1 text-onx-mono">
					<span>
						<span className="onx-log-level">V</span>/
						<span className="onx-log-tag">zygiskd(1234)</span>:{" "}
						<span className="onx-log-message-muted">verbose line</span>
					</span>
					<span>
						<span className="onx-log-level">I</span>/
						<span className="onx-log-tag">zygiskd(1234)</span>: monitor tracing
					</span>
					<span>
						<span className="onx-log-level-strong">E</span>/
						<span className="onx-log-tag">zygisk-sh(1201)</span>: FN node exited
					</span>
				</Card>
			</div>

			<SectionHeader>Navigation</SectionHeader>
			<div className="mx-4 overflow-hidden rounded-onx-lg border border-onx-divider">
				<NavigationBar
					label="Main"
					value={nav}
					onChange={setNav}
					items={[
						{ id: "status", label: "Status", icon: IconHome },
						{ id: "modules", label: "Modules", icon: IconWidgets },
						{ id: "fn", label: "FN", icon: IconFunctions },
						{ id: "logs", label: "Logs", icon: IconArticle },
					]}
				/>
			</div>
		</div>
	);
}
