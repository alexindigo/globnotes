// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";

import Logo from "../components/Logo.vue";
import { useGlobalStore } from "../globalStore.js";

// Layout pin for the responsive brand lockup (concilium convention: every
// e2e-probed affordance gets a unit-level presence pin). The lockup must
// stay a FLEX row when the responsive variant un-hides it: `hidden
// sm:block` overrides `.flex` in the compiled stylesheet (responsive
// utilities sort later), and preflight makes svg block — so a `sm:block`
// lockup stacks the icon above the wordmark the moment a brand name
// renders. jsdom can't compute Tailwind utilities, so this pins the class
// contract: `sm:flex`, never `sm:block`.
describe("Logo responsive lockup", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mountLogo() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useGlobalStore();
    store.config = {
      brand: { name: "my notes", accent: "#53c729", files: [] },
    };
    const el = document.createElement("div");
    document.body.appendChild(el);
    createApp(() => h(Logo, { responsive: true })).use(pinia).mount(el);
    return el;
  }

  it("renders the wordmark and keeps the lockup a flex row when un-hidden", () => {
    const el = mountLogo();
    const lockup = el.querySelector("span.hidden");
    expect(lockup).toBeTruthy();
    expect(lockup.className).toContain("sm:flex");
    expect(lockup.className).not.toContain("sm:block");
    expect(lockup.className).toContain("flex");
    // The brand name renders inside the lockup (same row as the icon).
    expect(lockup.textContent).toContain("my notes");
    // The wordmark stretches to the hero column width (100%) and wraps
    // only when the name exceeds it — no force-nowrap overflow. The icon
    // keeps its footprint (flex-shrink 0).
    const wordmark = [...lockup.children].at(-1);
    expect(wordmark.style.whiteSpace).not.toBe("nowrap");
    expect(wordmark.style.maxWidth).toBe("100%");
    const icon = lockup.querySelector("span, img");
    expect(icon.className).toContain("flex-shrink-0");
  });
});
