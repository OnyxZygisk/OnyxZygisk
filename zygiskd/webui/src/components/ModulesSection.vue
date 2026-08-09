<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { fmtVer, setModuleHotplug } from "../api/system";
import { useLocale } from "../composables/useLocale";
import { MONITOR_STATE_KEY, useMonitorState } from "../composables/useMonitorState";
import type { MonitorState } from "../composables/useMonitorState";
import Card from "./atoms/Card.vue";
import Switch from "./atoms/Switch.vue";
import type { ModuleInfo } from "../types";

const { t } = useLocale();
// Shared 6s-polled state (provided by App.vue); local fallback for standalone mounts.
const state = inject<MonitorState | null>(MONITOR_STATE_KEY, null) ?? useMonitorState();
const { loading, error, modules, hotplug, load } = state;

// Only Zygisk-capable modules are shown (the shell also filters them).
const zygiskModules = computed(() => modules.value.filter((m) => m.zygisk));

const msg = ref("");

async function toggleHotplug(m: ModuleInfo, enabled: boolean) {
  msg.value = "";
  try {
    await setModuleHotplug(m.id, enabled);
    // No zygote restart: killing zygote makes the whole framework restart
    // (a soft reboot) on some OEMs. The daemon serves the staged module to
    // every process forked after this point, and the manager itself picks it
    // up when reopened.
    msg.value = t("modules.hotplugNote");
    await load();
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <section class="section">
    <Card :title="t('navbar.modules')">
      <div v-if="loading" class="empty">{{ t("common.loading") }}</div>
      <div v-else-if="error" class="empty">{{ t("common.error") }}: {{ error }}</div>
      <div v-else-if="!zygiskModules.length" class="empty">{{ t("modules.empty") }}</div>
      <div v-else>
        <div v-for="m in zygiskModules" :key="m.id" class="mod-row list-row">
          <div class="mod-row__main">
            <span class="mod-row__name">{{ m.name || m.id }}</span>
            <span class="mod-row__ver">{{ fmtVer(m.version) }}</span>
          </div>
          <div class="mod-row__meta">
            <span v-if="m.desc" class="mod-row__desc">{{ m.desc }}</span>
            <span v-if="m.pendingUpdate" class="mod-row__pending">{{ t("modules.pendingUpdate") }}</span>
          </div>
          <div class="mod-row__foot">
            <span class="mod-row__author">{{ m.author || t("modules.unknownAuthor") }}</span>
            <!-- A staged update can be applied early (plug); a module already
                 hot-plugged into the active dir, or still opted in after a
                 reboot, keeps a plug/unplug switch. -->
            <div
              v-if="m.pendingUpdate || m.hotplugged || m.hotplugEnabled"
              class="mod-row__hotplug"
            >
              <span class="mod-row__hotplug-label">
                {{ m.pendingUpdate ? t("modules.hotplug") : t("modules.hotplugToggle") }}
                <span v-if="!hotplug" class="mod-row__hotplug-off">{{ t("modules.hotplugOff") }}</span>
              </span>
              <Switch
                :checked="m.hotplugEnabled"
                :disabled="!hotplug"
                @update:checked="toggleHotplug(m, $event)"
              />
            </div>
            <span v-else class="mod-row__status" :class="m.disabled ? 'off' : 'on'">
              {{ m.disabled ? t("common.disabled") : t("common.enabled") }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="msg" class="msg">{{ msg }}</div>
    </Card>
  </section>
</template>

<style scoped>
.mod-row__main {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mod-row__name {
  font-size: 14px;
  font-weight: 600;
}
.mod-row__ver {
  font-size: 12px;
  color: var(--text3);
}
.mod-row__meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.mod-row__desc {
  font-size: 12px;
  color: var(--text2);
}
.mod-row__pending {
  font-size: 11px;
  color: var(--orange);
  font-weight: 500;
}
.mod-row__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
}
.mod-row__author {
  font-size: 11px;
  color: var(--text3);
}
.mod-row__status {
  font-size: 11px;
  font-weight: 500;
}
.mod-row__status.on {
  color: var(--green);
}
.mod-row__status.off {
  color: var(--text3);
}
.mod-row__hotplug {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mod-row__hotplug-label {
  font-size: 11px;
  color: var(--text3);
  display: flex;
  align-items: center;
  gap: 6px;
}
.mod-row__hotplug-off {
  color: var(--orange);
}
</style>
