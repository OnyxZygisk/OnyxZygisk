import { i18n } from "../i18n";

/**
 * Translates a key and falls back to English when the string is absent.
 *
 * `i18n.t` returns the key itself when no translation exists, which is right
 * for the base locale but wrong for a partially translated one: a missing
 * entry would surface as `status_monitor` on screen. Every key used by the
 * views is present in en.xml, so the fallback is what the key means.
 */
export function tr(key: string, fallback: string, ...args: unknown[]): string {
	const value = i18n.t(key, ...args);
	return value === key ? fallback : value;
}
