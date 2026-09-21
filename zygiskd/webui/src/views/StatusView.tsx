import { formatVersion, type MonitorRow } from "../cli_parse";
import { Card } from "../components/atoms/Card";
import { SectionHeader } from "../components/molecules/SectionHeader";
import { SettingRow, SettingRowList } from "../components/molecules/SettingRow";
import {
	StatusField,
	type StatusTone,
} from "../components/molecules/StatusField";
import type { SystemSnapshot } from "../state/system";
import { tr } from "../utils/tr";

export interface StatusViewProps {
	snapshot: SystemSnapshot;
}

/** The monitor writes `label: value` rows; find one by label. */
function rowValue(
	rows: readonly MonitorRow[] | undefined,
	label: string,
): string | undefined {
	return rows?.find((candidate) => candidate.label === label)?.value;
}

/**
 * Tone without hue. Only a genuinely stopped monitor is an error: a zygote
 * that has not been injected yet just means no app has forked since boot,
 * which the value text states outright.
 */
function toneOf(value: string | undefined): StatusTone {
	if (value === undefined || value.trim() === "") return "unavailable";
	if (/stopped|exited|crashed/i.test(value)) return "error";
	return "normal";
}

/**
 * Mount mode is a closed set, so the label is resolved through literal keys.
 * Building the key by concatenation would hide all three from the i18n guard,
 * which can only see whole string literals.
 */
function mountModeLabel(mode: string): string {
	const labels: Record<string, string> = {
		revert: tr("settings_mount_mode_revert", "Revert only"),
		setns: tr("settings_mount_mode_setns", "Namespace switch"),
		global: tr("settings_mount_mode_global", "Global"),
	};
	return labels[mode] ?? mode;
}

function flag(on: boolean | undefined, yes: string, no: string): string {
	if (on === undefined) return tr("common_not_available", "Not available");
	return on ? yes : no;
}

export function StatusView({ snapshot }: StatusViewProps) {
	const state = snapshot.state;
	const monitor = rowValue(state?.monitor, "monitor");
	const daemon =
		rowValue(state?.monitor, "daemon64") ??
		rowValue(state?.monitor, "daemon32");
	const zygote64 = rowValue(state?.monitor, "zygote64");
	const zygote32 = rowValue(state?.monitor, "zygote32");
	const detail = (state?.monitor ?? []).filter((row) => row.label === null);

	const absent = tr("common_not_available", "Not available");
	const installed =
		state?.keys.installed === undefined
			? undefined
			: state.keys.installed === "1";
	const runtime =
		state?.keys.runtime === undefined ? undefined : state.keys.runtime === "1";
	const hotplug =
		state?.keys.hotplug === undefined ? undefined : state.keys.hotplug !== "0";
	const mountMode = state?.keys.mount_mode ?? "revert";

	return (
		<>
			{snapshot.status === "error" ? (
				<>
					<SectionHeader>
						{tr("status_error_section", "Last refresh")}
					</SectionHeader>
					<div className="px-4">
						<Card>
							<StatusField
								label={tr("common_error", "Error")}
								value={snapshot.error ?? tr("common_error", "Error")}
								tone="error"
							/>
						</Card>
					</div>
				</>
			) : null}

			<SectionHeader>{tr("status_summary_section", "Summary")}</SectionHeader>
			<div className="px-4">
				<Card className="flex items-end gap-8">
					<div className="flex min-w-0 flex-col gap-1">
						<span className="text-onx-caption text-onx-muted">
							{tr("status_modules_count", "Zygisk modules")}
						</span>
						<span className="text-onx-display text-onx-on">
							{state?.modules.length ?? 0}
						</span>
					</div>
					<div className="flex min-w-0 flex-col gap-1">
						<span className="text-onx-caption text-onx-muted">
							{tr("status_fn_count", "FN nodes")}
						</span>
						<span className="text-onx-display text-onx-on">
							{state?.fns.length ?? 0}
						</span>
					</div>
				</Card>
			</div>

			<SectionHeader>{tr("status_runtime_section", "Runtime")}</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-4">
					<StatusField
						label={tr("status_monitor", "Monitor")}
						value={monitor ?? absent}
						tone={toneOf(monitor)}
					/>
					<StatusField
						label={tr("status_daemon", "Daemon")}
						value={daemon ?? absent}
						tone={toneOf(daemon)}
					/>
					<StatusField
						label={tr("status_root", "Root implementation")}
						value={state?.keys.root || tr("common_none", "None")}
						tone={state?.keys.root ? "normal" : "unavailable"}
					/>
					<StatusField
						label={tr("status_version", "Version")}
						value={formatVersion(state?.keys.version)}
						tone={state?.keys.version ? "normal" : "unavailable"}
					/>
				</Card>
			</div>

			<SectionHeader>{tr("status_zygote_section", "Zygote")}</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-4">
					<StatusField
						label={tr("status_zygote64", "Zygote 64-bit")}
						value={zygote64 ?? absent}
						tone={toneOf(zygote64)}
					/>
					<StatusField
						label={tr("status_zygote32", "Zygote 32-bit")}
						value={zygote32 ?? absent}
						tone={toneOf(zygote32)}
					/>
				</Card>
			</div>

			<SectionHeader>
				{tr("status_install_section", "Installation")}
			</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-4">
					<StatusField
						label={tr("status_installed", "Module files")}
						value={flag(
							installed,
							tr("status_installed_yes", "Installed"),
							tr("status_installed_no", "Not installed"),
						)}
						tone={installed === true ? "normal" : "unavailable"}
					/>
					<StatusField
						label={tr("status_runtime", "Runtime state")}
						value={flag(
							runtime,
							tr("status_runtime_ready", "Runtime active"),
							tr("status_runtime_inactive", "Runtime inactive"),
						)}
						tone={runtime === true ? "normal" : "unavailable"}
					/>
					<StatusField
						label={tr("status_hotplug", "Hot-plug")}
						value={flag(
							hotplug,
							tr("common_enabled", "Enabled"),
							tr("common_disabled", "Disabled"),
						)}
						tone={hotplug === undefined ? "unavailable" : "normal"}
					/>
					<StatusField
						label={tr("status_mount_mode", "Mount mode")}
						value={mountModeLabel(mountMode)}
						tone={state === null ? "unavailable" : "normal"}
					/>
				</Card>
			</div>

			<SectionHeader>{tr("status_workdir_section", "Location")}</SectionHeader>
			<div className="px-4">
				<SettingRowList>
					<SettingRow
						title={tr("status_workdir", "Work directory")}
						trailing={
							<span className="text-onx-mono text-onx-muted">
								{state?.keys.workdir || absent}
							</span>
						}
					/>
				</SettingRowList>
			</div>

			<SectionHeader>
				{tr("status_monitor_section", "Monitor detail")}
			</SectionHeader>
			<div className="px-4">
				<Card className="flex flex-col gap-2">
					{detail.length === 0 ? (
						<span className="text-onx-caption text-onx-muted">
							{tr("status_monitor_empty", "No monitor status reported yet.")}
						</span>
					) : (
						detail.map((row, index) => (
							<span
								key={row.value + String(index)}
								className="text-onx-mono text-onx-on"
							>
								{row.value}
							</span>
						))
					)}
				</Card>
			</div>
		</>
	);
}
