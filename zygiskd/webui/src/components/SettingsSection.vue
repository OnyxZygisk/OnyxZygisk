<script setup lang="ts">
/* Settings section — theme, language, hot-plug master switch. */
import { inject, ref } from "vue";
import { setHotplugMaster, setMountMode } from "../api/system";
import type { MountMode } from "../api/system";
import { useLocale } from "../composables/useLocale";
import { AUTO_LOCALE } from "../composables/useLocale";
import type { LocalePref } from "../composables/useLocale";
import { THEMES, applyTheme, getThemePref, setThemePref } from "../composables/useTheme";
import type { ThemePref } from "../composables/useTheme";
import { MONITOR_STATE_KEY, useMonitorState } from "../composables/useMonitorState";
import type { MonitorState } from "../composables/useMonitorState";
import Card from "./atoms/Card.vue";
import Switch from "./atoms/Switch.vue";

const { t, locale, setLocale, availableLocales } = useLocale();

const theme = ref<ThemePref>(getThemePref());

// Shared 6s-polled state (provided by App.vue); local fallback for standalone.
const state = inject<MonitorState | null>(MONITOR_STATE_KEY, null) ?? useMonitorState();
const { hotplug, mountMode, load } = state;

const MOUNT_MODES: MountMode[] = ["revert", "setns", "global"];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function onTheme(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as ThemePref;
  theme.value = v;
  setThemePref(v);
  applyTheme(v);
}

function onLang(e: Event): void {
  setLocale((e.target as HTMLSelectElement).value as LocalePref);
}

async function toggleHotplug(enabled: boolean): Promise<void> {
  try {
    await setHotplugMaster(enabled);
    await load();
  } catch {
    /* the next poll re-syncs the switch state */
  }
}

async function onMountMode(e: Event): Promise<void> {
  try {
    await setMountMode((e.target as HTMLSelectElement).value as MountMode);
    await load();
  } catch {
    /* the next poll re-syncs the dropdown */
  }
}
</script>

<template>
  <section class="section">
    <Card :title="t('navbar.settings')">
      <div class="setting-row">
        <span class="s-label">{{ t("settings.theme") }}</span>
        <select :value="theme" @change="onTheme">
          <option v-for="th in THEMES" :key="th" :value="th">
            {{ t(`settings.theme${cap(th)}`) }}
          </option>
        </select>
      </div>
      <div class="setting-row">
        <span class="s-label">{{ t("settings.language") }}</span>
        <select :value="locale" @change="onLang">
          <option :value="AUTO_LOCALE">{{ t("settings.languageAuto") }}</option>
          <option v-for="[code, name] in availableLocales" :key="code" :value="code">
            {{ name }}
          </option>
        </select>
      </div>
      <div class="setting-row">
        <span class="s-label">
          {{ t("settings.hotplug") }}
          <span class="hint">{{ t("settings.hotplugHint") }}</span>
        </span>
        <Switch :checked="hotplug" @update:checked="toggleHotplug" />
      </div>
      <div class="setting-row">
        <span class="s-label">
          {{ t("settings.mountMode") }}
          <span class="hint">{{ t(`settings.mountMode_${mountMode}_hint`) }}</span>
        </span>
        <select :value="mountMode" @change="onMountMode">
          <option v-for="m in MOUNT_MODES" :key="m" :value="m">
            {{ t(`settings.mountMode_${m}`) }}
          </option>
        </select>
      </div>
    </Card>

    <!-- <Card :title="t('settings.about')">
      <p class="hint">{{ t("settings.aboutText") }}</p>
    </Card> -->
  </section>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
.setting-row + .setting-row {
  border-top: 1px solid var(--border);
}
.setting-row .s-label {
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.setting-row .hint {
  font-size: 11px;
}
</style>
