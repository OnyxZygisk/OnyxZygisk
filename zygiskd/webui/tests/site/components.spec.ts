import { expect, test } from "@playwright/test";

test.describe("Switch", () => {
	test("exposes switch semantics and toggles with the keyboard", async ({
		page,
	}) => {
		await page.goto("/?gallery");
		const control = page.getByRole("switch", { name: "Raw switch" });
		await expect(control).toBeVisible();
		const before = await control.getAttribute("aria-checked");
		await control.focus();
		await page.keyboard.press("Space");
		await expect(control).not.toHaveAttribute("aria-checked", before ?? "");
	});

	test("takes its accessible name from the setting row", async ({ page }) => {
		await page.goto("/?gallery");
		await expect(
			page.getByRole("switch", { name: "Switch row" }),
		).toBeVisible();
	});
});

test.describe("SettingRow", () => {
	test("renders a navigate row as a real button", async ({ page }) => {
		await page.goto("/?gallery");
		await expect(
			page.getByRole("button", { name: /Navigate row/ }),
		).toBeVisible();
	});

	test("keeps a disabled row inert", async ({ page }) => {
		await page.goto("/?gallery");
		await expect(
			page.getByRole("switch", { name: "Disabled row" }),
		).toBeDisabled();
	});

	test("gives every icon-only control a name", async ({ page }) => {
		await page.goto("/?gallery");
		await expect(page.getByRole("button", { name: "Browse" })).toBeVisible();
		await expect(
			page
				.getByRole("banner")
				.getByRole("button", { name: "Settings", exact: true }),
		).toBeVisible();
	});
});

test.describe("ChoiceRow", () => {
	test("opens a dialog and marks the active option", async ({ page }) => {
		await page.goto("/?gallery");
		await page.getByRole("button", { name: /^Appearance/ }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "Night", exact: true }),
		).toHaveAttribute("aria-pressed", "false");
	});

	test("closes on Escape and returns focus to the row", async ({ page }) => {
		await page.goto("/?gallery");
		const row = page.getByRole("button", { name: /^Appearance/ });
		await row.click();
		await expect(page.getByRole("dialog")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(row).toBeFocused();
	});
});

test.describe("NavigationBar", () => {
	test("marks the selected item with aria-current", async ({ page }) => {
		await page.goto("/?gallery");
		const bar = page.getByRole("navigation", { name: "Main" });
		await expect(
			bar.getByRole("button", { name: "Status", exact: true }),
		).toHaveAttribute("aria-current", "page");
		await bar.getByRole("button", { name: "Logs", exact: true }).click();
		await expect(
			bar.getByRole("button", { name: "Logs", exact: true }),
		).toHaveAttribute("aria-current", "page");
		await expect(
			bar.getByRole("button", { name: "Status", exact: true }),
		).not.toHaveAttribute("aria-current", "page");
	});
});

test.describe("Snackbar", () => {
	test("announces a transient message", async ({ page }) => {
		await page.goto("/?gallery");
		await page.getByRole("button", { name: "Show snackbar" }).click();
		await expect(page.getByText("Hot-plug applied.")).toBeVisible();
	});

	test("carries an error tone without hue", async ({ page }) => {
		await page.goto("/?gallery");
		await page.getByRole("button", { name: "Show error snackbar" }).click();
		const item = page.getByText("The daemon rejected the request.");
		await expect(item).toBeVisible();
		const background = await item
			.locator("..")
			.evaluate((node) => getComputedStyle(node).backgroundColor);
		const channels = background.match(/\d+/g)?.map(Number) ?? [];
		expect(channels[0]).toBe(channels[1]);
		expect(channels[1]).toBe(channels[2]);
	});
});

test.describe("StatusField", () => {
	test("states the condition in text, not only in tone", async ({ page }) => {
		await page.goto("/?gallery");
		await expect(page.getByText("tracing", { exact: true })).toBeVisible();
		await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
		await expect(
			page.getByText("Not installed", { exact: true }),
		).toBeVisible();
	});
});
