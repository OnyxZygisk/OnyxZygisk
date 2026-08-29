import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulesSection from "./ModulesSection.vue";
import type { StateData } from "../types";

vi.mock("../api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/system")>();
  return { ...actual, fetchState: vi.fn(), setModuleHotplug: vi.fn() };
});

import { fetchState, setModuleHotplug } from "../api/system";

const state = (over: Partial<StateData> = {}): StateData => ({
  keys: {},
  monitor: "",
  modules: [
    {
      id: "playintegrityfix",
      name: "Play Integrity Fix",
      version: "v18.8",
      author: "chiteroman",
      zygisk: true,
      disabled: false,
      desc: "修复认证",
      pendingUpdate: false,
      hotplugEnabled: false,
      hotplugged: false,
    },
    {
      id: "tricky_store",
      name: "Tricky Store",
      version: "v1.2.1",
      author: "5ec1cff",
      zygisk: true,
      disabled: true,
      desc: "",
      pendingUpdate: false,
      hotplugEnabled: false,
      hotplugged: false,
    },
  ],
  fns: [],
  ...over,
});

beforeEach(() => {
  vi.mocked(fetchState).mockClear();
  vi.mocked(fetchState).mockResolvedValue(state());
  vi.mocked(setModuleHotplug).mockResolvedValue(undefined);
});

describe("ModulesSection", () => {
  it("renders the module list with meta and description", async () => {
    const wrapper = mount(ModulesSection);
    await flushPromises();
    expect(wrapper.findAll(".mod-row")).toHaveLength(2);
    expect(wrapper.find(".mod-row__name").text()).toBe("Play Integrity Fix");
    expect(wrapper.find(".mod-row__ver").text()).toBe("v18.8");
    expect(wrapper.find(".mod-row__author").text()).toBe("chiteroman");
    expect(wrapper.find(".mod-row__desc").text()).toBe("修复认证");
    wrapper.unmount();
  });

  it("shows enabled/disabled status per module", async () => {
    const wrapper = mount(ModulesSection);
    await flushPromises();
    const statuses = wrapper.findAll(".mod-row__status");
    expect(statuses[0].text()).toBe("Enabled");
    expect(statuses[0].classes()).toContain("on");
    expect(statuses[1].text()).toBe("Disabled");
    expect(statuses[1].classes()).toContain("off");
    wrapper.unmount();
  });

  it("falls back to the module id when the name is missing", async () => {
    vi.mocked(fetchState).mockResolvedValue(
      state({
        modules: [
          {
            id: "bare",
            name: "",
            version: "1.0",
            author: "",
            zygisk: true,
            disabled: false,
            desc: "",
            pendingUpdate: false,
            hotplugEnabled: false,
      hotplugged: false,
          },
        ],
      }),
    );
    const wrapper = mount(ModulesSection);
    await flushPromises();
    expect(wrapper.find(".mod-row__name").text()).toBe("bare");
    wrapper.unmount();
  });

  it("hides modules that are not Zygisk-capable", async () => {
    vi.mocked(fetchState).mockResolvedValue(
      state({
        modules: [
          {
            id: "plain_system_module",
            name: "Plain Module",
            version: "1.0",
            author: "someone",
            zygisk: false,
            disabled: false,
            desc: "",
            pendingUpdate: false,
            hotplugEnabled: false,
      hotplugged: false,
          },
        ],
      }),
    );
    const wrapper = mount(ModulesSection);
    await flushPromises();
    expect(wrapper.findAll(".mod-row")).toHaveLength(0);
    expect(wrapper.text()).toContain("No Zygisk modules installed");
    wrapper.unmount();
  });

  it("shows the empty state", async () => {
    vi.mocked(fetchState).mockResolvedValue(state({ modules: [] }));
    const wrapper = mount(ModulesSection);
    await flushPromises();
    expect(wrapper.text()).toContain("No Zygisk modules installed");
    wrapper.unmount();
  });

  it("shows a hotplug switch instead of the status text for a pending update, and toggles it", async () => {
    vi.mocked(fetchState).mockResolvedValue(
      state({
        modules: [
          {
            id: "playintegrityfix",
            name: "Play Integrity Fix",
            version: "v18.8",
            author: "chiteroman",
            zygisk: true,
            disabled: false,
            desc: "",
            pendingUpdate: true,
            hotplugEnabled: false,
      hotplugged: false,
          },
        ],
      }),
    );
    const wrapper = mount(ModulesSection);
    await flushPromises();

    expect(wrapper.find(".mod-row__status").exists()).toBe(false);
    const toggle = wrapper.find(".mod-row__hotplug input[type=checkbox]");
    expect((toggle.element as HTMLInputElement).checked).toBe(false);

    await toggle.setValue(true);
    await flushPromises();
    expect(setModuleHotplug).toHaveBeenCalledWith("playintegrityfix", true);
    wrapper.unmount();
  });

  it("allows a stale disabled hotplug module to be explicitly re-enabled", async () => {
    vi.mocked(fetchState).mockResolvedValue(
      state({
        modules: [
          {
            id: "zygisk_vector",
            name: "Vector",
            version: "1.0",
            author: "Vector",
            zygisk: true,
            disabled: true,
            desc: "",
            pendingUpdate: false,
            hotplugEnabled: true,
            hotplugged: true,
          },
        ],
      }),
    );
    const wrapper = mount(ModulesSection);
    await flushPromises();

    const toggle = wrapper.find(".mod-row__hotplug input[type=checkbox]");
    expect((toggle.element as HTMLInputElement).checked).toBe(false);
    expect((toggle.element as HTMLInputElement).disabled).toBe(false);

    await toggle.setValue(true);
    await flushPromises();
    expect(setModuleHotplug).toHaveBeenCalledWith("zygisk_vector", true);
    wrapper.unmount();
  });
});
