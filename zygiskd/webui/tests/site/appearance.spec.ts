import { expect, test } from "@playwright/test";

const preview = (page: import("@playwright/test").Page, value: string) =>
	page.getByRole("button", { name: `Preview: ${value}`, exact: true });

const appearanceRow = (page: import("@playwright/test").Page) =>
	page.getByRole("button", { name: /^Appearance/ });

test.describe("appearance", () => {
	test("preview buttons switch the document theme", async ({ page }) => {
		await page.goto("/?gallery");
		for (const value of ["light", "dark", "amoled"]) {
			await preview(page, value).click();
			await expect(page.locator("html")).toHaveAttribute("data-theme", value);
		}
	});

	test("marks the active preview for assistive technology", async ({
		page,
	}) => {
		await page.goto("/?gallery");
		await preview(page, "dark").click();
		await expect(preview(page, "dark")).toHaveAttribute("aria-pressed", "true");
		await expect(preview(page, "light")).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	test("paints a monochrome surface", async ({ page }) => {
		await page.goto("/?gallery");
		await preview(page, "light").click();
		const background = await page
			.locator("html")
			.evaluate((node) => getComputedStyle(node).backgroundColor);
		const channels = background.match(/\d+/g)?.map(Number) ?? [];
		expect(channels.length).toBeGreaterThanOrEqual(3);
		expect(channels[0]).toBe(channels[1]);
		expect(channels[1]).toBe(channels[2]);
	});
});

test.describe("night mode picker", () => {
	test("selects a theme from the dialog", async ({ page }) => {
		await page.goto("/?gallery");
		await appearanceRow(page).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Night", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	});

	test("offers automatic as an explicit option", async ({ page }) => {
		await page.goto("/?gallery");
		await preview(page, "dark").click();
		await appearanceRow(page).click();

		const dialog = page.getByRole("dialog");
		await dialog
			.getByRole("button", { name: "Automatic", exact: true })
			.click();
		await expect(dialog).toBeHidden();

		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			/light|dark/,
		);
	});

	test("closes on Escape and returns focus to the row", async ({ page }) => {
		await page.goto("/?gallery");
		const row = appearanceRow(page);
		await row.click();
		await expect(page.getByRole("dialog")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(row).toBeFocused();
	});

	test("persists the chosen theme across reloads", async ({ page }) => {
		await page.goto("/?gallery");
		await preview(page, "amoled").click();
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "amoled");
	});
});
