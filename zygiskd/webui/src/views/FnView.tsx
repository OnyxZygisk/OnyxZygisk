import { useState } from "react";
import { Card } from "../components/atoms/Card";
import { SectionHeader } from "../components/molecules/SectionHeader";
import {
	SettingRowList,
	SettingRowSeparator,
	SettingRowSwitch,
} from "../components/molecules/SettingRow";
import type { SnackbarTone } from "../components/molecules/Snackbar";
import { cli } from "../state/app";
import { messageOf, type SystemSnapshot } from "../state/system";
import { tr } from "../utils/tr";

export interface FnViewProps {
	snapshot: SystemSnapshot;
	onRefresh: () => Promise<void>;
	onNotify: (message: string, tone: SnackbarTone) => void;
}

export function FnView({ snapshot, onRefresh, onNotify }: FnViewProps) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const fns = snapshot.state?.fns ?? [];

	async function toggle(id: string, enabled: boolean): Promise<void> {
		setBusyId(id);
		try {
			await cli.setFnEnabled(id, enabled);
			/*
			 * Both keys are written out in full rather than selected by a ternary
			 * in the key position: the i18n guard scans for a string literal
			 * directly after `tr(`, so a computed key would be invisible to it and
			 * could silently fall back to rendering the key itself.
			 */
			const message = enabled
				? tr(
						"fn_enabled",
						'FN node "%s" enabled. It applies on the next fork.',
						id,
					)
				: tr(
						"fn_disabled",
						'FN node "%s" disabled. It applies on the next fork.',
						id,
					);
			onNotify(message, "normal");
			await onRefresh();
		} catch (error) {
			onNotify(messageOf(error), "error");
		} finally {
			setBusyId(null);
		}
	}

	return (
		<>
			<SectionHeader>{tr("fn_section", "FN nodes")}</SectionHeader>
			<div className="px-4 pb-8">
				{snapshot.status === "error" ? (
					<Card>
						<span className="text-onx-caption text-onx-muted">
							{snapshot.error}
						</span>
					</Card>
				) : fns.length === 0 ? (
					<Card>
						<span className="text-onx-caption text-onx-muted">
							{tr("fn_empty", "No FN nodes installed.")}
						</span>
					</Card>
				) : (
					<SettingRowList>
						{fns.map((fn, index) => (
							<div key={fn.id}>
								{index > 0 ? <SettingRowSeparator /> : null}
								<SettingRowSwitch
									controlId={`fn-${fn.id}`}
									title={fn.name || fn.id}
									summary={
										(fn.trigger || tr("fn_trigger_default", "app")) +
										" / " +
										(fn.scope || tr("fn_scope_default", "all"))
									}
									checked={fn.status === "enabled"}
									disabled={busyId === fn.id}
									onChange={(next) => void toggle(fn.id, next)}
								/>
							</div>
						))}
					</SettingRowList>
				)}
			</div>
		</>
	);
}
