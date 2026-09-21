import type { StatusLevel, SystemState } from "../cli_parse";
import { cli } from "./app";

export type SystemStatus = StatusLevel;

export interface SystemSnapshot {
	status: SystemStatus;
	error: string | null;
	state: SystemState | null;
}

export const EMPTY_SNAPSHOT: SystemSnapshot = {
	status: "loading",
	error: null,
	state: null,
};

/**
 * One shell round trip per refresh: the daemon reports the monitor, the module
 * list and the FN nodes together, so the tabs never disagree about which
 * generation of state they are showing.
 */
export async function loadSystemState(): Promise<SystemSnapshot> {
	try {
		return { status: "ready", error: null, state: await cli.readState() };
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
			state: null,
		};
	}
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
