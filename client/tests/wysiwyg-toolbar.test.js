// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import WysiwygToolbar from "../components/WysiwygToolbar.vue";

// Guard: every toolbar button that declares an icon must render real icon
// path data. Regression for the static-string binding (`icon="btn.icon"`),
// which resolved every icon lookup to undefined and left only the H1/H2/H3
// text buttons visible.
describe("WysiwygToolbar icon bindings", () => {
  it("renders path data for every icon-declaring button", () => {
    const wrapper = mount(WysiwygToolbar, {
      props: { innerRef: {}, activeState: {} },
    });
    const buttons = wrapper.findAll(".wysiwyg-toolbar .toolbar-btn");
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      const svg = btn.find("svg");
      if (svg.exists()) {
        // A bound icon yields path elements; the string-literal regression
        // rendered an empty <svg> (ICON_PATHS["btn.icon"] → undefined).
        expect(svg.findAll("path").length).toBeGreaterThan(0);
      } else {
        // No icon → the label fallback must be the heading text, not a
        // silently-swallowed binding.
        expect(btn.text()).toMatch(/^(H1|H2|H3)$/);
      }
    }
  });
});
