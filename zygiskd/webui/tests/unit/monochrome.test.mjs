import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Design guard for the strictly monochrome WebUI.
 *
 * The whole product surface must stay on a grayscale ramp: no chromatic value
 * may reach the shipped stylesheet. This scans the real build output rather
 * than the sources, so a colour introduced through any route — a Tailwind
 * utility, a hand-written declaration, a third-party component — is caught.
 *
 * Run `pnpm build` first; this suite reads the emitted dist/assets/*.css.
 */
const assetsDir = fileURLToPath(new URL("../../dist/assets/", import.meta.url));

const REQUIRED_TOKENS = [
	"--color-onx-bg",
	"--color-onx-surface",
	"--color-onx-container",
	"--color-onx-container-high",
	"--color-onx-on",
	"--color-onx-muted",
	"--color-onx-disabled",
	"--color-onx-divider",
	"--color-onx-accent",
	"--color-onx-on-accent",
	"--color-onx-scrim",
	"--color-onx-hairline-strong",
];

// Readable text must clear AA on every surface it can land on, not just the
// page canvas. A background-only version of this check missed a 3.16:1
// muted-on-container violation that axe found later.
const READABLE_TEXT = ["--color-onx-on", "--color-onx-muted"];
const SURFACES = [
	"--color-onx-bg",
	"--color-onx-container",
	"--color-onx-container-high",
];

// Tailwind emits the base @theme tokens into `@layer theme{:root,:host{...}}`,
// while the dark and amoled overrides are our own attribute selectors.
const THEME_SELECTORS = {
	light: ":root,:host{",
	dark: ":root[data-theme=dark]{",
	amoled: ":root[data-theme=amoled]{",
};

// Chromatic CSS colour keywords. Grayscale keywords are deliberately absent.
const CHROMATIC_KEYWORDS = [
	"aliceblue",
	"aqua",
	"aquamarine",
	"beige",
	"bisque",
	"blue",
	"blueviolet",
	"brown",
	"burlywood",
	"cadetblue",
	"chartreuse",
	"chocolate",
	"coral",
	"cornflowerblue",
	"crimson",
	"cyan",
	"darkblue",
	"darkcyan",
	"darkgoldenrod",
	"darkgreen",
	"darkkhaki",
	"darkmagenta",
	"darkolivegreen",
	"darkorange",
	"darkorchid",
	"darkred",
	"darksalmon",
	"darkseagreen",
	"darkslateblue",
	"darkslategray",
	"darkturquoise",
	"darkviolet",
	"deeppink",
	"deepskyblue",
	"dodgerblue",
	"firebrick",
	"forestgreen",
	"fuchsia",
	"gold",
	"goldenrod",
	"green",
	"greenyellow",
	"hotpink",
	"indianred",
	"indigo",
	"khaki",
	"lawngreen",
	"lightblue",
	"lightcoral",
	"lightgreen",
	"lightpink",
	"lightsalmon",
	"lightseagreen",
	"lightskyblue",
	"lightsteelblue",
	"lightyellow",
	"lime",
	"limegreen",
	"magenta",
	"maroon",
	"mediumaquamarine",
	"mediumblue",
	"mediumorchid",
	"mediumpurple",
	"mediumseagreen",
	"mediumslateblue",
	"mediumspringgreen",
	"mediumturquoise",
	"mediumvioletred",
	"midnightblue",
	"navy",
	"olive",
	"olivedrab",
	"orange",
	"orangered",
	"orchid",
	"palegreen",
	"paleturquoise",
	"palevioletred",
	"peachpuff",
	"peru",
	"pink",
	"plum",
	"powderblue",
	"purple",
	"rebeccapurple",
	"red",
	"rosybrown",
	"royalblue",
	"saddlebrown",
	"salmon",
	"sandybrown",
	"seagreen",
	"sienna",
	"skyblue",
	"slateblue",
	"slategray",
	"springgreen",
	"steelblue",
	"tan",
	"teal",
	"thistle",
	"tomato",
	"turquoise",
	"violet",
	"wheat",
	"yellow",
	"yellowgreen",
];

function readBuiltCss() {
	let files;
	try {
		files = readdirSync(assetsDir).filter((name) => name.endsWith(".css"));
	} catch {
		files = [];
	}
	assert.ok(
		files.length > 0,
		"Built stylesheet not found — run `pnpm build` before `pnpm test`.",
	);
	return files.map((name) => readFileSync(assetsDir + name, "utf8")).join("\n");
}

/** Expands any CSS hex notation to an [r, g, b] triple. */
function parseHex(token) {
	const digits = token.slice(1);
	const expand = (value) => Number.parseInt(value, 16);
	switch (digits.length) {
		case 3:
		case 4:
			return [
				expand(digits[0] + digits[0]),
				expand(digits[1] + digits[1]),
				expand(digits[2] + digits[2]),
			];
		case 6:
		case 8:
			return [
				expand(digits.slice(0, 2)),
				expand(digits.slice(2, 4)),
				expand(digits.slice(4, 6)),
			];
		default:
			return null;
	}
}

/** Parses numeric rgb()/rgba() only; relative colour syntax is not a literal. */
function parseRgbFunction(expression) {
	const args = expression
		.replace(/^rgba?\(/i, "")
		.replace(/\)$/, "")
		.split(/[,\s/]+/)
		.filter(Boolean);
	if (args.length < 3) return null;
	const channels = args.slice(0, 3).map((value) => {
		const match = value.match(/^(\d+(?:\.\d+)?)%?$/);
		if (match === null) return Number.NaN;
		const numeric = Number.parseFloat(match[1]);
		return value.endsWith("%")
			? Math.round((numeric / 100) * 255)
			: Math.round(numeric);
	});
	if (channels.some((channel) => Number.isNaN(channel))) return null;
	return channels;
}

function isAchromatic([r, g, b]) {
	return r === g && g === b;
}

function linearize(channel) {
	const normalized = channel / 255;
	return normalized <= 0.03928
		? normalized / 12.92
		: ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
	return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(first, second) {
	const [high, low] = [
		relativeLuminance(first),
		relativeLuminance(second),
	].sort((a, b) => b - a);
	return (high + 0.05) / (low + 0.05);
}

function extractBlock(css, selector) {
	const index = css.indexOf(selector);
	if (index < 0) return null;
	const start = index + selector.length;
	const end = css.indexOf("}", start);
	if (end < 0) return null;
	return css.slice(start, end);
}

function readTokens(css, selector) {
	const block = extractBlock(css, selector);
	assert.ok(block !== null, `Missing theme block: ${selector}`);
	const tokens = new Map();
	for (const declaration of block.split(";")) {
		const separator = declaration.indexOf(":");
		if (separator < 0) continue;
		tokens.set(
			declaration.slice(0, separator).trim(),
			declaration.slice(separator + 1).trim(),
		);
	}
	return tokens;
}

function firstHex(value) {
	const match = value?.match(/#[0-9a-fA-F]{3,8}\b/);
	return match === undefined || match === null ? null : parseHex(match[0]);
}

const css = readBuiltCss();

// Capability probes such as `@supports (color: color-mix(in lab, red, red))`
// name colours but never render one, so the preludes are excluded from the
// keyword scan.
const renderedCss = css.replace(/@supports[^{]*\{/g, "@supports{");

describe("monochrome guard", () => {
	test("every hex literal is achromatic", () => {
		const offences = [];
		for (const [token] of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
			const channels = parseHex(token);
			if (channels !== null && !isAchromatic(channels)) offences.push(token);
		}
		assert.deepEqual(
			offences,
			[],
			`Chromatic hex colours found: ${offences.join(", ")}`,
		);
	});

	test("every numeric rgb()/rgba() value is achromatic", () => {
		const offences = [];
		for (const [expression] of renderedCss.matchAll(/rgba?\([^)]*\)/gi)) {
			const channels = parseRgbFunction(expression);
			if (channels !== null && !isAchromatic(channels))
				offences.push(expression);
		}
		assert.deepEqual(
			offences,
			[],
			`Chromatic rgb() values found: ${offences.join(", ")}`,
		);
	});

	test("no chromatic colour keyword reaches a rendered declaration", () => {
		const pattern = new RegExp(`\\b(${CHROMATIC_KEYWORDS.join("|")})\\b`, "gi");
		const offences = [
			...new Set([...renderedCss.matchAll(pattern)].map((match) => match[1])),
		];
		assert.deepEqual(
			offences,
			[],
			`Chromatic colour keywords found: ${offences.join(", ")}`,
		);
	});

	test("every theme defines the complete monochrome token set", () => {
		for (const [name, selector] of Object.entries(THEME_SELECTORS)) {
			const tokens = readTokens(css, selector);
			for (const token of REQUIRED_TOKENS) {
				assert.ok(tokens.has(token), `${name} theme is missing ${token}`);
			}
		}
	});

	test("readable text meets WCAG AA on every surface", () => {
		for (const [name, selector] of Object.entries(THEME_SELECTORS)) {
			const tokens = readTokens(css, selector);
			for (const surfaceToken of SURFACES) {
				const surface = firstHex(tokens.get(surfaceToken));
				assert.ok(
					surface !== null,
					`${name} theme has a non-hex ${surfaceToken}`,
				);
				for (const textToken of READABLE_TEXT) {
					const foreground = firstHex(tokens.get(textToken));
					assert.ok(
						foreground !== null,
						`${name} theme has a non-hex ${textToken}`,
					);
					const ratio = contrastRatio(foreground, surface);
					assert.ok(
						ratio >= 4.5,
						`${name} theme ${textToken} on ${surfaceToken} is ${ratio.toFixed(2)}:1, below the 4.5:1 AA floor`,
					);
				}
			}
		}
	});

	// --color-onx-disabled is exempt by WCAG, but only for genuinely inactive
	// controls. It must stay visibly distinct from muted text so the two are
	// never used interchangeably.
	test("disabled text stays distinct from muted text", () => {
		for (const [name, selector] of Object.entries(THEME_SELECTORS)) {
			const tokens = readTokens(css, selector);
			const disabled = firstHex(tokens.get("--color-onx-disabled"));
			const muted = firstHex(tokens.get("--color-onx-muted"));
			assert.ok(
				disabled !== null,
				`${name} theme has a non-hex --color-onx-disabled`,
			);
			assert.ok(
				muted !== null,
				`${name} theme has a non-hex --color-onx-muted`,
			);
			assert.notEqual(
				relativeLuminance(disabled),
				relativeLuminance(muted),
				`${name} theme uses the same value for disabled and muted text`,
			);
		}
	});
});
