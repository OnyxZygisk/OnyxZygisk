import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * i18n coverage guard.
 *
 * A key that is absent from a locale file does not crash: it renders the
 * English fallback. In a translated WebUI that is a silent regression, and it
 * is how a parameterised string ("FN node %s enabled") reaches the screen with
 * its placeholder intact when it is used as a plain label.
 *
 * en.xml is the reference, and zh-CN.xml is held to it key-for-key. ja.xml is
 * complete today but is deliberately not part of that pair, so it may lag
 * behind a key that en.xml gains without failing the build; a locale outside
 * the pair is checked only for keys en.xml does not know about.
 */
const stringsDir = fileURLToPath(
	new URL("../../public/locales/strings/", import.meta.url),
);
const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));

const REFERENCE_LOCALES = ["en", "zh-CN"];

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
	}
	return out;
}

function readLocaleKeys(file) {
	const xml = readFileSync(join(stringsDir, file), "utf8");
	const entries = [
		...xml.matchAll(/<string name="([a-z0-9_]+)">([^<]*)<\/string>/g),
	];
	return new Map(entries.map(([, name, value]) => [name, value]));
}

function usedKeys() {
	const keys = new Set();
	for (const file of walk(srcDir)) {
		const source = readFileSync(file, "utf8");
		for (const [, key] of source.matchAll(
			/\b(?:tr|i18n\.t)\(\s*"([a-z0-9_]+)"/g,
		)) {
			keys.add(key);
		}
	}
	return keys;
}

const reference = readLocaleKeys("en.xml");
const localeFiles = readdirSync(stringsDir).filter((name) =>
	name.endsWith(".xml"),
);

describe("i18n coverage", () => {
	test("every key used by the sources exists in the reference locale", () => {
		const missing = [...usedKeys()].filter((key) => !reference.has(key)).sort();
		assert.deepEqual(
			missing,
			[],
			`Undefined translation keys: ${missing.join(", ")}. Add them to en.xml (and zh-CN.xml).`,
		);
	});

	test("the reference locales define exactly the same key set", () => {
		const zh = readLocaleKeys("zh-CN.xml");
		const onlyEnglish = [...reference.keys()]
			.filter((key) => !zh.has(key))
			.sort();
		const onlyChinese = [...zh.keys()]
			.filter((key) => !reference.has(key))
			.sort();
		assert.deepEqual(
			onlyEnglish,
			[],
			`Missing from zh-CN.xml: ${onlyEnglish.join(", ")}`,
		);
		assert.deepEqual(
			onlyChinese,
			[],
			`Missing from en.xml: ${onlyChinese.join(", ")}`,
		);
	});

	test("parameterised strings keep the same placeholders in every locale", () => {
		// A locale that drops or renames %s renders the placeholder verbatim.
		const placeholders = (value) =>
			[...value.matchAll(/%(?:\d+\$)?([sdfx%])/g)]
				.map((m) => m[1])
				.sort()
				.join("");
		for (const file of localeFiles) {
			const locale = readLocaleKeys(file);
			for (const [key, english] of reference) {
				const translated = locale.get(key);
				if (translated === undefined) continue;
				assert.equal(
					placeholders(translated),
					placeholders(english),
					`${file}:${key} has different placeholders than en.xml`,
				);
			}
		}
	});

	test("every locale only defines keys the reference knows about", () => {
		for (const file of localeFiles) {
			if (REFERENCE_LOCALES.includes(file.replace(".xml", ""))) continue;
			const locale = readLocaleKeys(file);
			const unknown = [...locale.keys()]
				.filter((key) => !reference.has(key))
				.sort();
			assert.deepEqual(
				unknown,
				[],
				`${file} defines unknown keys: ${unknown.join(", ")}`,
			);
		}
	});
});
