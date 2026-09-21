import { expect, test } from "@playwright/test";

/** Mirrors the long value the gallery renders for the wrap check. */
const LONG_VALUE =
	"/data/adb/modules/onyxzygisk/webroot/assets/index-4f2a9c1e9b7d.js";

test.describe("design gallery", () => {
	test("renders the component inventory", async ({ page }) => {
		await page.goto("/?gallery");
		await expect(
			page.getByRole("heading", { name: "Design gallery" }),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "Buttons" })).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Status tones" }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Navigation" }),
		).toBeVisible();
	});

	test("renders the monospace role in an actual monospace face", async ({
		page,
	}) => {
		await page.goto("/?gallery");
		const mono = page.locator(".text-onx-mono").first();
		const family = await mono.evaluate(
			(node) => getComputedStyle(node).fontFamily,
		);
		expect(family.toLowerCase()).toContain("mono");
	});

	test("wraps long status values instead of clipping them", async ({
		page,
	}) => {
		await page.goto("/?gallery");
		const value = page.getByText(LONG_VALUE, { exact: true });
		const box = await value.boundingBox();
		const style = await value.evaluate((node) => ({
			overflow: getComputedStyle(node).overflow,
		}));
		expect(box).not.toBeNull();
		expect(style.overflow).not.toBe("hidden");
	});

	// The Vue build colourised logcat by level. The monochrome ramp cannot, so
	// weight has to carry it — and this pins that it actually rendered.
	test("carries log level in weight rather than hue", async ({ page }) => {
		await page.goto("/?gallery");
		const strong = page.locator(".onx-log-level-strong").first();
		const weight = await strong.evaluate((node) =>
			Number(getComputedStyle(node).fontWeight),
		);
		expect(weight).toBeGreaterThanOrEqual(600);
	});
});
