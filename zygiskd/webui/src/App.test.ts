import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import App from "./App.vue";
import type { StateData } from "./types";

// Keep the real parseMonitor; only the data-fetching entry point is mocked.
vi.mock("./api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/system")>();
  return { ...actual, fetchState: vi.fn() };
});

import { fetchState } from "./api/system";

const monitorText = ["\tmonitor:\ttracing", "\tzygote64:\tinjected"].join("\n");

const state = (over: Partial<StateData> = {}): StateData => ({
  keys: { root: "APatch", version: "1.0" },
  monitor: monitorText,
  modules: [],
  fns: [],
  ...over,
});

const stubs = {
  ModulesSection: true,
  FnSection: true,
  LogsSection: true,
  SettingsSection: true,
};

/** jsdom does not implement a settable scrollY, so stub the getter and let the
 *  rAF-throttled scroll handler run one frame. */
async function scrollTo(y: number): Promise<void> {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

beforeEach(() => {
  vi.mocked(fetchState).mockResolvedValue(state());
});

describe("App hero", () => {
  it("renders the status hero with root label, version and working badge", async () => {
    const wrapper = mount(App, { global: { stubs } });
    await flushPromises();
    const hero = wrapper.find(".hero");
    expect(hero.exists()).toBe(true);
    expect(hero.find(".root-label__text").text()).toBe("APatch");
    expect(hero.text()).toContain("v1.0");
    expect(hero.find(".badge").text()).toContain("Working");
    expect(hero.find(".hero__extra").attributes("aria-hidden")).toBeUndefined();
    wrapper.unmount();
  });

  it("shows installed instead of unknown before the runtime status file exists", async () => {
    vi.mocked(fetchState).mockResolvedValue(
      state({
        keys: {
          root: "KernelSU",
          version: "1.0",
          installed: "1",
          runtime: "0",
          daemon: "0",
        },
        monitor: "",
      }),
    );

    const wrapper = mount(App, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find(".badge").text()).toContain("Installed");
    expect(wrapper.find(".badge").text()).not.toContain("Unknown");
    wrapper.unmount();
  });

  it("collapses to the compact style once scrolled past the threshold", async () => {
    const wrapper = mount(App, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find(".hero--compact").exists()).toBe(false);

    await scrollTo(100);

    expect(wrapper.find(".hero--compact").exists()).toBe(true);
    // The subtitle and chips stay mounted and are collapsed by CSS, so that the
    // bar animates shut as one piece; only their aria state changes here.
    expect(wrapper.find(".hero__extra").attributes("aria-hidden")).toBe("true");
    wrapper.unmount();
    await scrollTo(0);
  });

  it("stays compact until the very top, so a scrollY clamp cannot flip it back", async () => {
    const wrapper = mount(App, { global: { stubs } });
    await flushPromises();
    await scrollTo(100);
    expect(wrapper.find(".hero--compact").exists()).toBe(true);

    // A shorter document clamps scrollY downwards. Anything above the top must
    // leave the bar compact, otherwise the collapse and the clamp oscillate.
    await scrollTo(20);
    expect(wrapper.find(".hero--compact").exists()).toBe(true);
    await scrollTo(1);
    expect(wrapper.find(".hero--compact").exists()).toBe(true);

    await scrollTo(0);
    expect(wrapper.find(".hero--compact").exists()).toBe(false);
    wrapper.unmount();
  });

  it("re-measures the spacer once the fetched data has widened the hero", async () => {
    // The first measurement runs before the fetch resolves, so it misses the
    // root/version chips. jsdom reports offsetHeight as 0, so hand out a
    // growing value instead: a second, larger reading is the observable proof
    // that the hero was measured again after the data landed.
    let n = 0;
    const spy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(() => (n += 100));

    const wrapper = mount(App, { global: { stubs } });
    await nextTick();
    const onMount = wrapper.find(".hero-spacer").attributes("style");
    await flushPromises();
    await nextTick();
    const afterData = wrapper.find(".hero-spacer").attributes("style");

    expect(onMount).not.toBe("height: 0px;");
    expect(afterData).not.toBe(onMount);

    spy.mockRestore();
    wrapper.unmount();
  });

  it("reserves the expanded hero height in the flow", async () => {
    const wrapper = mount(App, { global: { stubs } });
    await flushPromises();
    // The spacer is what keeps the document height constant across the
    // collapse; it must be rendered and sized from the hero, not left at auto.
    const spacer = wrapper.find(".hero-spacer");
    expect(spacer.exists()).toBe(true);
    expect(spacer.attributes("style")).toContain("height");
    wrapper.unmount();
  });
});
