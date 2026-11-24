// Actual Settings adapters, rendered viewer/debug consumers and search-sort UI.
import { settleSettingsInventory } from "./settings-inventory-native.mjs";
import { showSidebar } from './sidebar-navigation-native.mjs';
export async function exerciseSettingsMenu({ session, server, state, headers }) {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const api = async path => {
    const response = await fetch(`${server.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5000) });
    assert(response.ok, `Menu consumer rejected ${path}`);
    return response.json();
  };
  async function open() {
    await showSidebar(session);
    await session.click('[aria-label="Settings"]');
    await session.poll("!!document.querySelector('#settings-modal-title')");
  }
  async function close() {
    await session.click('[aria-label="Close settings"]');
    await session.poll("!document.querySelector('#settings-modal-title')");
  }
  await session.poll("!!document.querySelector('.toast-viewer pre')");
  assert(!await session.evaluate("!!document.querySelector('.toast-viewer .line-numbers-rows')"), "Fresh line-numbers preference is not off");
  await open();
  await session.button("Editor");
  await session.click('[data-modal-top="true"] button.group');
  await session.poll("localStorage.getItem('viewLineNumbers')==='true' && !!document.querySelector('.toast-viewer .line-numbers-rows')");
  await close();
  assert(await session.evaluate("document.querySelectorAll('.toast-viewer .line-numbers-rows>span').length>=2"), "Line-number setting did not reach the rendered code gutter");
  await open();
  await session.button("Diagnostics");
  await session.click('[data-modal-top="true"] button.group');
  await session.poll("localStorage.getItem('debug')==='true' && document.body.innerText.includes('debug:change')");
  await session.button("Appearance");
  await session.click('[data-theme-id="globnotes-dark"]');
  await session.poll("document.body.classList.contains('dark') && document.body.innerText.includes('theme:change')");
  await session.button("Diagnostics");
  await session.click('[data-modal-top="true"] button.group');
  await session.poll("localStorage.getItem('debug')==='false'");
  await session.button("Plugins");
  const before = await api("/_/api/plugin-host");
  await session.click('[data-plugin-inventory] > .setting-row [role=switch]');
  await session.poll("fetch('/_/api/plugin-host').then(r=>r.json()).then(c=>c.policy.effectiveAutoEnable===false)");
  const inventoryOff = await settleSettingsInventory(session, "true");
  const off = await api("/_/api/plugin-host");
  const policyOff = JSON.parse(await Deno.readTextFile(`${state}/plugins.json`));
  assert(policyOff.autoEnable === false, "Auto-enable switch did not persist vault policy");
  assert(before.plugins.every(plugin => off.plugins.find(other => other.id === plugin.id)?.enabled === plugin.enabled), "Changing the discovery default changed existing participation");
  const command = await api("/_/api/plugins/session-guard/ping");
  assert(command.available === true, "Retained existing plugin lost its actual endpoint");
  await session.click('[data-plugin-inventory] > .setting-row [role=switch]');
  await session.poll("fetch('/_/api/plugin-host').then(r=>r.json()).then(c=>c.policy.effectiveAutoEnable===true)");
  const inventoryOn = await settleSettingsInventory(session, "true");
  const on = await api("/_/api/plugin-host");
  assert(on.policy.revision === before.policy.revision + 2, "Native policy toggles were not distinct acknowledged writes");
  await session.button("Access");
  await session.poll("!!document.querySelector('#access-everybody')");
    assert(await session.read('[data-modal-top=true]', "!!document.querySelector('.access-list [data-everybody-row] select') && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Create and add account')"), "Named Admin lost live ACL controls");
  await session.button("Account");
  await session.poll("!!document.querySelector('#account-current-password')");
    assert(await session.read('[data-modal-top=true]', "document.querySelector('[data-modal-top=true]').textContent.includes('session-fixture') && [...document.querySelector('[data-modal-top=true]').querySelectorAll('button')].some(button=>button.textContent.trim()==='Log out')"), "Named Account lost its identity or browser logout");
  await close();
  assert(!await session.evaluate("!!document.querySelector('[title=Menu]')"), "Obsolete floating Settings menu remains");
  // The Settings opener leaves its unpinned sidebar overlay open. Dismiss
  // it natively before interacting with the search controls underneath.
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width")) await session.click('[title="Close sidebar"]');
  await session.goto(`${server.baseUrl}/_/search?term=Seed`);
  await session.poll("location.pathname==='/_/search' && new URL(location.href).searchParams.get('term')==='Seed'");
  await session.poll("(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Sort By: Score' && button.getBoundingClientRect().width);button?.setAttribute('data-native-sort-opener','');return !!button;})()");
   assert(await session.read('[data-native-sort-opener]', "(()=>{const button=document.querySelector('[data-native-sort-opener]'),r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), "Search sort opener is covered by another control");
  await session.click("[data-native-sort-opener]");
  await session.poll("(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent.trim()==='Sort By: Last Modified');item?.setAttribute('data-native-sort','');return !!item;})()");
  await session.click("[data-native-sort]");
  await session.poll("new URL(location.href).searchParams.get('sortBy')==='2' && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Sort By: Last Modified')");
  return { name: "native-menu-additional-consumers", renderedLineNumberGutter: true, debugFactToasts: ["debug:change", "theme:change"], debugDisabledPersisted: true, autoEnableOffPersisted: policyOff.autoEnable, existingParticipationRetained: true, retainedEndpoint: command, finalPolicyRevision: on.policy.revision, writableAccessVisible: true, noAuthLogoutHidden: true, floatingMenuAbsent: true, nativeSearchSort: "Last Modified", searchQueryPreserved: true, inventorySettlement: [inventoryOff, inventoryOn] };
}
