// Native input, real persisted settings, restart, and ordinary local-domain HTTP.
import { parse } from "@std/toml";
import { bootServer } from "./harness-helpers.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { createSettingsRestartFixture } from "./settings-restart-fixture.mjs";
import { finalizeNativeCase } from "./native-case-finalization.mjs";
import { assert } from "./test-outcomes.mjs";

const directory = `${Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "layered-config-native-" })}/consumers`;
const multilineValue = 'first\n  second\n\n    third\n' + 'unbroken'.repeat(80);
await Deno.mkdir(directory, { recursive: true });
const vault = `${directory}/notes`, state = `${directory}/metadata/globnotes`, file = `${state}/config.toml`;
await Deno.mkdir(vault); await Deno.mkdir(`${state}/plugins/layered-probe`, { recursive: true });
await Deno.writeTextFile(`${vault}/NativeConsumer.md`, "# Native consumer\n\nSaved setting consumer.\n");
await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none" }));
await Deno.writeTextFile(file, '[brand]\nname="Initial saved name"\naccent="#123456"\n[quickaccess]\ntitle="TOML quick access consumer"\nlimit=1\n');
await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ enabled: ["layered-probe"], autoEnable: false }));
await Deno.writeTextFile(`${state}/plugins/layered-probe/manifest.json`, JSON.stringify({
  id: "layered-probe", name: "Layered probe", runtime: { server: "service.js" },
  settings: [{ id: "preferences", label: "Layered preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key: "message", label: "Message", type: "text", default: "manifest baseline" }, { key: "instructions", label: "Instructions", type: "textarea", default: "manifest instructions" }] }],
}));
await Deno.writeTextFile(`${state}/plugins/layered-probe/service.js`, "export function activate(ctx){ctx.commands.register({id:'consumer',label:'Layered consumer',target:'server'},async()=> (await ctx.settings.read()).values.preferences.message);}");
let server, session, failure, environment = { GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false" };
const results = [];
async function launch(count) {
  const logsDir = `${directory}/backend-${count}`; await Deno.mkdir(logsDir);
  return bootServer(vault, state, { env: environment, logsDir });
}
async function api(route, method = "GET", body) {
  const response = await fetch(`${server.baseUrl}/_/api/${route}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function fill(selector, value) {
  await session.click(selector);
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
  await session.type(value);
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);
}
async function branding() {
  if (await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]'); await session.button("Branding");
  await session.poll("!!document.querySelector('#brand-name')");
}
async function home(name) {
  await session.goto(`${server.baseUrl}/`);
  await session.poll(`document.title.includes(${JSON.stringify(name)}) && [...document.querySelectorAll('p')].some(p=>p.getBoundingClientRect().width>0 && p.textContent.trim()==='TOML quick access consumer') && [...document.querySelectorAll('a')].some(a=>a.textContent.includes('NativeConsumer'))`);
}
try {
  server = createSettingsRestartFixture({ initialServer: await launch(1), launch, directory });
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  await home("Initial saved name");
  assert((await api("config")).body.provenance["quickaccess.title"].layer === "toml", "Quick access lost TOML provenance");
  await branding();
  assert(await session.read('#brand-name', "!document.querySelector('#brand-name').disabled && !document.querySelector('#brand-name').readOnly"), "Unpinned name is not editable");
  await fill("#brand-name", "Native persisted brand");
  await session.button("Save branding", "[data-branding-settings]");
  await session.poll("[...document.querySelectorAll('span')].some(el=>el.childElementCount===0 && el.textContent.trim()==='Native persisted brand')");
  await session.click('[aria-label="Close settings"]');
  await session.poll("!document.querySelector('#settings-modal-title') && [...document.querySelectorAll('span')].some(el=>el.childElementCount===0 && el.textContent.trim()==='Native persisted brand' && el.getBoundingClientRect().width>0 && !el.closest('[inert]'))");
  assert(parse(await Deno.readTextFile(file)).brand.name === "Native persisted brand", "Native save did not persist TOML");
  await home("Native persisted brand");
  await server.restart(); await home("Native persisted brand");
  results.push({ name: "native-save-reload-restart", passed: true, title: await session.evaluate("document.title"), persisted: parse(await Deno.readTextFile(file)).brand.name });
  const saved = await api("plugin-host/layered-probe/settings/preferences");
  assert(saved.status === 200, "Read plugin fallback failed");
  const seeded = await api("plugin-host/layered-probe/settings/preferences", "PUT", { values: { message: "saved plugin fallback" }, revision: saved.body.revision, sourceKey: saved.body.sourceKey });
  assert(seeded.status === 200, "Seed actual plugin fallback failed");
  const pluginFile = `${state}/plugin-data/layered-probe/settings.json`, pluginBytes = await Deno.readTextFile(pluginFile);
  environment = { ...environment, GLOBNOTES_GLOBNOTES_BRAND_NAME: "Environment brand", GLOBNOTES_GLOBNOTES_PLUGINS_SETTINGS: JSON.stringify({"layered-probe":{preferences:{message:"Environment plugin consumer",instructions:multilineValue}}}) };
  await server.restart(); await home("Environment brand"); await branding();
  const pin = await session.read(['#brand-name', '#brand-accent'], "(()=>{const name=document.querySelector('#brand-name'),accent=document.querySelector('#brand-accent');return {valueOnly:name.tagName==='SPAN',value:name.textContent,reason:(name.getAttribute('aria-describedby')??'').split(' ').map(id=>document.getElementById(id)?.textContent??'').join(' '),siblingEditable:accent.matches('input[type=color]:not([disabled]):not([readonly])'),disabledControls:document.querySelectorAll('[data-branding-settings] [disabled]').length};})()");
  assert(pin.valueOnly && pin.value === 'Environment brand' && pin.reason.trim() === "Set by the server configuration" && pin.siblingEditable && pin.disabledControls === 0, "Name pin is not a value row with its reason and editable sibling");
  assert((await api("config")).body.brand.fields.name.source === "environment", "Brand pin lost environment provenance");
  await session.button("Use theme colour", "[data-branding-settings]");
  await session.button("Save branding", "[data-branding-settings]");
  await session.poll("fetch('/_/api/config').then(r=>r.json()).then(c=>c.brand.name==='Environment brand' && c.brand.accent===null)");
  const persisted = parse(await Deno.readTextFile(file));
  assert(persisted.brand.name === "Native persisted brand" && persisted.brand.accent === "", "Pinned save flattened the env name or lost the sibling edit");
  const bytes = await Deno.readTextFile(file), form = new FormData(); form.set("name", "forbidden direct name");
  const denied = await fetch(`${server.baseUrl}/_/api/brand`, { method: "POST", body: form });
  assert(denied.status === 409, "Direct brand pin mutation succeeded"); await denied.body?.cancel();
  assert(await Deno.readTextFile(file) === bytes, "Forbidden brand edit changed disk");
  await session.click('[data-settings-nav-id="plugin:layered-probe"]');
  const pluginPin = await session.poll("(()=>{const el=document.querySelector('#settings-field-message');if(el?.textContent!=='Environment plugin consumer')return false;return {value:el.textContent,valueOnly:el.tagName==='SPAN',reason:(el.getAttribute('aria-describedby')??'').split(' ').map(id=>document.getElementById(id)?.textContent??'').join(' ')};})()");
  assert(pluginPin.valueOnly && pluginPin.reason.trim() === "Set by the server configuration", `Plugin pin is missing from its actual settings consumer: ${JSON.stringify(pluginPin)}`);
  const current = (await api("plugin-host/layered-probe/settings/preferences")).body;
  assert(current.fields.message.source === "environment", "Plugin pin lost environment provenance");
  assert(current.fields.instructions.source === 'environment' && current.values.instructions === multilineValue, 'Textarea pin lost its exact source value');
  const multiline=[];
  for(const width of [1280,360]){
    await session.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const rendered=await session.read('#settings-field-instructions',`(()=>{const el=document.querySelector('#settings-field-instructions'),text=el.firstChild,value=el.textContent,style=getComputedStyle(el),lane=el.closest('.setting-row-control');const char=word=>{const start=value.indexOf(word),range=document.createRange();range.setStart(text,start);range.setEnd(text,start+1);return range.getBoundingClientRect().toJSON();};const range=document.createRange();range.setStart(text,value.indexOf('unbroken'));range.setEnd(text,value.length);return {value,tag:el.tagName,whiteSpace:style.whiteSpace,lineHeight:parseFloat(style.lineHeight),first:char('first'),second:char('second'),third:char('third'),wrappedFragments:range.getClientRects().length,width:el.clientWidth,scrollWidth:el.scrollWidth,right:el.getBoundingClientRect().right,laneRight:lane.getBoundingClientRect().right,dialogOverflow:document.querySelector('[role=dialog]').scrollWidth-document.querySelector('[role=dialog]').clientWidth,singleLineWhiteSpace:getComputedStyle(document.querySelector('#settings-field-message')).whiteSpace};})()`);
    assert(rendered.tag==='SPAN' && rendered.value===multilineValue && rendered.whiteSpace==='pre-wrap','Pinned textarea did not preserve its rendered whitespace');
    assert(rendered.second.top-rendered.first.top>=rendered.lineHeight-1 && rendered.third.top-rendered.second.top>=2*rendered.lineHeight-1 && rendered.second.left>rendered.first.left && rendered.third.left>rendered.second.left,'Pinned textarea collapsed lines, blank lines or indentation');
    assert(rendered.wrappedFragments>1 && rendered.scrollWidth<=rendered.width+1 && rendered.right<=rendered.laneRight+1 && rendered.dialogOverflow<=1,'Pinned textarea long line caused horizontal overflow');
    assert(rendered.singleLineWhiteSpace!=='pre-wrap','Single-line retained value whitespace changed');
    multiline.push({width,...rendered});
  }
  results.push({name:'pinned-textarea-rendered-lines',passed:true,multiline});
  const forbidden = await api("plugin-host/layered-probe/settings/preferences", "PUT", { values: { message: "forbidden plugin edit" }, revision: current.revision, sourceKey: current.sourceKey });
  assert(forbidden.status === 409, "Direct plugin pin edit succeeded");
  assert(await Deno.readTextFile(pluginFile) === pluginBytes, "Plugin pin overwrote the saved fallback");
  assert((await api("plugin-host/layered-probe/commands/consumer", "POST", {})).body.result === "Environment plugin consumer", "Real plugin owner did not consume the pin");
  results.push({ name: "pin-and-editable-sibling", passed: true, pin, pluginPin, forbiddenBrandStatus: denied.status, forbiddenPluginStatus: forbidden.status, savedFallbackRetained: true });
  environment = { ...environment, GLOBNOTES_GLOBNOTES_BRAND_NAME: "" };
  await server.restart(); await home("globnotes"); await branding();
  assert(await session.read('#brand-name', "document.querySelector('#brand-name').tagName==='SPAN' && document.querySelector('#brand-name').textContent==='globnotes' && !document.querySelector('[data-branding-settings] [disabled]')"), "Empty name override did not clear the rendered consumer to the default value row");
  assert(parse(await Deno.readTextFile(file)).brand.name === "Native persisted brand", "Empty pin erased saved name");
  results.push({ name: "explicit-empty-override", passed: true, savedNameRetained: true });
  assert(session.errors.length === 0, "Browser page exception");
} catch (error) { failure = error; }
finally {
  await finalizeNativeCase({ error: failure, report: async () => {
    const origin = session ? await session.evaluate("({origin:location.origin,isSecureContext})") : null;
    const page = failure && session ? await session.evaluate("({title:document.title,text:document.body?.innerText,links:[...document.querySelectorAll('a')].map(a=>({href:a.getAttribute('href'),text:a.textContent}))})") : undefined;
    if (!failure) assert(origin?.isSecureContext === false, "Insecure-context proof missing");
    await Deno.writeTextFile(`${directory}/result.json`, JSON.stringify({ passed: !failure, origin, results, page, events: session?.events, error: failure?.stack ?? null }, null, 2));
  }, cleanup: [async () => { await session?.close(); }, async () => { await server?.close(); }] });
}
if (failure) throw failure;
