import { MOUNT_MODES, type MountMode } from "../cli_parse";
import { Card } from "../components/atoms/Card";
import { Slider } from "../components/atoms/Slider";
import { ChoiceRow } from "../components/molecules/ChoiceRow";
import { LanguageRow } from "../components/molecules/LanguageRow";
import { SectionHeader } from "../components/molecules/SectionHeader";
import {
	SettingRow,
	SettingRowList,
	SettingRowSwitch,
} from "../components/molecules/SettingRow";
import type { SnackbarTone } from "../components/molecules/Snackbar";
import { i18n } from "../i18n";
import { MODULE_NAME } from "../module_info";
import { cli } from "../state/app";
import { messageOf, type SystemSnapshot } from "../state/system";
import { tr } from "../utils/tr";

/** Interface scale bounds, in percent. */
export const SCALE_MIN = 80;
export const SCALE_MAX = 120;
export const SCALE_STEP = 5;

export interface SettingsViewProps {
	appearance: string;
	onAppearanceChange: (value: string) => void;
	scale: number;
	onScaleChange: (value: number) => void;
	snapshot: SystemSnapshot;
	onRefresh: () => Promise<void>;
	onNotify: (message: string, tone: SnackbarTone) => void;
}

const APPEARANCE_MODES = ["auto", "light", "dark", "amoled"] as const;

export function SettingsView({
	appearance,
	onAppearanceChange,
	scale,
	onScaleChange,
	snapshot,
	onRefresh,
	onNotify,
}: SettingsViewProps) {
	const masterOn = snapshot.state?.keys.hotplug !== "0";
	const mountMode = snapshot.state?.keys.mount_mode ?? "revert";

	async function toggleMaster(enabled: boolean): Promise<void> {
		try {
			await cli.setHotplugMaster(enabled);
			await onRefresh();
		} catch (error) {
			onNotify(messageOf(error), "error");
		}
	}

	async function changeMountMode(mode: string): Promise<void> {
		try {
			await cli.setMountMode(mode as MountMode);
			await onRefresh();
		} catch (error) {
			onNotify(messageOf(error), "error");
		}
	}

	return (
		<>
			<SectionHeader>
				{tr("settings_appearance_section", "Appearance")}
			</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<ChoiceRow
						controlId="appearance"
						value={appearance}
						onChange={onAppearanceChange}
						choices={APPEARANCE_MODES}
						labels={{
							title: tr("settings_appearance", "Appearance"),
							dialogTitle: tr("settings_appearance", "Appearance"),
							options: {
								auto: tr("settings_appearance_auto", "Automatic"),
								light: tr("settings_appearance_light", "Light"),
								dark: tr("settings_appearance_dark", "Night"),
								amoled: tr("settings_appearance_amoled", "Night (pure black)"),
							},
						}}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>
				{tr("settings_language_section", "Language")}
			</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<LanguageRow
						controlId="language"
						value={i18n.preference}
						current={i18n.lang}
						languages={i18n.languages}
						labels={{
							title: tr("settings_language", "Language"),
							dialogTitle: tr("settings_language", "Language"),
							automatic: tr("settings_language_auto", "Follow system"),
						}}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>
				{tr("settings_interaction_section", "Interaction")}
			</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					{/*
					 * The slider lives in the row's trailing slot rather than in the row body,
					 * so the wrapper — not the slider — carries the width. Size the wrapper
					 * and let the control fill whatever it is given.
					 */}
					<SettingRow
						title={tr("settings_scale", "Interface scale")}
						summary={tr(
							"settings_scale_summary",
							"Adjust the overall display size",
						)}
						trailing={
							<span className="flex w-32 items-center">
								<Slider
									aria-label={tr("settings_scale", "Interface scale")}
									value={scale}
									min={SCALE_MIN}
									max={SCALE_MAX}
									step={SCALE_STEP}
									onChange={onScaleChange}
								/>
							</span>
						}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>
				{tr("settings_host_section", "Zygisk host")}
			</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<SettingRowSwitch
						controlId="hotplug-master"
						title={tr("settings_hotplug", "Hot-plug")}
						summary={tr(
							"settings_hotplug_summary",
							"When off, staged updates wait for a reboot",
						)}
						checked={masterOn}
						onChange={(next) => void toggleMaster(next)}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>
				{tr("settings_mount_section", "Mount mode")}
			</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<ChoiceRow
						controlId="mount-mode"
						value={mountMode}
						onChange={(mode) => void changeMountMode(mode)}
						choices={MOUNT_MODES}
						labels={{
							title: tr("settings_mount_mode", "Mount mode"),
							dialogTitle: tr("settings_mount_mode", "Mount mode"),
							options: {
								revert: tr("settings_mount_mode_revert", "Revert only"),
								setns: tr("settings_mount_mode_setns", "Namespace switch"),
								global: tr("settings_mount_mode_global", "Global"),
							},
						}}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>{tr("settings_about_section", "About")}</SectionHeader>
			<div className="px-4 pb-8">
				<Card className="flex flex-col gap-2">
					<span className="text-onx-body-strong text-onx-on">
						{MODULE_NAME}
					</span>
					<span className="text-onx-caption text-onx-muted">
						{tr(
							"settings_about_text",
							"A Zygisk implementation via ptrace, with FN (Functional Node) modules. A fork of NeoZygisk.",
						)}
					</span>
				</Card>
			</div>
		</>
	);
}
