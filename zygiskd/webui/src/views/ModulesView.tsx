import { useState } from "react";
import { formatVersion, type ModuleInfo } from "../cli_parse";
import { Badge } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { SectionHeader } from "../components/molecules/SectionHeader";
import {
	SettingRow,
	SettingRowList,
	SettingRowSeparator,
	SettingRowSwitch,
} from "../components/molecules/SettingRow";
import type { SnackbarTone } from "../components/molecules/Snackbar";
import { cli } from "../state/app";
import { messageOf, type SystemSnapshot } from "../state/system";
import { tr } from "../utils/tr";

export interface ModulesViewProps {
	snapshot: SystemSnapshot;
	onRefresh: () => Promise<void>;
	onNotify: (message: string, tone: SnackbarTone) => void;
}

/** A module row owns a hot-plug switch only when there is something to plug:
 * a staged update waiting, or an already hot-plugged module that can be
 * unplugged again. */
function ownsHotplugSwitch(module: ModuleInfo): boolean {
	return module.pendingUpdate || module.hotplugged || module.hotplugEnabled;
}

export function ModulesView({
	snapshot,
	onRefresh,
	onNotify,
}: ModulesViewProps) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const modules = (snapshot.state?.modules ?? []).filter(
		(module) => module.zygisk,
	);
	const masterOn = snapshot.state?.keys.hotplug !== "0";

	async function toggleHotplug(
		module: ModuleInfo,
		enabled: boolean,
	): Promise<void> {
		setBusyId(module.id);
		try {
			await cli.setModuleHotplug(module.id, enabled);
			// The daemon CLI safely moves a staged module into the active
			// directory, finishes its lifecycle scripts, and reboots the device
			// once so the module loads at the fresh system_server fork.
			onNotify(
				tr(
					"modules_hotplug_applied",
					"Applied. The device will reboot to finish activation.",
				),
				"normal",
			);
			await onRefresh();
		} catch (error) {
			onNotify(messageOf(error), "error");
		} finally {
			setBusyId(null);
		}
	}

	return (
		<>
			<SectionHeader>{tr("modules_section", "Zygisk modules")}</SectionHeader>
			<div className="px-4">
				{snapshot.status === "error" ? (
					<Card>
						<span className="text-onx-caption text-onx-muted">
							{snapshot.error}
						</span>
					</Card>
				) : modules.length === 0 ? (
					<Card>
						<span className="text-onx-caption text-onx-muted">
							{tr("modules_empty", "No Zygisk modules installed.")}
						</span>
					</Card>
				) : (
					<SettingRowList>
						{modules.map((module, index) => (
							<div key={module.id}>
								{index > 0 ? <SettingRowSeparator /> : null}
								{ownsHotplugSwitch(module) ? (
									<SettingRowSwitch
										controlId={`hotplug-${module.id}`}
										title={module.name || module.id}
										summary={
											(module.desc ? `${module.desc} · ` : "") +
											formatVersion(module.version) +
											" · " +
											(module.author || tr("modules_unknown_author", "unknown"))
										}
										controlLabel={
											module.pendingUpdate
												? tr(
														"modules_hotplug_control",
														"Apply the staged update now",
													)
												: tr(
														"modules_hotplug_toggle",
														"Hot-plugged, unplug again",
													)
										}
										checked={module.hotplugEnabled && !module.disabled}
										disabled={busyId === module.id || !masterOn}
										onChange={(next) => void toggleHotplug(module, next)}
									/>
								) : (
									<SettingRow
										title={module.name || module.id}
										summary={
											(module.desc ? `${module.desc} · ` : "") +
											formatVersion(module.version) +
											" · " +
											(module.author || tr("modules_unknown_author", "unknown"))
										}
										trailing={
											<Badge variant={module.disabled ? "outline" : "solid"}>
												{module.disabled
													? tr("common_disabled", "Disabled")
													: tr("common_enabled", "Enabled")}
											</Badge>
										}
									/>
								)}
								{module.pendingUpdate ? (
									<div className="px-4 pb-3">
										<Badge>
											{tr("modules_pending_update", "Update staged")}
										</Badge>
									</div>
								) : null}
							</div>
						))}
					</SettingRowList>
				)}
				{!masterOn && modules.length > 0 ? (
					<p className="px-4 pt-2 text-onx-caption text-onx-muted">
						{tr(
							"modules_master_off",
							"Hot-plug is off, so staged updates wait for a reboot.",
						)}
					</p>
				) : null}
			</div>
		</>
	);
}
