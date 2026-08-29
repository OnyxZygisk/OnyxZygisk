<script setup lang="ts">
/* Logs section - module operation log view.
 *
 * Auto-refresh keeps the scroll position stable so the view does not "jump"
 * while reading. Rows are parsed from the brief logcat format and colorized
 * by level; a text filter narrows the view without refetching. The content
 * is written imperatively into the <pre> (like the old version) on purpose:
 * going through Vue's renderer would reset the scroll position on every
 * update.
 */
import { onMounted, onUnmounted, ref, watch } from "vue";
import { fetchLogs } from "../api/system";
import { useLocale } from "../composables/useLocale";
import Card from "./atoms/Card.vue";
import Toolbar from "./atoms/Toolbar.vue";

const { t, locale } = useLocale();

const out = ref<HTMLPreElement | null>(null);
const lines = ref(120);
const auto = ref(true);
const filter = ref("");
const raw = ref("");
const copied = ref(false);

let timer: number | undefined;
let copyTimer: number | undefined;

/** logcat -v brief row: "I/zygiskd(1234): message" (pid optional). */
const LEVEL_RE = /^([VDIWEF])\/([^\s(]+)(?:\((\d+)\))?: ?(.*)$/;

/* All content written into the <pre> via innerHTML is escaped first (see
 * esc()); levels come from the fixed [VDIWEF] alphabet only, so no user or
 * device data can be interpreted as markup.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Turn the raw log text into colored HTML rows, filtered by `q`. */
function renderRows(text: string, q: string): string {
  const needle = q.trim().toLowerCase();
  const parts: string[] = [];
  for (const line of text.split("\n")) {
    if (needle && !line.toLowerCase().includes(needle)) continue;
    const m = LEVEL_RE.exec(line);
    if (m) {
      const [, lv, tag, pid, msg] = m;
      const tagText = esc(tag) + (pid ? `(${esc(pid)})` : "");
      const msgHtml =
        lv === "E" || lv === "F" ? `<span class="lg-err">${esc(msg)}</span>` : esc(msg);
      parts.push(
        `<span class="lg-lv lg-${lv}">${lv}</span>/<span class="lg-tag">${tagText}</span>: ${msgHtml}`,
      );
    } else {
      parts.push(esc(line));
    }
  }
  return parts.join("\n");
}

function render(): void {
  const el = out.value;
  if (!el) return;
  if (!raw.value) {
    el.innerHTML = `<span class="lg-empty">${esc(t("logs.empty"))}</span>`;
    return;
  }
  const body = renderRows(raw.value, filter.value);
  el.innerHTML = body || `<span class="lg-empty">${esc(t("logs.noMatch"))}</span>`;
}

async function load(): Promise<void> {
  const el = out.value;
  if (!el) return;
  const prev = raw.value;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  const scrollTop = el.scrollTop;

  try {
    const text = await fetchLogs(lines.value);
    // Skip only when the (non-empty) content is unchanged; an empty result
    // must still render the placeholder.
    if (text === prev && text !== "") return;
    raw.value = text || "";
    render();
    // Follow new output when pinned to the bottom, otherwise keep the
    // reader's position so the content does not jump around.
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = scrollTop;
    }
  } catch (e) {
    el.textContent = t("common.error") + ": " + (e instanceof Error ? e.message : String(e));
  }
}

async function copyLogs(): Promise<void> {
  const text = raw.value || t("logs.empty");
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Clipboard API unavailable (WebView): fall back to execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
  }
  if (ok) {
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copied.value = false), 1500);
  }
}

onMounted(() => {
  load();
  timer = window.setInterval(() => {
    if (auto.value) load();
  }, 8000);
});
onUnmounted(() => {
  window.clearInterval(timer);
  clearTimeout(copyTimer);
});
// Reload on language switch (dev mock data follows the locale).
watch(locale, () => load());
// Refilter locally without touching the scroll/fetch logic.
watch(filter, () => render());
</script>

<template>
  <section class="section">
    <Card :title="t('navbar.logs')">
      <Toolbar>
        <label class="log-lines"
          >{{ t("logs.lines") }}
          <input type="number" v-model.number="lines" min="20" max="300" />
        </label>
        <label class="log-auto"
          ><input type="checkbox" v-model="auto" /> {{ t("logs.auto") }}</label
        >
        <input type="text" v-model="filter" class="log-filter" :placeholder="t('logs.filter')" />
        <button
          type="button"
          class="icon-btn"
          :class="{ 'icon-btn--ok': copied }"
          :aria-label="copied ? t('logs.copied') : t('logs.copy')"
          @click="copyLogs"
        >
          <span class="icon-btn__glyph" :class="{ 'icon-btn__glyph--ok': copied }"></span>
        </button>
        <button type="button" class="icon-btn" :aria-label="t('common.refresh')" @click="load">
          <span class="icon-btn__glyph icon-btn__glyph--refresh"></span>
        </button>
      </Toolbar>

      <pre ref="out" class="log-box"></pre>
    </Card>
  </section>
</template>

<style scoped>
.toolbar {
  gap: 10px;
}
.log-lines {
  flex-shrink: 0;
}
.log-auto {
  flex-shrink: 0;
}
.log-filter {
  flex: 1;
  min-width: 72px;
  width: auto;
}
.lg-lv {
  font-weight: 700;
}
.lg-I {
  color: var(--green);
}
.lg-V {
  color: var(--text3);
}
.lg-D {
  color: var(--text2);
}
.lg-W {
  color: var(--orange);
}
.lg-E,
.lg-F {
  color: var(--red);
}
.lg-tag {
  color: var(--text3);
}
.lg-err {
  color: var(--red);
}
.lg-empty {
  color: var(--text3);
}
</style>
