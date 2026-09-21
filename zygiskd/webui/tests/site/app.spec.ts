import { expect, test } from "@playwright/test";

const nav = (page: import("@playwright/test").Page) =>
	page.getByRole("navigation", { name: "Main" });

const main = (page: import("@playwright/test").Page) => page.locator("main");

const gotoPage = async (
	page: import("@playwright/test").Page,
	label: string,
) => {
	await nav(page).getByRole("button", { name: label, exact: true }).click();
};

test.describe("status", () => {
	test("names the module in the app bar", async ({ page }) => {
		await page.goto("/");
		// The app bar names the module, not the page: the navigation bar already
		// marks which page is current.
		await expect(
			page.locator("header").getByRole("heading", { name: "OnyxZygisk" }),
		).toBeVisible();
	});

	test("renders the runtime surface from the bridge", async ({ page }) => {
		await page.goto("/");
		// "Working" is the plain-word summary a reader who does not know what
		// "tracing" means actually needs; the raw rows below are the evidence.
		for (const value of ["Working", "tracing", "running", "KernelSU", "v1.0"]) {
			await expect(main(page).getByText(value, { exact: true })).toBeVisible();
		}
	});

	test("reports a zygote that has not been injected yet as pending, not failed", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(
			main(page).getByText("injected", { exact: true }).first(),
		).toBeVisible();
	});

	test("counts the installed modules and FN nodes", async ({ page }) => {
		await page.goto("/");
		await expect(main(page).getByTestId("status-module-count")).toHaveText("3");
		await expect(main(page).getByTestId("status-fn-count")).toHaveText("2");
	});

	test("renders the work directory in a monospace face", async ({ page }) => {
		await page.goto("/");
		const cell = main(page).getByText("/data/adb/onyxzygisk", { exact: true });
		const family = await cell.evaluate(
			(node) => getComputedStyle(node).fontFamily,
		);
		expect(family.toLowerCase()).toContain("mono");
	});

	test("shows the monitor detail lines as reported", async ({ page }) => {
		await page.goto("/");
		await expect(main(page).getByText("Modules (3):")).toBeVisible();
	});
});

test.describe("navigation", () => {
	test("switches between the five pages", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Modules");
		await expect(
			main(page).getByRole("heading", { name: "Zygisk modules" }),
		).toBeVisible();
		await gotoPage(page, "FN");
		await expect(
			main(page).getByRole("heading", { name: "FN nodes" }),
		).toBeVisible();
		await gotoPage(page, "Logs");
		await expect(
			main(page).getByRole("heading", { name: "Logs" }),
		).toBeVisible();
		await gotoPage(page, "Settings");
		await expect(
			main(page).getByRole("heading", { name: "Appearance" }),
		).toBeVisible();
		await gotoPage(page, "Status");
		await expect(main(page).getByTestId("status-module-count")).toBeVisible();
	});

	test("marks the current page for assistive technology", async ({ page }) => {
		await page.goto("/");
		await expect(
			nav(page).getByRole("button", { name: "Status", exact: true }),
		).toHaveAttribute("aria-current", "page");
		await gotoPage(page, "Logs");
		await expect(
			nav(page).getByRole("button", { name: "Logs", exact: true }),
		).toHaveAttribute("aria-current", "page");
	});
});

test.describe("modules", () => {
	test("lists the Zygisk modules from the bridge", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Modules");
		for (const name of [
			"Play Integrity Fix",
			"Tricky Store",
			"Development fixture",
		]) {
			await expect(main(page).getByText(name, { exact: true })).toBeVisible();
		}
	});

	test("offers a hot-plug switch only where there is something to plug", async ({
		page,
	}) => {
		await page.goto("/");
		await gotoPage(page, "Modules");
		await expect(
			main(page).getByRole("switch", {
				name: "Apply the staged update now",
			}),
		).toBeVisible();
		await expect(
			main(page).getByRole("switch", { name: "Hot-plugged, unplug again" }),
		).toBeVisible();
	});

	test("flags a staged update", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Modules");
		await expect(main(page).getByText("Update staged")).toBeVisible();
	});

	test("applies a staged update and reports it", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Modules");
		await main(page)
			.getByRole("switch", { name: "Apply the staged update now" })
			.click();
		await expect(
			page.getByText("Applied. The device will reboot to finish activation."),
		).toBeVisible();
	});
});

test.describe("fn", () => {
	test("lists the FN nodes", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "FN");
		await expect(
			main(page).getByText("Network Guard", { exact: true }),
		).toBeVisible();
		await expect(
			main(page).getByText("Property Shield", { exact: true }),
		).toBeVisible();
	});

	test("toggles an FN node and substitutes its id into the message", async ({
		page,
	}) => {
		await page.goto("/");
		await gotoPage(page, "FN");
		await main(page).getByRole("switch", { name: "Property Shield" }).click();
		await expect(
			page.getByText(
				'FN node "prop_shield" enabled. It applies on the next fork.',
			),
		).toBeVisible();
		// The regression this pins: a parameterised string used as a plain label
		// renders its placeholder verbatim.
		await expect(page.getByText("%s")).toHaveCount(0);
	});
});

test.describe("logs", () => {
	test("renders the capture the bridge returned", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Logs");
		await expect(main(page).getByTestId("log-panel")).toContainText(
			"Welcome to OnyxZygisk",
		);
	});

	test("narrows the view with the filter without losing the rest", async ({
		page,
	}) => {
		await page.goto("/");
		await gotoPage(page, "Logs");
		const panel = main(page).getByTestId("log-panel");
		await main(page)
			.getByRole("searchbox", { name: "Filter" })
			.fill("prop_shield");
		await expect(panel).toContainText("prop_shield");
		await expect(panel).not.toContainText("Welcome to OnyxZygisk");
	});

	test("marks the error level by weight, never by hue", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Logs");
		const strong = main(page).locator(".onx-log-level-strong").first();
		const weight = await strong.evaluate((node) =>
			Number(getComputedStyle(node).fontWeight),
		);
		expect(weight).toBeGreaterThanOrEqual(600);
	});
});

test.describe("settings", () => {
	test("changes the theme from the appearance picker", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		await main(page)
			.getByRole("button", { name: /^Appearance/ })
			.click();
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("button", { name: "Night (pure black)" }).click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "amoled");
	});

	test("offers a language picker", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		await main(page)
			.getByRole("button", { name: /^Language/ })
			.click();
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByRole("button", { name: "Follow system" }),
		).toBeVisible();
		await expect(dialog.getByRole("button", { name: "日本語" })).toBeVisible();
	});

	test("offers the mount modes", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		await main(page)
			.getByRole("button", { name: /^Mount mode/ })
			.click();
		const dialog = page.getByRole("dialog");
		for (const mode of ["Revert only", "Namespace switch", "Global"]) {
			await expect(dialog.getByRole("button", { name: mode })).toBeVisible();
		}
	});

	test("exposes the hot-plug master switch", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		const master = main(page).getByRole("switch", { name: "Hot-plug" });
		await expect(master).toBeVisible();
		await expect(master).toBeEnabled();
	});

	// Regression: refactoring a setting row into a text-only subcomponent dropped
	// the trailing slot, so the slider silently disappeared from the row. A prop
	// that exists but is never rendered is invisible to the type checker.
	test("renders the trailing slot of a setting row", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		const slider = main(page).getByRole("slider", {
			name: "Interface scale",
		});
		await expect(slider).toBeVisible();
		const width = await slider.evaluate((thumb) =>
			Math.round(
				thumb.parentElement?.parentElement?.getBoundingClientRect().width ?? 0,
			),
		);
		expect(width).toBeGreaterThan(100);
	});

	test("adjusts the interface scale", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		const slider = main(page).getByRole("slider", {
			name: "Interface scale",
		});
		const before = Number(await slider.getAttribute("aria-valuenow"));
		await slider.focus();
		await page.keyboard.press("ArrowLeft");
		await expect
			.poll(async () => Number(await slider.getAttribute("aria-valuenow")))
			.toBeLessThan(before);
	});

	test("credits the module authors", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		await expect(main(page).getByText("Authors")).toBeVisible();
		await expect(
			main(page).getByText("Sai · Matsuzaka Yuki", { exact: true }),
		).toBeVisible();
	});

	// Overlays own one history entry each, so the Android back gesture closes
	// the topmost layer instead of leaving the WebUI.
	test("closes the topmost dialog on the back gesture", async ({ page }) => {
		await page.goto("/");
		await gotoPage(page, "Settings");
		await main(page)
			.getByRole("button", { name: /^Appearance/ })
			.click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.goBack();
		await expect(page.getByRole("dialog")).toBeHidden();
	});
});
