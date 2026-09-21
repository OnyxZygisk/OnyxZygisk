import { useCallback, useEffect, useRef, useState } from "react";
import IconCheck from "~icons/material-symbols/check";
import IconClose from "~icons/material-symbols/close";
import IconCopy from "~icons/material-symbols/content-copy";
import IconRefresh from "~icons/material-symbols/refresh";
import IconSearch from "~icons/material-symbols/search";
import { Card } from "../components/atoms/Card";
import { Icon } from "../components/atoms/Icon";
import { IconButton } from "../components/atoms/IconButton";
import { Switch } from "../components/atoms/Switch";
import { SectionHeader } from "../components/molecules/SectionHeader";
import { cli, keybind } from "../state/app";
import { messageOf } from "../state/system";
import { tr } from "../utils/tr";

/** logcat -v brief row: "I/zygiskd(1234): message" (pid optional). */
const LEVEL_RE = /^([VDIWEF])\/([^\s(]+)(?:\((\d+)\))?: ?(.*)$/;

const REFRESH_MS = 8000;

/**
 * Everything written into the <pre> goes through esc() first; the level class
 * comes from the fixed [VDIWEF] alphabet, so no device data can be interpreted
 * as markup.
 */
function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Level is carried by weight, never by hue: E/F are semibold, V/D are muted.
 * The message text is what the user came to read, so it is never muted by
 * level alone.
 */
function renderRows(text: string, query: string): string {
	const needle = query.trim().toLowerCase();
	const parts: string[] = [];
	for (const line of text.split("\n")) {
		if (needle !== "" && !line.toLowerCase().includes(needle)) continue;
		const match = LEVEL_RE.exec(line);
		if (match === null) {
			parts.push(esc(line));
			continue;
		}
		const level = match[1] ?? "";
		const tag = match[2] ?? "";
		const pid = match[3];
		const message = match[4] ?? "";
		const strong = level === "E" || level === "F";
		const muted = level === "V" || level === "D";
		parts.push(
			'<span class="' +
				(strong ? "onx-log-level-strong" : "onx-log-level") +
				'">' +
				level +
				"</span>" +
				'/<span class="onx-log-tag">' +
				esc(tag) +
				(pid === undefined ? "" : `(${esc(pid)})`) +
				"</span>: " +
				(muted
					? `<span class="onx-log-message-muted">${esc(message)}</span>`
					: esc(message)),
		);
	}
	return parts.join("\n");
}

function placeholder(text: string): string {
	return `<span class="onx-log-empty">${esc(text)}</span>`;
}

export function LogsView() {
	const preRef = useRef<HTMLPreElement | null>(null);
	const filterRef = useRef<HTMLInputElement | null>(null);
	const rawRef = useRef("");
	const scrollRef = useRef<{ atBottom: boolean; top: number } | null>(null);
	const copyTimer = useRef<number | undefined>(undefined);

	const [lines, setLines] = useState(120);
	const [auto, setAuto] = useState(true);
	const [filter, setFilter] = useState("");
	const [raw, setRaw] = useState("");
	const [copied, setCopied] = useState(false);

	const load = useCallback(async () => {
		const element = preRef.current;
		if (element === null) return;
		// Follow new output when pinned to the bottom, otherwise keep the
		// reader's position so the content does not jump around.
		const atBottom =
			element.scrollHeight - element.scrollTop - element.clientHeight < 48;
		const top = element.scrollTop;
		try {
			const text = await cli.fetchLogs(lines);
			// Skip only when the (non-empty) content is unchanged; an empty
			// result must still render the placeholder.
			if (text === rawRef.current && text !== "") return;
			rawRef.current = text;
			scrollRef.current = { atBottom, top };
			setRaw(text);
		} catch (error) {
			element.textContent = `${tr("common_error", "Error")}: ${messageOf(error)}`;
		}
	}, [lines]);

	// The log panel is the one place the WebUI touches the DOM directly: going
	// through React's renderer would reset the scroll position on every update.
	useEffect(() => {
		const element = preRef.current;
		if (element === null) return;
		element.innerHTML =
			raw === ""
				? placeholder(tr("logs_empty", "(no logs)"))
				: renderRows(raw, filter) === ""
					? placeholder(tr("logs_no_match", "No matching lines"))
					: renderRows(raw, filter);
		const scroll = scrollRef.current;
		if (scroll !== null) {
			element.scrollTop = scroll.atBottom ? element.scrollHeight : scroll.top;
			scrollRef.current = null;
		}
	}, [raw, filter]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!auto) return;
		const timer = window.setInterval(() => void load(), REFRESH_MS);
		return () => window.clearInterval(timer);
	}, [auto, load]);

	useEffect(() => () => window.clearTimeout(copyTimer.current), []);

	// Ctrl+F focuses the filter. The handler returns true only when it acted,
	// so Escape and every other key still belong to the open dialog.
	useEffect(
		() =>
			keybind.on("keybind-search", () => {
				filterRef.current?.focus();
				return true;
			}),
		[],
	);

	async function copy(): Promise<void> {
		const text = rawRef.current || tr("logs_empty", "(no logs)");
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch {
			// Clipboard API unavailable in some WebViews: fall back to
			// execCommand.
			const area = document.createElement("textarea");
			area.value = text;
			document.body.appendChild(area);
			area.select();
			try {
				ok = document.execCommand("copy");
			} catch {
				ok = false;
			}
			area.remove();
		}
		if (!ok) return;
		setCopied(true);
		window.clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
	}

	return (
		<>
			<SectionHeader>{tr("logs_section", "Logs")}</SectionHeader>
			<div className="px-4">
				<Card>
					<div className="flex items-center gap-3">
						<label
							htmlFor="log-lines"
							className="shrink-0 text-onx-caption text-onx-muted"
						>
							{tr("logs_lines", "Lines")}
						</label>
						<input
							id="log-lines"
							type="number"
							min={20}
							max={300}
							value={lines}
							onChange={(event) =>
								setLines(
									Math.min(
										300,
										Math.max(20, Number(event.target.value) || 120),
									),
								)
							}
							className="h-10 w-20 shrink-0 rounded-onx-md bg-onx-container-high px-2 text-onx-body text-onx-on"
						/>
						<span className="shrink-0 text-onx-caption text-onx-muted">
							{tr("logs_auto", "Auto")}
						</span>
						<Switch
							aria-label={tr("logs_auto", "Auto")}
							checked={auto}
							onChange={setAuto}
						/>
						<span className="flex-1" />
						<IconButton
							aria-label={
								copied
									? tr("logs_copied", "Copied")
									: tr("logs_copy", "Copy logs")
							}
							onClick={() => void copy()}
						>
							<Icon as={copied ? IconCheck : IconCopy} size="md" />
						</IconButton>
						<IconButton
							aria-label={tr("common_refresh", "Refresh")}
							onClick={() => void load()}
						>
							<Icon as={IconRefresh} size="md" />
						</IconButton>
					</div>
					<div className="mt-3 flex h-10 items-center gap-2 rounded-onx-md bg-onx-container-high px-3">
						<Icon as={IconSearch} size="md" className="text-onx-muted" />
						<input
							ref={filterRef}
							type="search"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder={tr("logs_filter", "Filter")}
							aria-label={tr("logs_filter", "Filter")}
							className="min-w-0 flex-1 bg-transparent text-onx-body text-onx-on outline-none placeholder:text-onx-muted"
						/>
						{filter !== "" ? (
							<IconButton
								aria-label={tr("logs_clear_filter", "Clear filter")}
								className="size-8"
								onClick={() => setFilter("")}
							>
								<Icon as={IconClose} size="sm" />
							</IconButton>
						) : null}
					</div>
					<pre
						ref={preRef}
						data-testid="log-panel"
						className="onx-scroll mt-3 h-80 max-h-[55dvh] whitespace-pre-wrap wrap-anywhere text-onx-mono text-onx-on"
					/>
				</Card>
			</div>
		</>
	);
}
