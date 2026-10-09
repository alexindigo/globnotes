// Real layout/paint/focus consumers replacing CSS spelling and DOM anatomy pins.
import { runCase } from "./legacy-fixture.mjs";
import { assert } from "./test-outcomes.mjs";
import { visibleElement } from "./native-actions.mjs";

async function settled(page) {
  await page.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
}
async function trappedTab(page) {
  await page.evaluate("(()=>{const root=document.querySelector('[data-modal-top=true] [role=dialog]');const targets=[...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\"-1\"])')].filter(el=>!el.closest('[hidden],[inert],[aria-hidden=true]')&&el.getBoundingClientRect().height>0);if(targets.length<2)throw Error('Missing Tab containment controls');targets[0].setAttribute('data-quality-tab-first','');targets.at(-1).setAttribute('data-quality-tab-last','');targets.at(-1).focus();return true;})()");
  await page.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
  await page.poll("document.activeElement===document.querySelector('[data-quality-tab-first]')");
  await page.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
  await page.poll("document.activeElement===document.querySelector('[data-quality-tab-last]')");
  return { forwardContained: true, reverseContained: true };
}
export async function exercise(f) {
  const outcomes = [];
  for (const [width, height] of [[1280, 900], [360, 640]]) for (const dpr of [1, 2]) for (const mode of ["light", "dark"]) {
    await f.page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    await f.page.addInitScript(`localStorage.setItem('globnotes-theme','globnotes-${mode}');localStorage.setItem('sidebarVisible','false');`);
    await f.page.goto(f.baseUrl + "/");
    await f.page.poll("document.body.innerText.includes('No notes yet')"); await settled(f.page);
    const logo = await f.page.evaluate("(()=>{const name=[...document.querySelectorAll('.content-column span')].find(el=>el.childElementCount===0&&el.textContent==='Native Test Notes');if(!name)throw Error('Missing wordmark');const image=name.parentElement.querySelector('svg,img');if(!image)throw Error('Missing artwork');const a=name.getBoundingClientRect(),b=image.getBoundingClientRect();return{name:a.toJSON(),image:b.toJSON(),centerDelta:Math.abs(a.y+a.height/2-b.y-b.height/2),sameRow:b.right<=a.left,contained:a.right<=innerWidth&&b.left>=0};})()");
    assert(logo.name.width > 0 && logo.image.width > 0 && logo.centerDelta <= 0.5 && logo.sameRow && logo.contained, "Logo lockup lost its aligned contained row");
    const cta = await f.page.evaluate("(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Create new note');if(!button)throw Error('Missing CTA');const r=button.getBoundingClientRect(),parent=button.parentElement.getBoundingClientRect(),style=getComputedStyle(button);return{rect:r.toJSON(),parent:parent.toJSON(),background:style.backgroundColor,color:style.color,paintOrder:style.paintOrder,stroke:style.webkitTextStrokeWidth,strokeColor:style.webkitTextStrokeColor,weight:style.fontWeight};})()");
    assert(cta.rect.width > 0 && Math.abs(cta.rect.width - cta.parent.width) <= 0.5 && cta.color === "rgb(255, 255, 255)" && cta.paintOrder.includes("stroke") && parseFloat(cta.stroke)===1.5 && cta.strokeColor==='rgb(75, 85, 99)' && cta.weight==='600', "CTA painted/width contract failed");
    const brand = mode === "light" ? "rgb(2, 132, 199)" : "rgb(56, 189, 248)";
    assert(cta.background === brand, "CTA did not consume theme brand");
    await f.page.screenshot(f.directory + `/home-${width}-${height}-dpr${dpr}-${mode}.png`);
    await f.page.click('[title="Open sidebar"]'); await f.page.click('[aria-label="Settings"]');
    await f.page.poll("!!document.querySelector('#settings-modal-title')"); await settled(f.page);
    const dialog = await f.page.evaluate("(()=>{const el=document.querySelector('[data-modal-top=true] [role=dialog]'),r=el.getBoundingClientRect();return{rect:r.toJSON(),contained:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,center:Math.abs(r.x+r.width/2-innerWidth/2),overflow:el.scrollWidth-el.clientWidth};})()");
    assert(dialog.contained && dialog.center <= 0.5 && dialog.overflow <= 1, "Centered modal escaped the viewport");
    await f.page.screenshot(f.directory + `/settings-${width}-${height}-dpr${dpr}-${mode}.png`);
    const focus = await trappedTab(f.page);
    await f.page.click('[aria-label="Close settings"]'); await f.page.poll("!document.querySelector('#settings-modal-title')");
    outcomes.push({ width, height, dpr, mode, logo, cta, dialog, focus });
  }
  for (const path of ["mom/First", "mom/Second", "mom/Third"]) {
    assert((await f.api("notes", "POST", { path, content: "# " + path.split("/").at(-1) })).status === 200, "Switcher geometry fixture failed");
  }
  const navbar = [];
  for (const [width,height] of [[1280,900],[360,640]]) for (const dpr of [1,2]) for (const mode of ["light","dark"]) {
    await f.page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    await f.page.addInitScript(`localStorage.setItem('globnotes-theme','globnotes-${mode}');localStorage.setItem('sidebarVisible','false');`);
    await f.page.goto(f.baseUrl + "/mom/First");
    await f.page.poll("document.querySelector('.toast-viewer')?.textContent.includes('First')"); await settled(f.page);
    const observed = await f.page.evaluate(`(()=>{const visible=${visibleElement.toString()};const name=[...document.querySelectorAll('nav span')].find(el=>el.childElementCount===0&&el.textContent==='Native Test Notes');if(!name)throw Error('Missing responsive wordmark');const a=name.getBoundingClientRect();const image=name.parentElement.querySelector('svg,img'),b=image.getBoundingClientRect();const icons=[...document.querySelectorAll('nav a[href="/"] svg,nav a[href="/"] img')].filter(visible);return{wordmarkVisible:visible(name),artworkVisible:visible(image),name:a.toJSON(),image:b.toJSON(),centerDelta:Math.abs(a.y+a.height/2-b.y-b.height/2),sameRow:b.right<=a.left,visibleIcons:icons.length,contained:icons.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})&&a.right<=innerWidth};})()`);
    assert(observed.contained && observed.visibleIcons===1 && (width===1280 ? observed.wordmarkVisible && observed.artworkVisible && observed.centerDelta<=0.5 && observed.sameRow : !observed.wordmarkVisible), "Responsive navbar logo lost its intended contained row/icon mode");
    await f.page.screenshot(f.directory + `/navbar-${width}-${height}-dpr${dpr}-${mode}.png`);
    navbar.push({ width,height,dpr,mode,...observed });
  }
  await f.page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await f.page.goto(f.baseUrl + "/"); await f.page.poll("!!document.querySelector('[title=Search]')");
  await f.page.click('[title="Search"]');
  await f.page.evaluate("(()=>{const input=document.querySelector('input[placeholder=\"Search or switch to note…\"]');const outside=document.createElement('button');outside.id='quality-tab-outside';outside.textContent='Outside Tab probe';document.body.append(outside);input.focus();return true;})()");
  await f.page.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
  await f.page.poll("document.activeElement.id==='quality-tab-outside'");
  await f.page.evaluate("document.querySelector('#quality-tab-outside').remove();document.querySelector('input[placeholder=\"Search or switch to note…\"]').focus();true");
  await f.page.fill('input[placeholder="Search or switch to note…"]', "mom");
  await f.page.poll("document.querySelectorAll('ul.switcher-results>li').length>=4"); await settled(f.page);
  const rows = await f.page.evaluate("(()=>{return [...document.querySelectorAll('ul.switcher-results>li')].map(row=>{const hint=[...row.querySelectorAll('span')].find(el=>/^Ctrl\\+(?:\\d|Enter)$/.test(el.textContent.trim()));const content=row.firstElementChild;if(!hint)throw Error('Missing shortcut');const a=content.getBoundingClientRect(),b=hint.getBoundingClientRect(),r=row.getBoundingClientRect();return{label:row.textContent,centerDelta:Math.abs(a.y+a.height/2-b.y-b.height/2),right:b.right,contained:b.right<=r.right&&a.left>=r.left};});})()");
  assert(rows.every(row => row.centerDelta <= 0.5 && row.contained), "Switcher hints do not share the content centerline");
  assert(Math.max(...rows.map(row => row.right)) - Math.min(...rows.map(row => row.right)) <= 0.5, "Switcher footer/result shortcuts have different right edges");
  await f.page.evaluate("document.querySelector('ul.switcher-results>li:last-child').setAttribute('data-quality-footer','');true");
  const point = await f.page.evaluate("(()=>{const r=document.querySelector('[data-quality-footer]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await f.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await f.page.poll("getComputedStyle(document.querySelector('[data-quality-footer] [title=\"Open the full search page\"]')).color==='rgb(56, 189, 248)'");
  const pill = await f.page.evaluate("(()=>{const footer=document.querySelector('[data-quality-footer] [title=\"Open the full search page\"]'),style=getComputedStyle(footer);return{color:style.color,border:style.borderColor,inactive:[...document.querySelectorAll('ul.switcher-results>li:not(:last-child) [title^=\"Open result\"]')].map(el=>getComputedStyle(el).color)};})()");
  assert(pill.color==='rgb(56, 189, 248)' && pill.border==='rgb(56, 189, 248)' && pill.inactive.every(color=>color==='rgb(94, 107, 128)'), "Active footer/inactive result pills did not consume their declared palettes");
  await f.page.screenshot(f.directory + "/switcher-rows.png");
  return { visualStates: outcomes, navbarStates: navbar, switcherRows: rows, pills: pill, defaultTabTraversedOutside: true };
}
if (import.meta.main) await runCase("test-quality-geometry", exercise, { empty: true });
