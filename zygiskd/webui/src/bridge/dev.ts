import type { Bridge, ExecResult } from "../bridge";

/**
 * Marker the release guard looks for. Its absence from the built scripts is
 * how tests/unit/bundle.test.mjs proves this module was dropped from a release
 * build — the same reason the whole file exists.
 */
const DEV_FIXTURE_ID = "onyx-dev-fixture";

const DEV_STATE = [
	"status_protocol=1",
	"installed=1",
	"runtime=1",
	"version=1.0",
	"root=KernelSU",
	"z64=1",
	"z32=1",
	"daemon=1",
	"hotplug=1",
	"mount_mode=revert",
	"workdir=/data/adb/onyxzygisk",
	"@@monitor",
	"\tmonitor: \t tracing",
	"",
	"\tzygote64:\t injected",
	"\tzygote32:\t injected",
	"",
	"\tdaemon64:\t running",
	"",
	"\tRoot:\t KernelSU",
	"\tModules (3):",
	"\t\tplayintegrityfix",
	"\t\ttricky_store",
	"",
	"@@modules",
	"M|playintegrityfix|Play Integrity Fix|v18.8|chiteroman|1|0|Fix Play Integrity attestation|0|0|0",
	"M|tricky_store|Tricky Store|v1.2.1|5ec1cff|1|0|Spoof keybox on devices with broken TEE|1|0|0",
	"M|" +
		DEV_FIXTURE_ID +
		"|Development fixture|v0.0.0|OnyxZygisk|1|1|Canned row served by the development bridge|0|0|1",
	"@@fn",
	"F|net_guard|Network Guard|1.0|app|com.bank.*|enabled",
	"F|prop_shield|Property Shield|2.1|system_server|all|disabled",
].join("\n");

const DEV_LOGS = [
	"I/zygiskd(1234): Welcome to OnyxZygisk",
	"I/zygisk-core64(1256): zygisk library injected, version v1.0",
	"I/zygiskd(1234): Daemon listening on cp64.sock",
	"W/zygisk-sh(1201): Scheduled 2 FN nodes for the next fork",
	"E/zygiskd(1234): FN prop_shield exited with status 1",
].join("\n");

/** UTF-8 to base64, mirroring what the wrapped shell command emits. */
function encodeBase64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function reply(stdout: string, errno = 0): ExecResult {
	return { errno, stdout: encodeBase64Utf8(stdout), stderr: "" };
}

/**
 * A bridge that answers the production protocol with canned data, so
 * development and Playwright exercise the real code path in cli.ts without a
 * device. Installed only under `import.meta.env.DEV`, so Vite removes it from
 * release builds — a shipped WebUI must never present fabricated device state.
 */
export function createDevBridge(): Bridge {
	return {
		host: "dev",
		isWebui: () => false,
		exec: (command) => {
			// Order matters: the status script also mentions "hotplug" and
			// "mount_mode", so its own protocol marker has to win first.
			if (command.includes("status_protocol")) {
				return Promise.resolve(reply(DEV_STATE));
			}
			if (command.includes("logcat")) return Promise.resolve(reply(DEV_LOGS));
			if (command.includes("hotplug")) {
				return Promise.resolve(reply("hotplug applied"));
			}
			if (command.includes("mount_mode")) {
				return Promise.resolve(reply("mount mode updated"));
			}
			if (command.includes("disable")) return Promise.resolve(reply(""));
			return Promise.resolve(reply("unknown onyxzygisk command", 1));
		},
	};
}
