import { expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import StatusLine from "../components/StatusLine.vue";

it("retains one status element across empty and long messages with full accessible text", async () => {
  const wrapper = mount(StatusLine, { props: { message: "" } });
  const element = wrapper.get('[role="status"]').element;
  const message = "This note changed elsewhere. Your changes will be merged when you save.";
  await wrapper.setProps({ message });
  expect(wrapper.get('[role="status"]').element).toBe(element);
  expect(wrapper.text()).toBe(message);
  expect(wrapper.attributes("title")).toBe(message);
  expect(wrapper.attributes("aria-atomic")).toBe("true");
  await wrapper.setProps({ message: "" });
  expect(wrapper.get('[role="status"]').element).toBe(element);
  expect(wrapper.attributes("title")).toBeUndefined();
  wrapper.unmount();
});
