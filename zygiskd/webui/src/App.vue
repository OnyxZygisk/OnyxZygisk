<script setup lang="ts">
/* App — the page header is the live status hero: it sticks to the top while
 * scrolling and collapses into a compact bar (small icon, chips hidden).
 * System state is shared with the data sections via MONITOR_STATE_KEY.
 */
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { fmtVer } from "./api/system";
import { MONITOR_STATE_KEY, useMonitorState } from "./composables/useMonitorState";
import { useLocale } from "./composables/useLocale";
import FnSection from "./components/FnSection.vue";
import LogsSection from "./components/LogsSection.vue";
import ModulesSection from "./components/ModulesSection.vue";
import SettingsSection from "./components/SettingsSection.vue";

const { t, locale } = useLocale();

const state = useMonitorState();
provide(MONITOR_STATE_KEY, state);
const { loading, error, monitor, rootImpl, version, installed, runtimeReady, daemonRunning } = state;

function valClass(v: string): string {
  if (/not injected|stopped|exited|crashed|invalid/i.test(v)) return "err";
  if (/tracing|injected|running/i.test(v)) return "ok";
  if (/unknown/i.test(v)) return "warn";
  return "";
}

/** Overall hero badge derived from the live monitor rows.
 *
 * The `monitor` row is authoritative for whether the framework is running:
 * `tracing` = up, `stopped`/`exited` = down. Sub-rows such as
 * `zygote64: not injected` mean injection is merely *pending* — no app has
 * forked since boot yet — NOT that the monitor stopped, so they must not, on
 * their own, flip the hero to "stopped" (which previously happened the whole
 * time between boot and the first fork, and whenever a second ABI had nothing
 * to inject into). Only a stopped/exited monitor, or a crashed daemon, is a
 * genuine "stopped".
 */
const overall = computed(() => {
  if (loading.value) return { key: "common.loading", cls: "badge--idle", spin: true };
  if (error.value) return { key: "status.error", cls: "badge--err", spin: false };
  const rows = monitor.value.filter((r) => r.label);
  if (!rows.length) {
    if (daemonRunning.value)
      return { key: "status.working", cls: "badge--ok", spin: false };
    if (installed.value)
      return { key: "status.installed", cls: "badge--warn", spin: false };
    return { key: "status.unknown", cls: "badge--idle", spin: false };
  }

  const monitorVal = rows.find((r) => r.label === "monitor")?.value ?? "";

  // Genuinely-stopped states.
  if (/stopped|exited/i.test(monitorVal))
    return { key: "status.stopped", cls: "badge--err", spin: false };
  if (rows.some((r) => /crashed/i.test(r.value)))
    return { key: "status.stopped", cls: "badge--err", spin: false };

  // Monitor is tracing → the framework is up and watching, so it reads as
  // "working". A zygote that is not injected yet just means no app has forked
  // since boot; that shows on its own detail row and must not water the hero
  // down while the monitor is plainly running.
  if (/tracing/i.test(monitorVal))
    return { key: "status.working", cls: "badge--ok", spin: false };

  // No monitor row (older builds / partial status) but something reads healthy.
  if (rows.some((r) => valClass(r.value) === "ok"))
    return { key: "status.working", cls: "badge--ok", spin: false };
  if (installed.value && !runtimeReady.value)
    return { key: "status.installed", cls: "badge--warn", spin: false };
  return { key: "status.unknown", cls: "badge--warn", spin: false };
});

const compact = ref(false);
const heroEl = ref<HTMLElement | null>(null);
/** Expanded hero height, held in the flow by the spacer (see the style block). */
const heroHeight = ref(0);

/** Collapse animation length; keep in sync with the transitions in the style block. */
const COLLAPSE_MS = 250;
let settling: number | undefined;
let animating = false;

function measure(): void {
  // Only the settled, expanded height is ever recorded. Tracking the compact
  // bar would shorten the document by ~60px the moment the hero collapsed —
  // the twitch this component kept regressing into, see onScroll. Mid-animation
  // frames are skipped too, otherwise the spacer would follow the hero down and
  // back up while it expands and drag the page content with it.
  if (compact.value || animating || !heroEl.value) return;
  heroHeight.value = heroEl.value.offsetHeight;
}

watch(compact, () => {
  animating = true;
  clearTimeout(settling);
  settling = window.setTimeout(() => {
    animating = false;
    measure();
  }, COLLAPSE_MS + 50);
});

// Everything that changes the hero's height, re-measured explicitly. The first
// measurement runs before the initial fetch resolves, so it misses the chips;
// without these the spacer would stay ~20px short and the header would overlap
// the page. A ResizeObserver alone is not enough — some WebViews never deliver
// its callbacks, and then nothing would ever correct that first reading.
watch([rootImpl, version, loading, locale], () => nextTick(measure));

// Coalesce scroll events into a single class update per animation frame.
let rafId = 0;
function onScroll(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const y = window.scrollY;
    // Asymmetric thresholds. A single threshold flips on every pixel of scroll
    // jitter around it, and the browser clamping scrollY after a layout change
    // used to push the state straight back across it — the two fed each other
    // and the bar convulsed. Collapsing needs real downward scroll; expanding
    // only happens back at the very top, which no clamp can overshoot into.
    if (compact.value ? y <= 0 : y > 24) compact.value = !compact.value;
  });
}

let ro: ResizeObserver | undefined;
onMounted(() => {
  measure();
  // Re-measure when the hero's content changes height (chips arriving after the
  // first fetch, a locale switch, a viewport resize rewrapping the subtitle).
  if (heroEl.value && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(measure);
    ro.observe(heroEl.value);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", measure, { passive: true });
  onScroll();
});
onUnmounted(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", measure);
  ro?.disconnect();
  clearTimeout(settling);
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
  <header ref="heroEl" class="hero" :class="{ 'hero--compact': compact }">
    <div class="hero__icon" aria-hidden="true">
      <span class="hero__glyph"></span>
    </div>
    <div class="hero__body">
      <div class="hero__title">OnyxZygisk</div>
      <!-- Kept mounted and collapsed by CSS: removing it with v-if would drop
           ~40px of the hero instantly and the padding would animate alone. -->
      <div class="hero__extra" :aria-hidden="compact || undefined">
        <div class="hero__sub">{{ t("header.subtitle") }}</div>
        <div class="hero__chips">
          <span v-if="rootImpl" class="chip chip--accent root-label">
            <span class="root-label__text">{{ rootImpl }}</span>
          </span>
          <span v-if="version" class="chip">{{ fmtVer(version) }}</span>
        </div>
      </div>
    </div>
    <span class="badge" :class="overall.cls">
      <span v-if="overall.spin" class="spinner"></span>
      <span v-else class="dot"></span>
      {{ t(overall.key) }}
    </span>
  </header>
  <div class="hero-spacer" :style="{ height: heroHeight + 'px' }"></div>

  <div id="page_content">
    <ModulesSection />
    <FnSection />
    <LogsSection />
    <SettingsSection />
  </div>
</template>

<style scoped>
/* ── status hero: page header, pinned to the top, collapses on scroll ──
 * Fixed rather than sticky, with .hero-spacer holding its expanded height in
 * the flow. A sticky hero is part of the document, so collapsing it shortened
 * the page mid-scroll: content jerked upwards under the finger and the
 * resulting scrollY clamp re-entered the scroll handler. Fixed + spacer keeps
 * the document height constant no matter which state the bar is in.
 */
.hero {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  background:
    radial-gradient(130% 200% at 100% -20%, var(--primary-bg), transparent 50%), var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-hero);
  padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px;
  /* Animating padding / radius / size is only affordable because the hero is
   * out of flow: the reflow each frame is scoped to this header's handful of
   * nodes instead of the whole document. */
  transition:
    padding 0.25s ease,
    border-radius 0.25s ease,
    background-color 0.25s ease,
    box-shadow 0.25s ease;
}
.hero-spacer {
  width: 100%;
}
/* Brand accent line along the bottom edge of the expanded hero. */
.hero::after {
  content: "";
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--primary), transparent);
  opacity: 0.55;
  pointer-events: none;
}
.hero--compact {
  padding: calc(10px + env(safe-area-inset-top, 0px)) 20px 10px;
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-top: none;
  background: var(--header-bg);
  box-shadow: none;
  /* No backdrop-filter here: enabling a blur mid-scroll forces the WebView
   * to re-render the blurred region on every animation frame and stutters
   * badly on Android. The header background is opaque enough on its own. */
}
.hero--compact::after {
  display: none;
}
.hero__icon {
  width: 60px;
  height: 60px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background:
    radial-gradient(120% 120% at 80% 20%, var(--primary-bg), transparent 55%),
    linear-gradient(135deg, var(--primary-bg), transparent 65%);
  transition:
    width 0.25s ease,
    height 0.25s ease,
    border-radius 0.25s ease;
}
.hero__glyph {
  display: block;
  width: 40px;
  height: 40px;
  background-color: var(--primary);
  -webkit-mask: url("/icons/syringe.svg") center / contain no-repeat;
  mask: url("/icons/syringe.svg") center / contain no-repeat;
  transition:
    width 0.25s ease,
    height 0.25s ease;
}
/* Subtitle + chips: collapse together with the bar instead of disappearing. */
.hero__extra {
  overflow: hidden;
  max-height: 64px;
  opacity: 1;
  transition:
    max-height 0.25s ease,
    opacity 0.16s ease;
}
.hero--compact .hero__extra {
  max-height: 0;
  opacity: 0;
}
.hero--compact .hero__icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
}
.hero--compact .hero__glyph {
  width: 24px;
  height: 24px;
}
/* Compact bar: regular-size title, no status badge (reads as a toolbar). */
.hero--compact .hero__title {
  font-size: 16px;
  font-weight: 700;
}
.hero--compact .badge {
  display: none;
}
.hero__body {
  flex: 1;
  min-width: 0;
}
.hero__title {
  font-size: 20px;
  font-weight: 750;
  letter-spacing: -0.3px;
  line-height: 1.25;
}
.hero__sub {
  font-size: 13px;
  color: var(--text2);
  margin-top: 3px;
}
.hero__chips {
  display: flex;
  gap: 6px;
  margin-top: 7px;
  flex-wrap: wrap;
}
/* Slightly stronger badge in the expanded hero (tint border via currentColor). */
.hero .badge {
  font-size: 13px;
  padding: 5px 14px;
  border: 1px solid transparent;
  border-color: color-mix(in srgb, currentColor 28%, transparent);
}
</style>
