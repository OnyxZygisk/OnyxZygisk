import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const THEMES = ["light", "dark", "amoled"] as const;

// Shirone's a11y rule: assert the page really is in the scanned theme, so a
// scan cannot pass simply because the override never applied.
for (const theme of THEMES) {
	test(`has no axe violations in the ${theme} theme`, async ({ page }) => {
		// Colour transitions are still running right after the theme switch, and
		// axe measures computed colours — so a scan can catch a blended
		// mid-transition value and report a contrast failure that no user sees.
		// Collapse motion first, then scan the settled state.
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto("/?gallery");
		await page
			.getByRole("button", { name: `Preview: ${theme}`, exact: true })
			.click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

		const results = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();
		expect(results.violations).toEqual([]);
	});
}

test("the night mode picker has no axe violations", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/?gallery");
	await page.getByRole("button", { name: /^Appearance/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();

	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	expect(results.violations).toEqual([]);
});
