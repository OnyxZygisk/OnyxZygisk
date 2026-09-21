/**
 * The module's display name.
 *
 * Deliberately not a translation key: it is a product name, and the same
 * string is the `name` in the module's module.prop and the `title` in
 * public/config.json. Those files are consumed by the host and by the
 * packaging script, so this constant is the copy the WebUI itself renders.
 */
export const MODULE_NAME = "OnyxZygisk";

/** Where the daemon keeps its runtime state. Mirrors docs/WEBUI.md. */
export const WORKDIR = "/data/adb/onyxzygisk";
