// An Edit browser never borrows its independent Admin auditor's authority.
import {done,pending,waitUntil} from '../../../tests/helpers/wait.ts';
import { bootServer, nativeFixtureAdmin } from './harness-helpers.mjs';
import { bootServer as launchFresh } from '../../../tests/helpers/boot.ts';
import { applicationServer } from './http-origin.mjs';
import { nativeAccountScenario, nativeFixtureInput } from './config-fixture.mjs';
import { storedScenario } from '../../../tests/helpers/fixture_scenarios.ts';
import { createSettingsRestartFixture } from './settings-restart-fixture.mjs';
import { createNativeTotpClock } from './native-totp-fixture.mjs';
import { nativeSession } from './native-cdp-session.mjs';
import { encodeBase32 } from '@std/encoding/base32';
import { commitNativeAccess, fillNativeInput, openNativeSettings, selectAccessLevel, signInNative, tokenExpression } from './settings-access-native.mjs';

// Password-only observer signs in via nativeFixtureAdmin; Chromium uses only
// credentials it acquired at the visible form. Keep the observer Admin even
// when the subject demotes themselves.
export const fixtureTotpSecret = key => encodeBase32(new TextEncoder().encode(key)).replace(/=+$/, '');
export async function bootExtraAccessFixture(scope, directory, {
  fresh = false, prefix = '', everybody = 'none', totpKey, timed = !!totpKey,
  prepare, env = {}, restart = false, autoEnable = false,
} = {}) {
    const vault = `${directory}/vault`, metadata = `${directory}/state`, state = `${metadata}/globnotes`;
    await Deno.mkdir(vault, { recursive: true });
    await Deno.mkdir(state, { recursive: true });
    await Deno.writeTextFile(`${vault}/Seed.md`, 'Native seed.\n');
    const login = 'native-owner', password = 'native-password';
    const account = { login, password, ...(totpKey ? { totpKey } : {}) };
    const scenario = nativeAccountScenario({ account, everybody });
    scenario.identity.people.unshift({ login: 'access-auditor', password: 'native-auditor-password' });
    scenario.identity.grants['access-auditor'] = 'admin';
    const { fixtureScenario } = await nativeFixtureInput(scenario);
    const clock = timed ? (await scope.acquire(() => createNativeTotpClock(directory), value => value.close())).value : null;
    await prepare?.({ state, vault });
    const environment = { GLOBNOTES__SERVER_PATHPREFIX: prefix, ...(!autoEnable ? { GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: 'false' } : {}), ...env };
    const owner = (await scope.acquire(() => fresh
      ? launchFresh({ ...environment, GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES__METADATA_PATH: metadata }, applicationServer())
      : bootServer(vault, state, { fixtureScenario, env: environment, logsDir: directory, denoArgs: clock?.denoArgs }), value => value.close())).value;
    const server = restart ? (await scope.acquire(() => createSettingsRestartFixture({ initialServer: owner, directory, launch: async count => {
      const logsDir = `${directory}/backend-${count}`;
      await Deno.mkdir(logsDir);
      return await bootServer(vault, state, { fixtureScenario: storedScenario(fixtureScenario), env: environment, logsDir, denoArgs: clock?.denoArgs });
    } }), value => value.close())).value : owner;
    const admin = fresh ? null : await nativeFixtureAdmin(owner);
    const session = (await scope.acquire(() => nativeSession({ port: Number(Deno.env.get('CDP_PORT') ?? 9335) }), value => value.close())).value;
    const url = path => `${server.baseUrl}${prefix}${path}`;
    let token = null;
    const api = async (route, method = 'GET', body, credential = token) => {
      const response = await fetch(url(`/_/api/${route}`), {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      return { status: response.status, body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    };
    async function signIn(secret = password, totp, returnPath = '/Seed') {
      ({ token } = await signInNative(session, server, { login, password: secret, totp }, { prefix, returnPath }));
    }
    await session.goto(url(fresh ? '/' : '/Seed'));
    if (fresh) await session.poll("!!document.querySelector('#setup-login')");
    else {
      if (totpKey) await clock.loginCode(fixtureTotpSecret(totpKey), [], code => signIn(password, code));
      else await signIn();
      await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('Native seed.')");
    }
    async function edit(text) {
      if (await session.evaluate("!!document.querySelector('#settings-modal-title')")) await session.click('[aria-label="Close settings"]');
      if (await session.evaluate("document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width>0")) await session.click('[title="Close sidebar"]');
      if (!await session.evaluate("!!document.querySelector('.cm-content[contenteditable=true]')")) {
        await session.button('Edit', '.content-column');
        await session.button('Source', '.content-column');
      }
      await fillNativeInputEditor(session, text);
    }
    return { vault, state, accountsFile: `${metadata}/_/accounts.json`, directory, clock, session, server, url, login, password, api, signIn, edit,
      get token() { return token; },
      async readToken() { token = await session.evaluate(tokenExpression(prefix)); return token; },
      adminApi: (route, method, body) => api(route, method, body, admin.token),
      settings: (id = 'core:account') => openNativeSettings(session, id),
      fill: (selector, value) => fillNativeInput(session, selector, value),
      select: (selector, value) => selectAccessLevel(session, selector, value),
      commitAccess: action => commitNativeAccess(session, url('/_/api/access'), action),
      async capture(label) {
        const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
        await Deno.writeFile(`${directory}/${label}.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)));
      },
    };
}

async function fillNativeInputEditor(session, text) {
  await session.click('.cm-content[contenteditable=true]');
  await session.key('a', { modifiers: 2, code: 'KeyA', windowsVirtualKeyCode: 65 });
  await session.type(text);
  await session.poll(`[...document.querySelectorAll('.cm-content .cm-line')].map(line=>line.textContent).join('\\n')===${JSON.stringify(text)}`);
  await session.poll("(()=>{const line=document.querySelector('.cm-activeLineGutter')?.textContent.trim();return !!line&&location.hash==='#source:L'+line;})()");
}
export async function exerciseLockedControls({fixture:f,capture}) {
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const {session:s,state,vault}=f,id='access-workflow',settingsRoute=`plugin-host/${id}/settings/preferences`;
  const audit = f.adminApi;
  const seeded=await audit(settingsRoute,'PUT',{values:{message:'locked retained settings consumer',limit:5},revision:0});assert(seeded.status===200,'Settings seeded');
  const requested=(await audit(`plugin-host/${id}/permissions`)).body,remembered=requested.requestedNetwork.find(scope=>scope.authority==='127.0.0.1:9');
  assert(remembered&&requested.requestedNetwork.length===2,'Two real inert requested hosts');
  const approved=await audit(`plugin-host/${id}/permissions`,'PUT',{revision:requested.revision,signature:requested.signature,requestSourceKey:requested.requestSourceKey,requestSourceRevision:requested.requestSourceRevision,allowNetwork:false,approvedNetwork:[remembered],approvedImports:[]});assert(approved.status===200&&!approved.body.view.allowNetwork,'Master-off remembered approval');
  const owner=(await audit(`plugin-host/${id}/commands/report`,'POST',{})).body.result.owner;
  await f.settings('core:access');const view=(await audit('access')).body,self=view.named.find(row=>row.login===f.login).id;
   await f.select(`#access-${self}`,'edit');await s.button('Save access');await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Remove your Admin access?')");await f.commitAccess(()=>s.button('Change my access to Edit','[data-modal-top=true]'));
  const demoted = await f.api('auth-check');
  assert(demoted.status===200 && demoted.body.capabilities.canEdit && !demoted.body.capabilities.canManageVault,'Browser has Edit, no Admin');
  await Deno.writeTextFile(`${f.directory}/demoted-auth-check.json`, JSON.stringify(demoted, null, 2), { createNew: true });
  await s.poll("!document.querySelector('[data-settings-nav-id=\"core:access\"]')");
  const files=['access.json','plugins.json',`plugin-data/${id}/settings.json`,`plugin-network/${id}.json`];
  const writes=[],stop=s.page.onEvent(event=>{if(event.method==='Network.requestWillBeSent'&&event.params.request.method!=='GET'&&/\/_\/api\/(brand|access|setup|plugin-host\/(policy|[^/]+\/(enabled|settings|permissions|permission-requests)))/.test(event.params.request.url))writes.push(event.params.request.url);});
  assert(await s.evaluate("!document.querySelector('[data-settings-nav-id=\"core:branding\"],[data-settings-nav-id=\"core:plugins\"],[data-settings-nav-id=\"plugin:access-workflow\"]')"),'Private admin pages are not projected to Edit');
  await capture('locked-admin-controls');
  const publication=await audit(`plugin-host/${id}/commands/request`,'POST',{});assert(publication.status===200&&publication.body.result.requestId,'Independent Worker request publication');
  const requestId=publication.body.result.requestId,permission=(await audit(`plugin-host/${id}/permissions`)).body,catalog=(await audit('plugin-host')).body;
  // The Admin's request publication legitimately updates this ledger. Capture
  // its bytes after that admitted work, before all denied/personal actions.
  const bytes=Object.fromEntries(await Promise.all(files.map(async file=>[file,await Deno.readTextFile(`${state}/${file}`)])));
  const controls={revision:permission.revision,signature:permission.signature,requestSourceKey:permission.requestSourceKey,requestSourceRevision:permission.requestSourceRevision,allowNetwork:true,approvedNetwork:permission.requestedNetwork,approvedImports:[]};
  const rejected=[];
  for(const [route,method,body] of [['plugin-host/policy','PUT',{autoEnable:true,revision:catalog.policy.revision,signature:catalog.policy.signature}],[`plugin-host/${id}/enabled`,'PUT',{enabled:false,revision:catalog.policy.revision,signature:catalog.policy.signature}],[settingsRoute,'PUT',{values:{message:'blocked direct settings',limit:5},revision:seeded.body.revision}],[`plugin-host/${id}/permissions`,'PUT',controls],[`plugin-host/${id}/permission-requests/${requestId}/decision`,'POST',{...controls,decision:'approve'}],['access','PUT',{everybody:'edit',grants:view.grants,revision:view.revision,signature:view.signature,updateId:crypto.randomUUID()}]]){assert((await f.api(route,method,body)).status===403,`Edit denied ${route}`);rejected.push(route);}
  for(const route of [settingsRoute,`plugin-host/${id}/permissions`,'access'])assert((await f.api(route)).status===403,`Private read denied ${route}`);
  const reader=(await f.api('plugin-host')).body;assert(Object.keys(reader.policy).join()==='revision'&&!JSON.stringify(reader).includes('locked retained settings consumer'),'Reader catalog excludes administrative policy/settings');
  const form=new FormData();form.append('name','blocked direct branding');const brand=await fetch(f.url('/_/api/brand'),{method:'POST',headers:{authorization:`Bearer ${f.token}`},body:form});assert(brand.status===403,'Direct brand denied');await brand.body?.cancel();
  assert(!await s.evaluate("!!document.querySelector('#permission-request-title')"),'No Admin permission request disclosure to Edit');
  assert((await audit('plugin-host/permission-requests')).body.some(row=>row.id===requestId&&row.state==='pending'),'Request stays pending');
  await f.settings('core:appearance');await s.click('[data-theme-id="globnotes-dark"]');await s.poll("localStorage.getItem('globnotes-theme')==='globnotes-dark'&&document.body.classList.contains('dark')");
  await s.button('Editor');await s.click('[data-modal-top=true] button.group');await s.poll("localStorage.getItem('viewLineNumbers')==='true'");
  await s.button('Diagnostics');await s.click('[data-modal-top=true] button.group');await s.poll("localStorage.getItem('debug')==='true'&&document.body.innerText.includes('debug:change')");
  await s.button('Keybindings');await s.button('Custom');await s.click('[data-command-binding="app:open-settings"] button');await s.key('g',{code:'KeyG',modifiers:3,windowsVirtualKeyCode:71});await s.poll("document.querySelector('[data-command-binding=\"app:open-settings\"]')?.textContent.includes('Ctrl+Alt+G')");
  const text='Locked controls public note consumer\n';await f.edit(text);await s.button('Save','.content-column');
  await waitUntil(async()=>await Deno.readTextFile(`${vault}/Seed.md`)===text?done():pending(),{label:'Edit note reaches disk',intervalMs:50});
  // Both committed saves publish host-owned facts, not viewer invocations.
  async function persistedHook(content, label) {
    const report=await waitUntil(async()=>{const value=(await audit(`plugin-host/${id}/commands/report`,'POST',{})).body.result;return value.content===content?done(value):pending(value);},{label,intervalMs:50});
    assert(report.owner===owner&&report.message==='locked retained settings consumer','Same background owner consumes retained settings');
    const {values}=JSON.parse(await Deno.readTextFile(`${state}/plugin-data/${id}/data.json`));
    assert(values.content===content&&values.message===report.message,'Private data persisted with retained settings');
  }
  await persistedHook(text,'Edit browser save reaches plugin private data');
  const external='Locked controls external note consumer\n';
  await Deno.writeTextFile(`${vault}/Background.md`,external);
  await persistedHook(external,'External save independently reaches plugin private data');
  const sourceUrl=await s.evaluate('location.href');await s.send('Page.reload');await s.poll("document.readyState==='complete'&&document.querySelector('.cm-content')?.textContent.includes('Locked controls public note consumer')");
  assert(await s.evaluate(`location.href===${JSON.stringify(sourceUrl)}&&localStorage.getItem('globnotes-theme')==='globnotes-dark'&&localStorage.getItem('viewLineNumbers')==='true'&&localStorage.getItem('debug')==='true'&&localStorage.getItem('globnotes-keybindings')==='custom'&&JSON.parse(localStorage.getItem('globnotes-keybindings-custom'))['app:open-settings'].other==='Ctrl+Alt+G'`),'Personal preferences and Source URL survive reload');
  await s.key('g',{code:'KeyG',modifiers:3,windowsVirtualKeyCode:71});await s.poll("!!document.querySelector('#settings-modal-title')");
  for(const file of files)assert(await Deno.readTextFile(`${state}/${file}`)===bytes[file],`Denied/personal actions preserve ${file}`);
  assert(writes.length===0,'UI/personal preferences send no administrative mutation');stop();
  return {realCoveredApisDenied:rejected,privateAdminProjectionDenied:true,realConfigPolicySettingsBytesRetained:true,actualPermissionLedgerRetained:true,requestPublishedWhileLocked:true,readonlyRequestStillPending:true,disabledUiMutationRequests:writes,localThemeRemapLineNumbersDebugConsumedAndReloaded:true,publicNoteApiAndDiskConsumer:true,editSaveHookPrivateDataPersisted:true,sameWorkflowOwner:true,independentExternalSaveHook:true,settingsDrivenHookAndPrivateDataConsumer:true};
}
