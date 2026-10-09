// Deliberately wrong outputs stay inside fresh caller-owned browser fixtures.
// The real driver predicates and real suite result path must reject each one.
import { runCase } from "./legacy-fixture.mjs";
import { cases } from "./legacy-native-cases.mjs";
import { exercise as geometry } from "./test-quality-geometry.mjs";
import { executeChild, runChildren } from "./legacy-native-suite.mjs";
import { assert } from "./test-outcomes.mjs";

const style = css => `document.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);});`;
const mutations = {
  "clipboard-bytes": { driver: "copy-button", script: "const original=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=text=>original(text.includes('def greet')?'wrong selected block':text);" },
  "third-token-hidden": { driver: "code-tokens", script: "document.addEventListener('DOMContentLoaded',()=>{if(localStorage.getItem('globnotes-theme')==='catppuccin-latte'){const style=document.createElement('style');style.textContent='.token.keyword{opacity:0!important}';document.head.append(style);}});" },
  "rename-rendered-image": { driver: "rename-options", args: ["move"], script: "document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{if(location.pathname.startsWith('/archive-'))for(const image of document.querySelectorAll('.toast-viewer img'))if(image.getAttribute('src')!=='missing-native-control.png')image.setAttribute('src','missing-native-control.png');}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});});" },
  "wikilink-rendered-href": { driver: "wikilink-rename", script: "document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{for(const link of document.querySelectorAll('a[href=\"/probe/link-target-renamed\"]'))link.href='/probe/stale-target';}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});});" },
  "recent-identity": { driver: "quick-switcher", script: "document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{for(const leaf of document.querySelectorAll('ul.switcher-results *'))if(leaf.childElementCount===0&&leaf.textContent==='rendering/code-blocks')leaf.textContent='wrong/recent-identity';}).observe(document.body,{childList:true,subtree:true});});" },
  "tag-suggestion": { driver: "quick-switcher", script: style("input[placeholder=\"Search or switch to note…\"]+div p{display:none!important}") },
  "theme-palette": { driver: "theme", script: style("body{background-color:rgb(1,2,3)!important}") },
  "surface-palette": { driver: "surfaces", script: style("aside{background-color:rgb(1,2,3)!important}") },
  "sidebar-hidden-row": { driver: "sidebar-refresh", script: style("aside a[href=\"/SidebarProbe\"]{visibility:hidden!important}") },
  "logo-centerline": { driver: "test-quality-geometry", empty: true, script: "document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{for(const leaf of document.querySelectorAll('.content-column span'))if(leaf.childElementCount===0&&leaf.textContent==='Native Test Notes')leaf.style.transform='translateY(8px)';}).observe(document.body,{childList:true,subtree:true});});" },
  "navbar-stacked": { driver: "test-quality-geometry", empty: true, script: "document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{for(const leaf of document.querySelectorAll('nav span'))if(leaf.childElementCount===0&&leaf.textContent==='Native Test Notes'&&innerWidth>=640)leaf.parentElement.style.display='block';}).observe(document.body,{childList:true,subtree:true});});" },
  "footer-pill-color": { driver: "test-quality-geometry", empty: true, script: style(".switcher-results [title=\"Open the full search page\"]{color:rgb(1,2,3)!important}") },
  "equivalent-logo-css": { driver: "test-quality-geometry", empty: true, expected: true, script: "document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{for(const leaf of document.querySelectorAll('.content-column span'))if(leaf.childElementCount===0&&leaf.textContent==='Native Test Notes'&&!leaf.closest('nav')){const row=leaf.parentElement;row.classList.remove('flex','items-center');row.style.display='flex';row.style.alignItems='center';}}).observe(document.body,{childList:true,subtree:true});});" },
};

if (Deno.args[0] === "case") {
  const name = Deno.args[1], control = mutations[name];
  assert(control, "Unknown native consumer control");
  await runCase("control-" + name, async f => {
    await f.page.addInitScript(control.script);
    return (control.driver === "test-quality-geometry" ? geometry : cases[control.driver])(f, ...(control.args ?? []));
  }, { empty: control.empty ?? false });
} else {
  const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-consumer-controls-" });
  await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const outcomes = [];
  for (const [name, control] of Object.entries(mutations)) {
    const result = await executeChild(["run", "--cached-only", "--frozen", "--config=deno.json", "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys", new URL(import.meta.url).pathname, "case", name], { artifacts, label: name });
    let accepted = false;
    try { await runChildren([[name]], async () => result); accepted = true; }
    catch (error) { assert(!control.expected, `${name}: equivalent presentation was rejected: ${error}`); }
    assert(accepted === !!control.expected && !result.timedOut, `${name}: the real driver/suite did not discriminate the intended consumer`);
    outcomes.push({ name, driver: control.driver, code: result.code, accepted });
  }
  await Deno.writeTextFile(artifacts + "/controls.json", JSON.stringify(outcomes, null, 2), { createNew: true });
  console.log("Native wrong-consumer controls observed", JSON.stringify(outcomes));
}
