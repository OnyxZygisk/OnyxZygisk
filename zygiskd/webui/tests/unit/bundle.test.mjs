import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Release-build guard.
 *
 * src/bridge/dev.ts fabricates device state so development and Playwright can
 * run the production code path in cli.ts. If it ever reached a release build, a
 * device without a working host bridge would be shown a healthy-looking
 * monitor, module list and FN list that no native call produced — the worst
 * failure mode this product has, because the user would believe the framework
 * is running.
 *
 * The markers below are string literals that survive minification and appear
 * nowhere else in src/, so their absence proves the module was dropped.
 *
 * Run `pnpm build` first; this suite reads the emitted dist/assets/*.js.
 */
const assetsDir = fileURLToPath(new URL("../../dist/assets/", import.meta.url));

const DEV_BRIDGE_MARKERS = ["unknown onyxzygisk command", "onyx-dev-fixture"];

function readBuiltScripts() {
	let files;
	try {
		files = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
	} catch {
		files = [];
	}
	assert.ok(
		files.length > 0,
		"Built scripts not found — run `pnpm build` before `pnpm test`.",
	);
	return files.map((name) => ({
		name,
		source: readFileSync(assetsDir + name, "utf8"),
	}));
}

describe("release build", () => {
	const scripts = readBuiltScripts();

	test("does not ship the development bridge", () => {
		const leaks = [];
		for (const { name, source } of scripts) {
			for (const marker of DEV_BRIDGE_MARKERS) {
				if (source.includes(marker)) leaks.push(`${name}: ${marker}`);
			}
		}
		assert.deepEqual(
			leaks,
			[],
			`The development bridge reached a release build: ${leaks.join(", ")}. Guard its install with import.meta.env.DEV.`,
		);
	});

	test("has no unresolved build-time environment references", () => {
		for (const { name, source } of scripts) {
			assert.ok(
				!source.includes("import.meta.env"),
				`${name} still contains import.meta.env, which Vite should have replaced at build time`,
			);
		}
	});

	test("keeps the real bridge and its protocol in the bundle", () => {
		// The counterpart to the check above: dropping the dev bridge must not
		// have dropped the strings the shell protocol depends on.
		const combined = scripts.map((script) => script.source).join("\n");
		for (const marker of [
			"status_protocol",
			"@@modules",
			"hotplug_activated",
			"mount_mode",
		]) {
			assert.ok(
				combined.includes(marker),
				`${marker} is missing from the release build`,
			);
		}
	});
});
