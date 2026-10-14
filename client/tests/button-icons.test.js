// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import Icon from "../components/Icon.vue";
import IconLabel from "../components/IconLabel.vue";
import CustomButton from "../components/CustomButton.vue";
import Toggle from "../components/Toggle.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import {
  tabEdit,
  tabSave,
  tabSearch,
  tabToggleLeft,
  tabToggleRight,
} from "../icons.js";

enableAutoUnmount(afterEach);

function paths(wrapper) {
  return wrapper.findAll("path").map((path) => path.attributes("d"));
}

describe("button icon contracts", () => {
  let warnings;
  beforeEach(() => {
    warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders array and registry-key icons with CSS dimensions", () => {
    for (const icon of [tabSave, "tabSave"]) {
      const wrapper = mount(Icon, { props: { icon } });
      expect(paths(wrapper)).toEqual(tabSave);
      expect(wrapper.element.style.width).toBe("1.25em");
      expect(wrapper.element.style.height).toBe("1.25em");
      expect(wrapper.attributes("aria-hidden")).toBe("true");
    }
  });

  it("keeps automatic aspect sizing out of invalid SVG dimension attributes", () => {
    const wrapper = mount(Icon, {
      props: {
        icon: tabToggleRight,
        width: "auto",
        height: "1em",
        viewBox: "1 5 22 14",
      },
    });
    expect(wrapper.attributes("width")).toBeUndefined();
    expect(wrapper.attributes("height")).toBeUndefined();
    expect(wrapper.element.style.width).toBe("auto");
    expect(wrapper.element.style.height).toBe("1em");
    expect(wrapper.attributes("viewBox")).toBe("1 5 22 14");
  });

  it("preserves unitless SVG lengths as CSS pixels and explicit size overrides", () => {
    const wrapper = mount(Icon, {
      props: { icon: tabEdit, size: "4em", width: "20", height: "16" },
    });
    expect(wrapper.element.style.width).toBe("20px");
    expect(wrapper.element.style.height).toBe("16px");
    const sized = mount(Icon, { props: { icon: tabEdit, size: "4em" } });
    expect(sized.element.style.width).toBe("4em");
    expect(sized.element.style.height).toBe("4em");
  });

  it("accepts path arrays across labels and buttons without prop warnings", () => {
    mount(IconLabel, { props: { iconPath: tabSave, label: "Save" } });
    mount(CustomButton, { props: { iconPath: tabSave, label: "Save" } });
    mount(Toggle, { props: { label: "Edit", isOn: true } });
    expect(warnings).not.toHaveBeenCalled();
  });

  it("supports registry names in both button and label wrappers", () => {
    for (const component of [CustomButton, IconLabel]) {
      const wrapper = mount(component, {
        props: { iconPath: "tabSave", label: "Save" },
      });
      expect(paths(wrapper)).toEqual(tabSave);
    }
  });

  it("applies dirty-state colour to the icon only and clears it independently", async () => {
    const wrapper = mount(CustomButton, {
      props: {
        iconPath: tabSave,
        label: "Save",
        iconClass: "text-theme-brand",
      },
    });
    expect(wrapper.find("svg").classes()).toContain("text-theme-brand");
    expect(wrapper.find("span").classes()).not.toContain("text-theme-brand");
    expect(wrapper.find("button").classes()).not.toContain("text-theme-brand");
    await wrapper.setProps({ iconClass: "" });
    expect(wrapper.find("svg").classes()).not.toContain("text-theme-brand");
    expect(paths(wrapper)).toEqual(tabSave);
  });

  it("renders only the switch before the Edit label in both states", async () => {
    const wrapper = mount(Toggle, {
      props: { label: "Edit", isOn: false },
    });
    let icons = wrapper.findAll("svg");
    expect(icons).toHaveLength(1);
    expect(paths(icons[0])).toEqual(tabToggleLeft);
    expect(icons[0].element.style.width).toBe("auto");
    expect(wrapper.text()).toBe("Edit");
    await wrapper.setProps({ isOn: true });
    icons = wrapper.findAll("svg");
    expect(icons).toHaveLength(1);
    expect(paths(icons[0])).toEqual(tabToggleRight);
  });

  it("preserves click handlers and disabled state", async () => {
    const onClick = vi.fn();
    const wrapper = mount(CustomButton, {
      props: { iconPath: tabSave, label: "Save", onClick },
    });
    await wrapper.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ disabled: true });
    await wrapper.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(wrapper.element.disabled).toBe(true);
  });

  it("renders the error-state icon through the current Icon prop", async () => {
    const wrapper = mount(LoadingIndicator);
    wrapper.vm.setFailed("No results", tabSearch);
    await nextTick();
    expect(paths(wrapper)).toEqual(tabSearch);
    expect(wrapper.find("svg").element.style.width).toBe("4em");
    expect(warnings).not.toHaveBeenCalled();
  });
});
