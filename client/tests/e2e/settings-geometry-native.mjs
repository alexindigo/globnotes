// Actual viewport/DPR/theme geometry, hit testing, wheel and keyboard consumers.
export async function exerciseSettingsGeometry({ session, directory }) {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const outcomes = [];
  for (const viewport of [{ name: "wide", width: 1280, height: 900 }, { name: "narrow", width: 360, height: 640 }]) {
    for (const dpr of [1, 2]) for (const theme of ["light", "dark"]) {
      const label = `${viewport.name}-dpr-${dpr}-${theme}`;
      await session.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: false });
      if (await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
      await session.poll("!!document.querySelector('[aria-label=Settings]')?.getBoundingClientRect().width");
      await session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
      const footer = await session.evaluate(`(()=>{
        const gear=document.querySelector('[aria-label=Settings]'),recent=document.querySelector('[title="Recent notes"]');
        const a=gear.getBoundingClientRect(),b=recent.getBoundingClientRect();
        const hit=el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;};
        return {gear:a.toJSON(),recent:b.toJSON(),centerDelta:Math.abs(a.y+a.height/2-b.y-b.height/2),gearHit:hit(gear),recentHit:hit(recent),contained:a.x>=0&&a.right<=innerWidth&&a.y>=0&&a.bottom<=innerHeight,nonoverlap:b.right<=a.left};
      })()`);
      assert(footer.centerDelta < 0.5 && footer.gearHit && footer.recentHit && footer.contained && footer.nonoverlap, `${label}: sidebar footer geometry/hit contract failed`);
      await session.click('[aria-label="Settings"]');
      await session.poll("!!document.querySelector('#settings-modal-title') && document.querySelector('[role=dialog]')?.contains(document.activeElement)");
      await session.button("Appearance");
      await session.click(`[data-theme-id="globnotes-${theme}"]`);
      await session.poll(`document.body.classList.contains('dark')===${theme === "dark"}`);
      await session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
      const dialog = await session.evaluate(`(()=>{
        const box=document.querySelector('[data-modal-top=true] [role=dialog]'),r=box.getBoundingClientRect();
        const nav=box.querySelector('nav'),content=nav.nextElementSibling;
        return {rect:r.toJSON(),nav:nav.getBoundingClientRect().toJSON(),content:content.getBoundingClientRect().toJSON(),contained:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,overflowX:box.scrollWidth-box.clientWidth,navScrollable:nav.scrollHeight>nav.clientHeight,contentScrollable:content.scrollHeight>content.clientHeight,shellInert:document.querySelector('[data-app-shell]').inert,focusedInside:box.contains(document.activeElement),editorRetained:document.querySelector('.cm-content')===window.__gpsEditor};
      })()`);
      assert(dialog.contained && dialog.overflowX <= 1 && dialog.shellInert && dialog.focusedInside && dialog.editorRetained, `${label}: modal containment/inertness/ownership failed`);
      assert(dialog.content.right <= dialog.rect.right + 0.5 && dialog.content.bottom <= dialog.rect.bottom + 0.5, `${label}: settings content escaped its dialog`);
      // Native wheel tests observe independent scroll owners, not JS scroll assignments.
      const scrolling = {};
      for (const name of ["nav", "content"]) {
        if (!dialog[`${name}Scrollable`]) continue;
        const before = await session.evaluate(`(()=>{const nav=document.querySelector('[role=dialog] nav'),content=nav.nextElementSibling;return {nav:nav.scrollTop,content:content.scrollTop};})()`);
        const r = dialog[name];
        await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: r.x + r.width / 2, y: r.y + r.height / 2, deltaX: 0, deltaY: 300 });
        await session.poll(`(()=>{const nav=document.querySelector('[role=dialog] nav'),content=nav.nextElementSibling;return ${name}.scrollTop>${before[name]};})()`);
        const after = await session.evaluate("(()=>{const nav=document.querySelector('[role=dialog] nav'),content=nav.nextElementSibling;return {nav:nav.scrollTop,content:content.scrollTop};})()");
        const other = name === "nav" ? "content" : "nav";
        assert(after[other] === before[other], `${label}: ${name} wheel moved the other scroll owner`);
        scrolling[name] = { before, after };
      }
      await session.click('[aria-label="Close settings"]');
      await session.poll("!document.querySelector('#settings-modal-title') && document.activeElement===document.querySelector('[aria-label=Settings]')");
      await session.click('[aria-label="Settings"]');
      await session.poll("document.activeElement===document.querySelector('[aria-label=\"Close settings\"]')");
      await session.key("Tab", { modifiers: 8, windowsVirtualKeyCode: 9 });
      const wrappedLast = await session.evaluate("(()=>{const box=document.querySelector('[role=dialog]'),buttons=[...box.querySelectorAll('button:not([disabled])')].filter(el=>!el.closest('[inert]')&&el.getBoundingClientRect().width);return box.contains(document.activeElement)&&document.activeElement===buttons.at(-1);})()");
      assert(wrappedLast, `${label}: Shift+Tab did not wrap within the top Settings dialog`);
      await session.key("Tab", { windowsVirtualKeyCode: 9 });
      await session.poll("document.activeElement===document.querySelector('[aria-label=\"Close settings\"]')");
      const { data } = await session.send("Page.captureScreenshot", { format: "png" });
      await Deno.writeFile(`${directory}/${label}.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true });
      const outcome = { label, viewport, dpr, theme, footer, dialog, scrolling, nativeFocusWrap: true, openerRestored: true, screenshot: `${label}.png` };
      await Deno.writeTextFile(`${directory}/${label}.json`, JSON.stringify(outcome, null, 2), { createNew: true });
      outcomes.push(outcome);
      await session.key("Escape", { windowsVirtualKeyCode: 27 });
      await session.poll("!document.querySelector('#settings-modal-title') && document.activeElement===document.querySelector('[aria-label=Settings]')");
    }
  }
  return outcomes;
}
