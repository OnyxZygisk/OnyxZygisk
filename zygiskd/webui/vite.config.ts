import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

export default defineConfig({
	// KernelSU loads the page straight off the filesystem, so every emitted URL
	// must be relative rather than rooted at "/".
	base: "",
	plugins: [
		react(),
		tailwindcss(),
		Icons({ compiler: "jsx", jsx: "react", autoInstall: false }),
	],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"@components": fileURLToPath(new URL("./src/components", import.meta.url)),
			"@bridge": fileURLToPath(new URL("./src/bridge", import.meta.url)),
		},
	},
	build: {
		// The host WebView is Android System WebView, which tracks Chromium.
		target: "chrome120",
		cssTarget: "chrome120",
		outDir: "dist",
		emptyOutDir: true,
		cssCodeSplit: false,
	},
});
