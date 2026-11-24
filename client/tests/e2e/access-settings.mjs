// Native account/ACL equivalents of the retained Access fixture matrix.
// Labels remain stable for suite admission; removed v2 modes are not restored.
import { bootExtraAccessFixture as nativeAccountFixture, fixtureTotpSecret as totpSecretFromRawKey } from './access-lock-controls-native.mjs';
import { fixtureScope } from './fixture-ownership.mjs';
import { fillNativeInput, openNativeSettings, signInNative } from './settings-access-native.mjs';
import {ACCESS_SETTINGS_CASES,parseFixtureArguments} from './native-fixture-cases.mjs';
import {finalizeNativeCase} from './native-case-finalization.mjs';
import {assert} from './test-outcomes.mjs';
import {nativeSession} from './native-cdp-session.mjs';
import {exerciseLockedControls} from './access-lock-controls-native.mjs';
import {done,pending,waitUntil} from '../../../tests/helpers/wait.ts';
const options=parseFixtureArguments('access-settings',Deno.args);
if(options.help)console.log('Usage: access-settings.mjs --artifacts <directory> [--variant <fixture>]');
else await main();
async function main(){
const artifacts=options.artifacts??await Deno.makeTempDir({prefix:'access-native-'});
if(options.artifacts)await Deno.mkdir(artifacts,{recursive:!!options.variant,mode:0o700});
const selected=ACCESS_SETTINGS_CASES.filter(item=>!options.variant||item.label===options.variant),outcomes=[];
let f,failure;
const rawKey=()=>crypto.randomUUID();
const source=()=>f.session.evaluate("document.querySelector('.cm-content')?.textContent");
async function retained(text,editor) {assert(await source()===text,'Literal dirty text retained');if(editor)assert(await f.session.evaluate("document.querySelector('.cm-content')===window.nativeAccountEditor"),'Same editor retained');}
async function enrollment(action = 'Add authenticator') {
  const s=f.session,received=[];
  const release=s.page.onEvent(event=>{if(event.method==='Network.responseReceived'&&event.params.response.url.endsWith('/_/api/account/totp-enrolment'))received.push(event.params.requestId);});
  try {
    await s.button(action);await s.poll("document.querySelector('.authenticator-qr')?.naturalWidth>0");
    assert(received.length === 1, 'Expected one live enrollment receipt');
    const wire=await s.send('Network.getResponseBody',{requestId:received[0]});return JSON.parse(wire.base64Encoded?atob(wire.body):wire.body);
  } finally { release(); }
}
async function passwordForm(next='native-new-password',key) {
  await f.settings();await f.fill('#account-current-password',f.password);await f.fill('#account-new-password',next);await f.fill('#account-confirm-password',next);
  if(key)await f.fill('#account-current-code',await f.clock.code(totpSecretFromRawKey(key)));
}
async function confirmCredentials() {await f.session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('and log out?')");await f.session.button('Change and log out','[data-modal-top=true]');await f.session.poll("!!document.querySelector('#identity-login-name')");}
async function geometry(label, currentAuthenticator) {
  const rows=[];
  const s = f.session, original = await Deno.readTextFile(f.accountsFile), token = f.token;
  const text = 'Protected geometry retained editor marker';
  await f.edit(text);
  await s.evaluate("window.nativeAccountEditor=document.querySelector('.cm-content');true");
  for (const width of [1280, 360]) for (const dpr of [1, 2]) for (const theme of ['light', 'dark']) {
    await s.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1280 ? 900 : 640, deviceScaleFactor: dpr, mobile: false });
    await f.settings('core:appearance');
    await s.click(`[data-theme-id="globnotes-${theme}"]`);
    await s.poll(`document.body.classList.contains('dark')===${theme === 'dark'}`);
    await f.settings();
    await enrollment(currentAuthenticator ? 'Replace authenticator' : 'Add authenticator');
    await s.evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    const observation = await s.read(['[data-modal-top=true] [role=dialog]', '.authenticator-enrollment', '#account-dialog-current-password'], `(()=>{
      const dialog=document.querySelector('[data-modal-top=true] [role=dialog]'),r=dialog.getBoundingClientRect();
      const rect=selector=>dialog.querySelector(selector).getBoundingClientRect().toJSON();
      return {rect:r.toJSON(),overflow:dialog.scrollWidth-dialog.clientWidth,width:innerWidth,height:innerHeight,
        enrollment:rect('.authenticator-enrollment'),password:rect('#account-dialog-current-password'),
        controls:[...dialog.querySelectorAll('input,button,label[for]')].map(el=>el.getBoundingClientRect().toJSON()).filter(r=>r.width),
        labels:[...dialog.querySelectorAll('label[for]')].map(el=>[el.htmlFor,el.textContent.trim(),!!document.getElementById(el.htmlFor)]),
        inert:!!document.querySelector('[data-app-shell]')?.inert,
        editor:document.querySelector('.cm-content')===window.nativeAccountEditor};
    })()`);
    assert(observation.rect.left >= 0 && observation.rect.right <= width + .5 && observation.rect.top >= 0 && observation.rect.bottom <= observation.height + .5 && observation.overflow <= 1, `Enrollment dialog escaped ${width}/${dpr}/${theme}: ${JSON.stringify(observation)}`);
    assert(observation.password.top >= observation.enrollment.bottom - .5 && observation.controls.every(r => r.left >= observation.rect.left - .5 && r.right <= observation.rect.right + .5), 'Enrollment body overlaps proof or control escaped horizontally');
    assert(observation.labels.every(([, , resolved]) => resolved) && observation.inert && observation.editor, 'Enrollment lost labels, editor ownership or modal inertness');
    if (currentAuthenticator) {
      const labels = Object.fromEntries(observation.labels.map(([id, label]) => [id, label]));
      assert(labels['account-new-code'] === 'Code from the new authenticator' && labels['account-dialog-current-code'] === 'Current authenticator code', `Proof labels are not distinct: ${JSON.stringify(labels)}`);
    }
    for (const selector of ['#account-dialog-current-password', ...(currentAuthenticator ? ['#account-dialog-current-code'] : [])]) {
      await s.click(selector);
      assert(await s.read(selector, `(()=>{const el=document.querySelector('${selector}'),r=el.getBoundingClientRect();return document.activeElement===el&&el===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);})()`), `Native focus/hit failed at ${selector}`);
    }
    await f.capture(`${label}-${width}-${dpr}-${theme}`);
    await s.button('Cancel', '[data-modal-top=true]');
    await s.poll("!document.querySelector('.authenticator-enrollment')");
    await retained(text, true);
    assert(await Deno.readTextFile(f.accountsFile) === original && (await f.api('auth-check', 'GET', undefined, token)).status === 200, 'Geometry and cancel change no credential/session');
    rows.push({ width, dpr, theme, observation });
  }
  return rows;
}
async function plugin({state,vault}) {
  await Deno.writeTextFile(`${vault}/Background.md`,'Independent observer seed.\n');
  const root=`${state}/plugins/access-workflow`;await Deno.mkdir(root,{recursive:true});
  await Deno.writeTextFile(`${state}/plugins.json`,JSON.stringify({enabled:['access-workflow'],autoEnable:false}));
  await Deno.writeTextFile(`${root}/manifest.json`,JSON.stringify({id:'access-workflow',capabilities:{network:['127.0.0.1:9','127.0.0.1:10'],imports:false},runtime:{server:'service.js'},hooks:['on-save'],settings:[{id:'preferences',label:'Access workflow settings',renderer:{kind:'declarative-v1',version:1},fields:[{key:'message',label:'Message',type:'text',default:'retained consumer'},{key:'limit',label:'Limit',type:'number',default:5}]}]}));
  await Deno.writeTextFile(`${root}/service.js`,"const owner=crypto.randomUUID();export function activate(ctx){ctx.hooks.on('on-save',async fact=>{const data=await ctx.data.load();await ctx.data.save({count:(data.values.count??0)+1,content:fact.after?.content,message:(await ctx.settings.read()).values.preferences.message},data.revision);});ctx.commands.register({id:'report',label:'Report',target:'server'},async()=>({owner,...(await ctx.data.load()).values}));ctx.commands.register({id:'request',label:'Request',target:'server'},async()=>{const view=await ctx.permissions.status();return ctx.permissions.requestAccess({kind:'network',hosts:['127.0.0.1:10'],reason:'Native locked request fixture'},{source:view.source});});}");
}
try{
  for(const item of selected) await fixtureScope(async scope => {
    const label=item.label,directory=`${artifacts}/${label}`;await Deno.mkdir(directory);
    const fresh=label.startsWith('initial-'),key=['current-totp-password','replace-authenticator','protected-current-totp-geometry'].includes(label)?rawKey():undefined;
    f = await nativeAccountFixture(scope, directory, {
      fresh, prefix: label.includes('prefixed') ? '/notes' : '', totpKey: key,
      timed: !!key || label === 'totp-in-place',
      everybody: ['peer-policy', 'locked-controls', 'public-lock'].includes(label) ? 'edit' : 'none',
      restart: label === 'peer-policy', autoEnable: label === 'locked-controls',
      env: label === 'pinned-credentials' ? { GLOBNOTES_GLOBNOTES_ADMIN: 'native-owner' } : {},
      prepare: ['locked-controls', 'peer-policy', 'public-lock'].includes(label) ? plugin : undefined,
    });
    try {
    const s=f.session;let consumers={};
    if(fresh){
      const level='edit';
      await f.fill('#setup-login','first-owner');await f.fill('#setup-password','first-password');await s.click(`input[name=identity-everybody][value=${level}]`);await s.button('Finish setup');
      await s.poll("location.pathname.endsWith('/')&&!document.querySelector('#identity-setup-title')");
      await f.readToken();
      const status = (await f.api('auth-check')).body;
      assert((await f.api('access','PUT',{},null)).status===403,'Guest cannot administer the newly initialized vault');
      assert(status.principal.login==='first-owner'&&status.capabilities.canManageVault,'Setup hands off actual initial Admin');
      const read=await f.api('notes/Seed','GET',undefined,null);assert(read.status===200,'Public setup grants selected View/Edit');
      const write=await f.api('notes','POST',{path:'Initial',content:'initial public write'},null);assert(write.status===200 && await Deno.readTextFile(`${f.vault}/Initial.md`)==='initial public write','Selected public write reached exact disk');
      assert(!(await f.api('setup')).body.setupRequired,'Setup stays initialized');
      consumers={prefix:f.url('/'),everybody:level,initialAdmin:true,noteConsumer:true};
    }else if(label==='totp-in-place'){
      const text='Retained enrollment cancellation text';await f.edit(text);await s.evaluate("window.nativeAccountEditor=document.querySelector('.cm-content');true");await f.settings();
      const before=await Deno.readTextFile(`${f.accountsFile}`),old=f.token;
      await enrollment();await s.button('Cancel','[data-modal-top=true]');await retained(text,true);
      assert(await Deno.readTextFile(`${f.accountsFile}`)===before&&(await f.api('auth-check')).status===200,'Enrollment Cancel changes no credential/session');
      await s.click('[aria-label="Close settings"]');if(await s.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')"))await s.click('[title="Close sidebar"]');await s.button('Save','.content-column');
      await waitUntil(async()=>await Deno.readTextFile(`${f.vault}/Seed.md`)===text?done():pending(),{label:'retained enrollment note saved',intervalMs:50});
      await f.settings();const bundle=await enrollment();const code=await f.clock.code(bundle.secret);
      await f.fill('#account-new-code',code === '000000' ? '999999' : '000000');await f.fill('#account-dialog-current-password',f.password);
      await s.button('Add authenticator','[data-modal-top=true]');await s.button('Change and log out','[data-modal-top=true]');
      await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Your credentials could not be changed.')");
      assert(await Deno.readTextFile(f.accountsFile)===before && (await f.api('auth-check','GET',undefined,old)).status===200,'Wrong enrollment code does not change account bytes or session');
      await f.fill('#account-new-code',code);await f.fill('#account-dialog-current-password',f.password);await s.button('Add authenticator','[data-modal-top=true]');await confirmCredentials();
      assert((await f.api('auth-check','GET',undefined,old)).status===401,'Authenticator change revokes old token');
      await f.clock.loginCode(bundle.secret, [code], next => f.signIn(f.password, next));
      const signedIn = await f.api('auth-check');
      assert(signedIn.status===200 && signedIn.body.principal.login===f.login && (await f.api('account')).body.totpEnabled,'Confirmed authenticator persists and admits the exact account');
      consumers={enrollmentCancelNoEffects:true,literalDirtyBufferRetained:true,savedNote:true,invalidEnrollmentRetainedAccountAndSession:true,confirmedTotp:true,revocation:true,confirmedLoginAccepted:true};
    }else if(label==='protected-enrolment-geometry'||label==='protected-current-totp-geometry'){
      consumers = { geometry: await geometry(label, !!key) };
    }else if(label==='current-totp-password'||label==='lost-password-receipt'){
      const old=f.token;
      if (key) await f.clock.advanceStep();
      const before = await Deno.readTextFile(f.accountsFile);
      await passwordForm('native-new-password',key);
      const currentProof = key ? await f.clock.code(totpSecretFromRawKey(key)) : null;
      if (key) {
        await f.fill('#account-current-code', currentProof === '000000' ? '999999' : '000000');
        await s.button('Change password');
        await s.button('Change and log out','[data-modal-top=true]');
        await s.poll("document.querySelector('[data-settings-content]')?.textContent.includes('Your credentials could not be changed.')");
        assert(await Deno.readTextFile(f.accountsFile) === before && (await f.api('auth-check')).status === 200, 'Wrong current TOTP changes no credential/session');
        await f.fill('#account-current-password', f.password);
        await f.fill('#account-current-code', currentProof);
      }
      let held,patches=0;const release=s.page.onEvent(event=>{if(event.method==='Fetch.requestPaused'){held=event.params.requestId;patches++;}});
      if(label==='lost-password-receipt')await s.send('Fetch.enable',{patterns:[{urlPattern:'*/_/api/account',requestStage:'Response'}]});
      await s.button('Change password');await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('and log out?')");await s.button('Change and log out','[data-modal-top=true]');
      if(label==='lost-password-receipt'){await waitUntil(()=>held?done():pending(),{label:'credential response held',intervalMs:50});await s.send('Fetch.failRequest',{requestId:held,errorReason:'ConnectionClosed'});await s.send('Fetch.disable');assert(patches===1,'No credential replay');}
      release();await s.poll("!!document.querySelector('#identity-login-name')");assert((await f.api('auth-check','GET',undefined,old)).status===401,'Old token revoked immediately');
      assert((await f.api('token','POST',{username:f.login,password:f.password},null)).status===401,'Old password cannot authenticate');
      if (key) await f.clock.loginCode(totpSecretFromRawKey(key), [currentProof], code => f.signIn('native-new-password', code));
      else await f.signIn('native-new-password');
      assert((await f.api('auth-check')).status===200,'Normal new-method sign-in');consumers={freshProof:true,immediateRevocation:true,lostReply:!!patches,normalSignIn:true};
    }else if(label==='replace-authenticator'){
      await f.clock.advanceStep();
      await f.settings();const bundles=[];const release=s.page.onEvent(event=>{if(event.method==='Network.responseReceived'&&event.params.response.url.endsWith('/totp-enrolment'))bundles.push(event.params.requestId);});
      await s.button('Replace authenticator');await s.poll("document.querySelector('.authenticator-qr')?.naturalWidth>0");const wire=await s.send('Network.getResponseBody',{requestId:bundles.at(-1)});release();const bundle=JSON.parse(wire.base64Encoded?atob(wire.body):wire.body);
      const code = await f.clock.code(bundle.secret);
      await f.fill('#account-new-code',code);await f.fill('#account-dialog-current-password',f.password);
      await f.fill('#account-dialog-current-code',await f.clock.code(totpSecretFromRawKey(key)));
      await s.button('Replace authenticator','[data-modal-top=true]');await confirmCredentials();
      await f.clock.loginCode(bundle.secret, [code], next => f.signIn(f.password, next));
      assert((await f.api('account')).body.totpEnabled,'Replacement authenticator persisted');consumers={oldFreshProof:true,newConfirmedKey:true,normalNewKeyLogin:true};
    }else if(label==='locked-controls'){
      consumers=await exerciseLockedControls({fixture:f,capture:name=>f.capture(name)});
    }else if (label === 'public-lock') {
      const route = 'plugin-host/access-workflow/settings/preferences';
      const seeded = await f.adminApi(route, 'PUT', { values: { message: 'retained public fixture setting', limit: 5 }, revision: 0 });
      assert(seeded.status === 200, `Admin setup rejected: ${seeded.status}`);
      const report = async () => (await f.adminApi('plugin-host/access-workflow/commands/report', 'POST', {})).body.result;
      const owner = (await report()).owner;
      const guest = await nativeSession({ port: Number(Deno.env.get('CDP_PORT') ?? 9335) });
      try {
        await guest.goto(f.url('/Seed'));
        await guest.poll("document.querySelector('.toast-viewer')?.textContent.includes('Native seed.')");
        const status = await guest.evaluate("fetch('/_/api/auth-check').then(r=>r.json())");
        assert(status.principal.kind === 'guest' && status.capabilities.canEdit && !status.capabilities.canManageVault, 'Independent unsigned browser is Guest Edit, never Admin');
        const denied = await f.api(route, 'PUT', { values: { message: 'guest overwrite', limit: 5 }, revision: seeded.body.revision }, null);
        assert(denied.status === 403, `Guest settings write was not forbidden: ${denied.status}`);
        assert((await f.api('access','PUT',{},null)).status === 403, 'Guest cannot grant itself Admin');
        assert((await f.adminApi(route)).body.values.message === 'retained public fixture setting', 'Denied request did not change settings');
        await guest.button('Edit', '.content-column'); await guest.button('Source', '.content-column');
        await guest.click('.cm-content'); await guest.type('Guest note saved without Admin');
        await guest.button('Save', '.content-column');
        await waitUntil(async () => (await Deno.readTextFile(`${f.vault}/Seed.md`)).includes('Guest note saved without Admin') ? done() : pending(), { label: 'Guest native note reaches disk' });
        const independent = 'External save independent of Guest authority\n';
        await Deno.writeTextFile(`${f.vault}/Background.md`, independent);
        const runtime = await waitUntil(async () => { const value = await report(); return value.content === independent ? done(value) : pending(value); }, { label: 'independent watcher private data write' });
        const data = JSON.parse(await Deno.readTextFile(`${f.state}/plugin-data/access-workflow/data.json`));
        assert(runtime.owner === owner && runtime.message === 'retained public fixture setting' && data.values.content === independent, 'The independent workflow persisted its setting-driven private write');
        assert(guest.errors.length === 0, 'Guest page exception');
        consumers = { guestSettingsDenied: true, guestNativeSave: true, independentOwner: true, exactPrivateData: true };
      } finally { await guest.close(); }
    }else if(label==='pinned-credentials'){
      await f.settings('core:access');const view=(await f.api('access')).body,id=view.declaredAdmin.accountId;
      assert(await s.evaluate(`(()=>{const row=document.querySelector('[data-account-row="${id}"]');return row.textContent.includes('Admin, Set by server')&&!row.querySelector('select,button');})()`),'Declared Admin has no editable/removal control');
      assert(await s.evaluate(`document.querySelector('[data-settings-content]').textContent.includes(${JSON.stringify("change the server's configuration")})`),'Server-set explanation');
      await f.select('#access-everybody','view');await f.commitAccess(()=>s.button('Save access'));
      await s.poll("document.querySelector('#access-everybody')?.value===JSON.stringify('view') && ![...document.querySelectorAll('[data-settings-content] button')].some(b=>b.textContent.trim()==='Save access')");
      assert((await f.adminApi('access')).body.everybody === 'view', 'Ordinary sibling ACL change persisted');
      assert((await f.api('auth-check')).body.capabilities.canManageVault,'Server-set Admin retained');
      const text = 'Server-set Admin credential rejection retains this editor';
      await f.edit(text);await s.button('Save','.content-column');
      await waitUntil(async()=>await Deno.readTextFile(`${f.vault}/Seed.md`)===text?done():pending(),{label:'Credential-proof fixture saves exact note',intervalMs:50});
      await s.evaluate("window.nativeAccountEditor=document.querySelector('.cm-content');true");
      const credential = f.token, paths = [f.accountsFile,`${f.state}/access.json`,`${f.vault}/Seed.md`];
      const snapshot = () => Promise.all(paths.map(path=>Deno.readTextFile(path)));
      const before = JSON.stringify(await snapshot());
      const own = (await f.api('account')).body;
      await f.settings();
      const nextPassword='rejected-without-proof', wrongPassword='wrong-current-proof';
      await f.fill('#account-current-password',wrongPassword);await f.fill('#account-new-password',nextPassword);await f.fill('#account-confirm-password',nextPassword);
      await s.button('Change password');await s.button('Change and log out','[data-modal-top=true]');
      await s.poll("document.querySelector('[data-settings-content]')?.textContent.includes('Your credentials could not be changed.')");
      assert(JSON.stringify(await snapshot())===before && (await f.api('auth-check','GET',undefined,credential)).status===200,'Rejected native current proof leaves account, ACL, note and session unchanged');
      const rejected = await f.api('account','PATCH',{revision:own.credentialRevision,updateId:crypto.randomUUID(),currentPassword:wrongPassword,newPassword:nextPassword},credential);
      assert(rejected.status===401 && JSON.stringify(await snapshot())===before && (await f.api('auth-check','GET',undefined,credential)).status===200,'Direct wrong-proof mutation must not affect bytes or session');
      await retained(text,true);
      consumers={declarationStatic:true,ordinarySiblingSaved:true,adminStillEffective:true,ownCredentialControlsEditable:true,invalidCurrentProofRetainedBytesAndSession:true,directUnconfirmedWriteRejected:true,sameEditor:true};
    }else if(label==='peer-policy'){
      const report = () => f.adminApi('plugin-host/access-workflow/commands/report', 'POST', {});
      const owner = (await report()).body.result.owner;
      await f.settings('core:access');const peer=await nativeSession({port:Number(Deno.env.get('CDP_PORT')??9335)});
      try {
        assert(peer.browserContextId !== s.browserContextId, 'Peer browser has independent custody');
        await signInNative(peer, f.server, { login: f.login, password: f.password }, { returnPath: '/Seed' });
        await peer.poll("!!document.querySelector('.toast-viewer')");
        await peer.button('Edit', '.content-column'); await peer.button('Source', '.content-column');
        await peer.click('.cm-content'); await peer.type('Peer retained dirty note marker');
        await peer.poll("document.querySelector('.cm-content')?.textContent.includes('Peer retained dirty note marker') && location.hash.startsWith('#source:')");
        await peer.evaluate("window.peerEditor=document.querySelector('.cm-content');window.peerBuffer=peerEditor.textContent;window.peerUrl=location.href;true");
        await openNativeSettings(peer, 'plugin:access-workflow', 'plugin:access-workflow:preferences');
        await fillNativeInput(peer, '#settings-field-limit', '');
        const retainsPeer = async stage => {
          const note = await peer.evaluate("({sameEditor:document.querySelector('.cm-content')===window.peerEditor,sameBuffer:document.querySelector('.cm-content')?.textContent===window.peerBuffer,sameUrl:location.href===window.peerUrl})");
          assert(note.sameEditor && note.sameBuffer && note.sameUrl, `Peer retained note at ${stage}: ${JSON.stringify(note)}`);
          const snapshot = await peer.read('#settings-field-limit', "({field:document.querySelector('#settings-field-limit').value??null,sameEditor:document.querySelector('.cm-content')===window.peerEditor,sameBuffer:document.querySelector('.cm-content')?.textContent===window.peerBuffer,sameUrl:location.href===window.peerUrl})");
          await Deno.writeTextFile(`${f.directory}/peer-retention-${stage}.json`, JSON.stringify(snapshot, null, 2), { createNew: true });
          assert(snapshot.field === '' && snapshot.sameEditor && snapshot.sameBuffer && snapshot.sameUrl, `Peer retention at ${stage}: ${JSON.stringify(snapshot)}`);
        };
        await retainsPeer('before');
        await f.select('#access-everybody', 'view');
        await f.commitAccess(() => s.button('Save access'));
        assert((await f.api('notes','POST',{path:'Denied',content:'no'},null)).status===403,'New guest request sees View');
        assert((await f.api('plugin-host/access-workflow/settings/preferences','PUT',{values:{message:'guest cannot write',limit:5},revision:0},null)).status===403,'Guest cannot mutate Admin-only settings');
        await retainsPeer('acl-committed');
        assert((await report()).body.result.owner===owner,'Browser ACL changes keep independent service owner');
        const restarted=await f.server.restart(); assert(restarted.oldPid!==restarted.newPid, 'Owned backend replaced');
        assert((await f.api('access')).body.everybody==='view','ACL survives restart');
        assert(await peer.evaluate("fetch('/_/api/config').then(r=>r.json()).then(c=>c.principal.login==='native-owner'&&c.capabilities.canManageVault)"), 'Peer account remains admitted by restarted backend');consumers={peerPolicy:true,guestForbidden:true,sameBackgroundOwner:true,restartPersistence:true};
        assert((await report()).body.result.owner !== owner, 'New backend has a new service owner');
        await retainsPeer('restarted');
        assert(peer.errors.length === 0, 'Peer page exception');
        const content = 'Named peer can still write notes after restart';
        const created = await peer.evaluate(`fetch('/_/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify({path:'AfterRestart',content}))}}).then(r=>r.status)`);
        assert(created===200 && await Deno.readTextFile(`${f.vault}/AfterRestart.md`)===content,'Peer write reaches restarted backend disk');
        consumers.invalidPeerFieldAndNoteRetained = true;
      }finally{await peer.close();}
    }else{
      const cancelled=label.endsWith('-cancel'),text=`Retained ${label} text`,old=f.token;
      await f.edit(text);await s.evaluate("window.nativeAccountEditor=document.querySelector('.cm-content');true");await f.settings('core:access');
      const view=(await f.api('access')).body,id=view.named.find(row=>row.login===f.login).id;
      if (label === 'protected-public-explicit-unlocked') await f.select('#access-everybody','edit');
      await f.select(`#access-${id}`,label==='protected-public-explicit-unlocked'?'none':'edit');await s.button('Save access');
      await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')");await s.button(cancelled?'Cancel':'Save','[data-modal-top=true]');
      if(cancelled){await retained(text,true);assert((await f.api('auth-check')).body.capabilities.canManageVault,'Cancelled departure retains Admin');assert(await Deno.readTextFile(`${f.vault}/Seed.md`)==='Native seed.\n','Cancelled departure has no disk write');consumers={cancelKeepsIdentityAndText:true,noDiskEffect:true};}
       else{await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Remove your Admin access?')");await f.commitAccess(()=>s.button(label==='protected-public-explicit-unlocked'?'Change my access to No access':'Change my access to Edit','[data-modal-top=true]'));
        await s.poll("!document.querySelector('[data-modal-top=true]')?.textContent.includes('Remove your Admin access?')");assert(await Deno.readTextFile(`${f.vault}/Seed.md`)===text,'Departure Save reaches actual disk before demotion');
        const status=await f.api('auth-check','GET',undefined,old);assert(status.status===200&&!status.body.capabilities.canManageVault,'Same JWT survives ACL self-demotion without Admin');
        if (label === 'protected-public-explicit-unlocked') {
          const guest = await f.api('auth-check','GET',undefined,null);
          assert(guest.body.principal.kind==='guest' && guest.body.capabilities.canEdit && !guest.body.capabilities.canManageVault, 'Guest Edit, not Admin');
          const content='Guest still writes after access update\n';
          assert((await f.api('notes','POST',{path:'GuestAfterAccess',content},null)).status===200 && await Deno.readTextFile(`${f.vault}/GuestAfterAccess.md`)===content, 'Guest write reached disk');
          assert((await f.api('access','PUT',{},null)).status===403,'Guest cannot manage access');
        }
        assert((await f.api('access','GET',undefined,old)).status===403,'Demoted user gets no ACL');
        assert((await f.api('account','GET',undefined,old)).status===200,'Own account remains reachable');consumers={saveBeforeDemotion:true,ordinaryForbidden:true,ownAccountReachable:true};}
    }
    await f.capture('accepted-state');assert(!s.errors.length,'No native page exceptions');await Deno.writeTextFile(`${directory}/consumers.json`,JSON.stringify({name:label,...consumers,pageErrors:s.errors},null,2));
    outcomes.push({name:label,passed:true});
    } catch (error) {
      await finalizeNativeCase({ error, report: async () => {
        await f.capture('failure').catch(()=>{});
        await Deno.writeTextFile(`${artifacts}/failure.json`,JSON.stringify({error:String(error),page:await f.session.evaluate('({url:location.href,body:document.body.innerText})').catch(()=>null)},null,2));
      } });
      throw error;
    }
  });
  assert(outcomes.length===selected.length,'Complete retained Access matrix');
}catch(error){failure=error;}
finally{await finalizeNativeCase({error:failure,report:()=>Deno.writeTextFile(`${artifacts}/diagnostics.json`,JSON.stringify({outcomes,failure:failure?.message},null,2))});}
if(failure)throw failure;
}
