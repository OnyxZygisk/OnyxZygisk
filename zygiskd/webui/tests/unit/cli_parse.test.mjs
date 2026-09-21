import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	decodeBase64Utf8,
	formatVersion,
	isValidModuleId,
	parseLogLineCount,
	parseMonitor,
	parseStatus,
	shellQuote,
} from "../../src/cli_parse.ts";

const STATUS_OUTPUT = [
	"status_protocol=1",
	"installed=1",
	"runtime=1",
	"version=1.0",
	"root=KernelSU",
	"z64=1",
	"z32=0",
	"daemon=1",
	"hotplug=0",
	"mount_mode=setns",
	"workdir=/data/adb/onyxzygisk",
	"@@monitor",
	"\tmonitor: \t tracing",
	"\tzygote64:\t injected",
	"\tRoot:\t KernelSU",
	"\tModules (2):",
	"\t\tplayintegrityfix",
	"@@modules",
	"M|playintegrityfix|Play Integrity Fix|v18.8|chiteroman|1|0|Fix attestation|0|0|0",
	"M|tricky_store|Tricky Store|v1.2.1|5ec1cff|1|0|Spoof keybox|1|0|1",
	"@@fn",
	"F|net_guard|Network Guard|1.0|app|com.bank.*|enabled",
].join("\n");

describe("parseStatus", () => {
	const state = parseStatus(STATUS_OUTPUT);

	test("reads the key=value header", () => {
		assert.equal(state.keys.status_protocol, "1");
		assert.equal(state.keys.root, "KernelSU");
		assert.equal(state.keys.mount_mode, "setns");
		assert.equal(state.keys.workdir, "/data/adb/onyxzygisk");
	});

	test("splits module rows into all eleven fields", () => {
		assert.equal(state.modules.length, 2);
		const [first, second] = state.modules;
		assert.deepEqual(first, {
			id: "playintegrityfix",
			name: "Play Integrity Fix",
			version: "v18.8",
			author: "chiteroman",
			zygisk: true,
			disabled: false,
			desc: "Fix attestation",
			pendingUpdate: false,
			hotplugEnabled: false,
			hotplugged: false,
		});
		// The staged-update and hot-plug columns are independent flags.
		assert.equal(second.pendingUpdate, true);
		assert.equal(second.hotplugged, true);
	});

	test("reads FN rows", () => {
		assert.deepEqual(state.fns, [
			{
				id: "net_guard",
				name: "Network Guard",
				version: "1.0",
				trigger: "app",
				scope: "com.bank.*",
				status: "enabled",
			},
		]);
	});

	test("ignores rows outside any section", () => {
		const parsed = parseStatus("noise\n@@modules\nnot a module row\n");
		assert.deepEqual(parsed.modules, []);
	});
});

describe("parseMonitor", () => {
	test("drops metadata and stray remnants, keeps live rows and detail lines", () => {
		const rows = parseMonitor(
			[
				"name=OnyxZygisk",
				"version=1.0",
				"=leftover",
				"\tmonitor: \t tracing",
				"",
				"\tzygote64:\t not injected",
				"\tRoot:\t KernelSU",
			].join("\n"),
		);
		assert.deepEqual(rows, [
			{ label: "monitor", value: "tracing" },
			{ label: "zygote64", value: "not injected" },
			{ label: null, value: "Root:\t KernelSU" },
		]);
	});

	test("returns nothing for empty input", () => {
		assert.deepEqual(parseMonitor(""), []);
		assert.deepEqual(parseMonitor(undefined), []);
	});
});

describe("isValidModuleId", () => {
	test("accepts directory basenames", () => {
		for (const id of [
			"a",
			"playintegrityfix",
			"tricky_store",
			"mod-1",
			"a.b",
		]) {
			assert.equal(isValidModuleId(id), true, id);
		}
	});

	test("rejects anything that could escape the workdir", () => {
		for (const id of ["", ".", "..", "../etc", "a/b", "a b", "a'b", null, 7]) {
			assert.equal(isValidModuleId(id), false, String(id));
		}
	});
});

describe("shellQuote", () => {
	test("wraps the value in single quotes", () => {
		assert.equal(shellQuote("/data/adb/onyxzygisk"), "'/data/adb/onyxzygisk'");
	});

	test("escapes an embedded single quote", () => {
		assert.equal(shellQuote("it's"), "'it'\\''s'");
	});
});

describe("decodeBase64Utf8", () => {
	test("round-trips non-ASCII, emoji included", () => {
		for (const value of ["中文描述", "😀 tracing", "plain"]) {
			const encoded = Buffer.from(value, "utf8").toString("base64");
			assert.equal(decodeBase64Utf8(encoded), value);
		}
	});

	test("tolerates the line wrapping base64 emits", () => {
		const encoded = Buffer.from("模块名称", "utf8").toString("base64");
		assert.equal(decodeBase64Utf8(`${encoded}\n`), "模块名称");
	});

	test("treats empty input as empty output", () => {
		assert.equal(decodeBase64Utf8(""), "");
		assert.equal(decodeBase64Utf8("  \n "), "");
	});
});

describe("parseLogLineCount", () => {
	test("clamps to the supported range", () => {
		assert.equal(parseLogLineCount(1), 20);
		assert.equal(parseLogLineCount(9999), 300);
		assert.equal(parseLogLineCount(120), 120);
	});

	test("falls back when the value is not a number", () => {
		assert.equal(parseLogLineCount("abc"), 120);
		assert.equal(parseLogLineCount(""), 120);
	});
});

describe("formatVersion", () => {
	test("normalises a leading v", () => {
		assert.equal(formatVersion("1.0"), "v1.0");
		assert.equal(formatVersion("v1.0"), "v1.0");
		assert.equal(formatVersion(" V2.3 "), "v2.3");
	});

	test("degrades to a placeholder", () => {
		assert.equal(formatVersion(undefined), "v?");
		assert.equal(formatVersion(""), "v?");
	});
});
