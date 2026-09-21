import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getBridge, setBridge } from "./bridge";
import { createDevBridge } from "./bridge/dev";
import { i18n } from "./i18n";
import "./styles/theme.css";
import {
	isSupported,
	renderBlockingPage,
	renderBridgeUnavailablePage,
} from "./webview/webview";

const root = document.querySelector<HTMLDivElement>("#app");

if (root === null) {
	throw new Error("OnyxZygisk WebUI root element is missing");
}

const hasHostBridge = getBridge().isWebui();

if (import.meta.env.DEV && !hasHostBridge) {
	// Development and Playwright run outside a WebView. Installing the stand-in
	// lets them exercise the production code path in cli.ts. This branch is
	// compiled out of release builds, so a shipped WebUI can never present
	// fabricated device state.
	setBridge(createDevBridge());
}

if (!isSupported()) {
	root.replaceChildren(renderBlockingPage());
} else if (!hasHostBridge && !import.meta.env.DEV) {
	// Every native call would fail from here, so name the cause instead of
	// rendering a shell whose fields would all read as unavailable.
	root.replaceChildren(renderBridgeUnavailablePage());
} else {
	try {
		await i18n.init();
	} catch (error) {
		// Translations are additive; render with the keys rather than fail.
		console.error("Unable to load translations:", error);
	}

	createRoot(root).render(<App />);
}
