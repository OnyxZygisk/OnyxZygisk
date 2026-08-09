/* OnyxZygisk — shared system-state loader (status hero + all data sections).
 *
 * App.vue provides a single instance under MONITOR_STATE_KEY so the sticky
 * hero and the Status/Modules/FN sections render the same data, refreshed
 * together every 6s (one shell round trip covers monitor, modules and FN
 * nodes). Sections fall back to a local instance when mounted standalone
 * (e.g. unit tests).
 */
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { Ref } from "vue";
import { fetchState, parseMonitor } from "../api/system";
import { useLocale } from "./useLocale";
import type { FnNodeInfo, ModuleInfo, MonitorRow } from "../types";

export const MONITOR_STATE_KEY = Symbol("monitorState");

export interface MonitorState {
  loading: Ref<boolean>;
  error: Ref<string | null>;
  monitor: Ref<MonitorRow[]>;
  modules: Ref<ModuleInfo[]>;
  fns: Ref<FnNodeInfo[]>;
  rootImpl: Ref<string>;
  version: Ref<string>;
  hotplug: Ref<boolean>;
  mountMode: Ref<string>;
  load: () => Promise<void>;
}

export function useMonitorState(): MonitorState {
  const loading = ref(true);
  const error = ref<string | null>(null);
  const monitor = ref<MonitorRow[]>([]);
  const modules = ref<ModuleInfo[]>([]);
  const fns = ref<FnNodeInfo[]>([]);
  const rootImpl = ref("");
  const version = ref("");
  const hotplug = ref(true);
  const mountMode = ref("revert");
  const { locale } = useLocale();

  let timer: number | undefined;

  async function load(): Promise<void> {
    try {
      const d = await fetchState();
      rootImpl.value = d.keys.root || "";
      version.value = d.keys.version || "";
      hotplug.value = d.keys.hotplug !== "0";
      mountMode.value = d.keys.mount_mode || "revert";
      monitor.value = parseMonitor(d.monitor);
      modules.value = d.modules;
      fns.value = d.fns;
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    load();
    timer = window.setInterval(load, 6000);
  });
  onUnmounted(() => window.clearInterval(timer));
  // Reload on language switch (dev mock data follows the locale).
  watch(locale, () => load());

  return { loading, error, monitor, modules, fns, rootImpl, version, hotplug, mountMode, load };
}
