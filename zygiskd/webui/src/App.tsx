import { useCallback, useEffect, useState } from "react";
import IconArticle from "~icons/material-symbols/article";
import IconFunctions from "~icons/material-symbols/functions";
import IconHome from "~icons/material-symbols/home";
import IconRefresh from "~icons/material-symbols/refresh";
import IconSettings from "~icons/material-symbols/settings";
import IconWidgets from "~icons/material-symbols/widgets";
import { Icon } from "./components/atoms/Icon";
import { IconButton } from "./components/atoms/IconButton";
import {
	NavigationBar,
	type NavigationItem,
} from "./components/molecules/NavigationBar";
import {
	SnackbarHost,
	type SnackbarTone,
	snackbar,
} from "./components/molecules/Snackbar";
import { TopAppBar } from "./components/molecules/TopAppBar";
import { MODULE_NAME } from "./module_info";
import {
	EMPTY_SNAPSHOT,
	loadSystemState,
	type SystemSnapshot,
} from "./state/system";
import { tr } from "./utils/tr";
import { FnView } from "./views/FnView";
import { GalleryView } from "./views/GalleryView";
import { LogsView } from "./views/LogsView";
import { ModulesView } from "./views/ModulesView";
import { SettingsView } from "./views/SettingsView";
import { StatusView } from "./views/StatusView";

export const APPEARANCE_MODES = ["auto", "light", "dark", "amoled"] as const;

const THEME_KEY = "onx-appearance";
const REFRESH_MS = 6000;
const PAGE_IDS = ["status", "modules", "fn", "logs", "settings"] as const;

function prefersDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(
	mode: string,
	systemDark: boolean,
): "light" | "dark" | "amoled" {
	if (mode === "auto") return systemDark ? "dark" : "light";
	return mode === "amoled" ? "amoled" : mode === "dark" ? "dark" : "light";
}

function readStoredAppearance(): string {
	try {
		const stored = window.localStorage.getItem(THEME_KEY);
		if (
			stored !== null &&
			(APPEARANCE_MODES as readonly string[]).includes(stored)
		) {
			return stored;
		}
	} catch {
		// Storage is unavailable in some WebView configurations.
	}
	return "auto";
}

function persist(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Persisting the preference is best effort.
	}
}

export function App(): React.JSX.Element {
	const [page, setPage] = useState(0);
	const [appearance, setAppearance] = useState<string>(readStoredAppearance);
	const [systemDark, setSystemDark] = useState(prefersDark);
	const [snapshot, setSnapshot] = useState<SystemSnapshot>(EMPTY_SNAPSHOT);

	useEffect(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent): void =>
			setSystemDark(event.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		document.documentElement.dataset.theme = resolveTheme(
			appearance,
			systemDark,
		);
		persist(THEME_KEY, appearance);
	}, [appearance, systemDark]);

	const refresh = useCallback(async () => {
		setSnapshot(await loadSystemState());
	}, []);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), REFRESH_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	const notify = useCallback((message: string, tone: SnackbarTone): void => {
		snackbar.show(message, tone);
	}, []);

	const navItems: NavigationItem[] = [
		{ id: PAGE_IDS[0], label: tr("nav_status", "Status"), icon: IconHome },
		{ id: PAGE_IDS[1], label: tr("nav_modules", "Modules"), icon: IconWidgets },
		{ id: PAGE_IDS[2], label: tr("nav_fn", "FN"), icon: IconFunctions },
		{ id: PAGE_IDS[3], label: tr("nav_logs", "Logs"), icon: IconArticle },
		{
			id: PAGE_IDS[4],
			label: tr("nav_settings", "Settings"),
			icon: IconSettings,
		},
	];

	if (
		import.meta.env.DEV &&
		new URLSearchParams(window.location.search).has("gallery")
	) {
		return (
			<>
				<GalleryView
					theme={resolveTheme(appearance, systemDark)}
					appearance={appearance}
					onAppearanceChange={setAppearance}
				/>
				<SnackbarHost />
			</>
		);
	}

	return (
		<div
			className="flex min-h-dvh flex-col bg-onx-bg text-onx-on"
			data-testid="onx-app"
		>
			{/*
			 * The app bar names the module, not the page: the navigation bar already
			 * marks which page is current, so repeating it here was redundant and
			 * cost the title its width.
			 */}
			<TopAppBar
				title={MODULE_NAME}
				actions={
					<IconButton
						aria-label={tr("common_refresh", "Refresh")}
						onClick={() => void refresh()}
					>
						<Icon as={IconRefresh} />
					</IconButton>
				}
			/>

			<main className="flex-1 pb-6">
				{page === 0 ? <StatusView snapshot={snapshot} /> : null}
				{page === 1 ? (
					<ModulesView
						snapshot={snapshot}
						onRefresh={refresh}
						onNotify={notify}
					/>
				) : null}
				{page === 2 ? (
					<FnView snapshot={snapshot} onRefresh={refresh} onNotify={notify} />
				) : null}
				{page === 3 ? <LogsView /> : null}
				{page === 4 ? (
					<SettingsView
						appearance={appearance}
						onAppearanceChange={setAppearance}
						snapshot={snapshot}
						onRefresh={refresh}
						onNotify={notify}
					/>
				) : null}
			</main>

			<NavigationBar
				items={navItems}
				value={page}
				onChange={setPage}
				label={tr("common_main_navigation", "Main")}
			/>
			<SnackbarHost />
		</div>
	);
}
