const MIN_ANDROID_WEBVIEW_VERSION = 120;

interface NavigatorUAData {
	readonly brands: ReadonlyArray<{
		readonly brand: string;
		readonly version: string;
	}>;
}

export function getWebviewVersion(): number | null {
	const brands = (
		navigator as Navigator & { readonly userAgentData?: NavigatorUAData }
	).userAgentData?.brands;
	if (Array.isArray(brands) && brands.length > 0) {
		const webViewBrand = brands.find(
			(entry) => entry.brand === "Android WebView",
		);
		if (webViewBrand) return Number.parseInt(webViewBrand.version, 10);
	}

	const userAgent = navigator.userAgent;
	if (/Android/i.test(userAgent) && /\bwv\b/.test(userAgent)) {
		const match = userAgent.match(/Chrome\/(\d+)/);
		return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
	}
	return null;
}

export function isSupported(): boolean {
	const version = getWebviewVersion();
	return version === null || version >= MIN_ANDROID_WEBVIEW_VERSION;
}

function blockingPage(message: string): HTMLElement {
	const container = document.createElement("div");
	container.className = "onx-blocking";
	const text = document.createElement("p");
	text.textContent = message;
	container.appendChild(text);
	return container;
}

/**
 * Shown when the WebUI is running in a release build without a host bridge.
 * The alternative — rendering the ordinary shell — would leave every field
 * reading "unavailable" with no indication of why.
 */
export function renderBridgeUnavailablePage(): HTMLElement {
	return blockingPage(
		"The KernelSU, APatch or MMRL WebUI bridge is not available.",
	);
}

export function renderBlockingPage(): HTMLElement {
	return blockingPage("Android System WebView 120 or newer is required.");
}
