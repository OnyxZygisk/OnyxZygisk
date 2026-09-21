import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/site",
	timeout: 30_000,
	expect: { timeout: 5_000 },
	snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: "http://localhost:5173",
		// The WebUI only ever runs inside an Android WebView, so specs use a
		// phone viewport rather than a desktop default.
		viewport: { width: 412, height: 915 },
		// Pin the locale: the i18n manager detects the browser language, so an
		// unpinned run would assert different copy on each machine.
		locale: "en-US",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "./node_modules/.bin/vite --port 5173 --host 127.0.0.1",
		url: "http://localhost:5173",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
