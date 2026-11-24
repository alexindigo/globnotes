// Real plain-HTTP clipboard and retained ACL uncertainty/CAS/read-error consumers.
import { showSidebar } from './sidebar-navigation-native.mjs';
import { bootExtraAccessFixture as nativeAccountFixture } from './access-lock-controls-native.mjs';
import { finalizeNativeCase } from './native-case-finalization.mjs';
import { fixtureScope } from './fixture-ownership.mjs';
import {captureClipboard,closeClipboardWitness,prepareClipboardWitness,readClipboardText,restoreClipboard,writeClipboardText} from './native-clipboard.mjs';
import {parseArguments} from './harness-helpers.mjs';
import {done,pending,waitUntil} from '../../../tests/helpers/wait.ts';
const options=parseArguments(Deno.args);
if(options.help)console.log('Usage: access-extra-states.mjs --artifacts <directory>');
else await main();
async function main(){
if(!options.artifacts)throw Error('--artifacts required');
const artifacts=options.artifacts;await Deno.mkdir(artifacts,{mode:0o700});
const assert=(value,message)=>{if(!value)throw Error(message);};
const outcomes=[];let f,label,failure,writes;
const wait=(fn,name)=>waitUntil(async()=>await fn()?done():pending(),{label:name,intervalMs:25});
async function fixture(name,narrow,run){
  await fixtureScope(async scope => {
  label=name;const directory=`${artifacts}/${name}`;await Deno.mkdir(directory);
  f=await nativeAccountFixture(scope,directory,{everybody:'edit'});writes=[];
  scope.defer(()=>closeClipboardWitness(f.session));
  try {
  const s=f.session;if(narrow)await s.send('Emulation.setDeviceMetricsOverride',{width:360,height:640,deviceScaleFactor:2,mobile:false});
  await f.edit(`Retained ${name} buffer`);await s.evaluate("window.extraEditor=document.querySelector('.cm-content');window.extraBuffer=window.extraEditor.textContent;window.extraUrl=location.href;true");
  s.page.onEvent(event=>{if(event.method==='Network.requestWillBeSent'&&event.params.request.method==='PUT'&&new URL(event.params.request.url).pathname==='/_/api/access')writes.push(event.params.requestId);});
  await run();
  } catch(error) {
    await finalizeNativeCase({error,report:async()=>{await f.capture('failure').catch(()=>{});await Deno.writeTextFile(`${artifacts}/failure.json`,JSON.stringify({error:String(error),label,writes,page:await f.session.evaluate('({url:location.href,body:document.body.innerText})').catch(()=>null)},null,2));}});
    throw error;
  }
  });
}
async function retained(){assert(await f.session.evaluate("document.querySelector('.cm-content')===window.extraEditor&&document.querySelector('.cm-content').textContent===window.extraBuffer&&location.href===window.extraUrl"),'Literal dirty editor and URL retained');}
async function finish(consumers){assert(!f.session.errors.length,'No page errors');await f.capture('accepted-state');await Deno.writeTextFile(`${artifacts}/${label}/consumers.json`,JSON.stringify({name:label,...consumers,writes:writes.length},null,2));outcomes.push({name:label,passed:true});}
try{
  for(const granted of [true,false]){
    await fixture(granted?'clipboard-success':'clipboard-denied',!granted,async()=>{const s=f.session;
    await prepareClipboardWitness(s);await f.settings();const before=await Deno.readTextFile(f.accountsFile);
    assert(await s.evaluate('!isSecureContext&&navigator.clipboard===undefined'),'Normal insecure HTTP copy fallback');
    const prior=await captureClipboard(s),marker=`before-${label}`;await writeClipboardText(s,marker);
    if(!granted)await s.evaluate("(()=>{const native=document.execCommand;document.execCommand=function(command,...rest){return command==='copy'?false:native.call(this,command,...rest);};return true;})()");
    const bundles=[];s.page.onEvent(event=>{if(event.method==='Network.responseReceived'&&event.params.response.url.endsWith('/account/totp-enrolment'))bundles.push(event.params.requestId);});
    await s.button('Add authenticator');await s.poll("document.querySelector('.authenticator-qr')?.naturalWidth>0");assert(bundles.length===1,'One actual enrollment');
    const wire=await s.send('Network.getResponseBody',{requestId:bundles[0]}),bundle=JSON.parse(wire.base64Encoded?atob(wire.body):wire.body);
    await s.button('Copy setup key');await s.poll(`document.querySelector('.authenticator-enrollment')?.textContent.includes(${JSON.stringify(granted?'Setup key copied.':'Could not copy the setup key. Please try again.')})`);
    assert(await readClipboardText(s)===(granted?bundle.secret:marker),'Real clipboard matches copy capability');
    await f.fill('#account-dialog-current-password','still-owned-password');await s.poll("document.activeElement===document.querySelector('#account-dialog-current-password')");
    await retained();assert(await Deno.readTextFile(f.accountsFile)===before&&(await f.api('auth-check')).status===200,'Copy never changes credentials/session');
    await restoreClipboard(s,prior);await finish({nativeCopyAction:true,actualClipboardMatchesBundle:granted,refusedCopyLeftClipboardUnchanged:!granted,regularHttpOrigin:true,followingFieldFocusable:true,configAndSessionUnchanged:true,literalDirtyBufferRetained:true,priorClipboardRestored:true});
    });
  }
  for(const lost of [false,true]){
    await fixture(lost?'lost-receipt-review':'unknown-held-wire',lost,async()=>{await f.settings('core:access');const s=f.session,gate={held:null};
    s.page.onEvent(event=>{if(event.method==='Fetch.requestPaused'){if(event.params.request.method==='PUT')gate.held=event.params;else s.send('Fetch.continueRequest',{requestId:event.params.requestId}).catch(()=>{});}});
    await s.send('Fetch.enable',{patterns:[{urlPattern:'*/_/api/access',requestStage:'Response'}]});
    await f.select('#access-everybody','view');await s.button('Save access');
    await s.button('Save','[data-modal-top=true]');
    await wait(()=>gate.held,'actual ACL response held');assert(gate.held.responseStatusCode===200,'ACL really committed');
    const saved=JSON.parse(await Deno.readTextFile(`${f.state}/access.json`));assert(saved.everybody==='view'&&saved.updateId,'Committed ACL and receipt bytes');
    if(lost)await s.send('Fetch.failRequest',{requestId:gate.held.requestId,errorReason:'ConnectionClosed'});
    await s.poll("document.querySelector('[data-settings-content]')?.textContent.includes('Review current access')");await retained();await f.capture('unknown-state');assert(writes.length===1,'No automatic ACL replay');
    if(lost){await s.poll("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Review current access')?.disabled===false");await s.button('Review current access');}
    else {
      const review = await s.evaluate("(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Review current access');return button&&{disabled:button.disabled,text:button.textContent.trim()};})()");
      await Deno.writeTextFile(`${f.directory}/held-wire.json`, JSON.stringify({ method: gate.held.request.method, status: gate.held.responseStatusCode, updateId: saved.updateId, writes: writes.length, review }, null, 2), { createNew: true });
      assert(!review || review.disabled, 'Held wire cannot review');
      await s.click('[aria-label="Close settings"]');assert(await s.evaluate("!!document.querySelector('#settings-modal-title')"),'Unknown wire blocks departure');await s.send('Fetch.continueRequest',{requestId:gate.held.requestId});
    }
    await s.poll("document.querySelector('#access-everybody')?.value===JSON.stringify('view')&&![...document.querySelectorAll('[data-settings-content] button')].some(button=>['Save access','Review current access'].includes(button.textContent.trim()))");
    if(await s.evaluate("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')"))await s.button('Keep editing','[data-modal-top=true]');
    await s.send('Fetch.disable');await retained();
    assert((await f.api('notes','POST',{path:'Denied',content:'no'},null)).status===403&&writes.length===1,'Actual guest View policy without replay');
    assert(await Deno.readTextFile(`${f.vault}/Seed.md`)===`Retained ${label} buffer`,'Departure Save wrote the literal retained text');await finish({actualCommittedAclAndReceipt:true,unknownStateRendered:true,retainedOwnerAndBuffer:true,replayedWrites:0,explicitReview:lost,actualGuestViewConsumer:true});
    });
  }
  await fixture('stale-cas',true,async()=>{await f.settings('core:access');await f.select('#access-everybody','none');const view=(await f.adminApi('access')).body;
  assert((await f.adminApi('access','PUT',{everybody:'view',grants:view.grants,revision:view.revision,signature:view.signature,updateId:crypto.randomUUID()})).status===200,'Concurrent real writer');
  await f.session.button('Save access');await f.session.button('Save','[data-modal-top=true]');
  await f.session.poll("document.querySelector('[data-settings-content]')?.textContent.includes('Access was not saved.')");await retained();
  assert(await f.session.evaluate("(()=>{const select=document.querySelector('#access-everybody');return select?select.value===JSON.stringify('none'):document.querySelector('[data-everybody-row]')?.textContent.includes('No access');})()")&&(await f.api('access')).body.everybody==='view','Stale choice retained, concurrent bytes preserved');await finish({actualStaleMutationRejected:true,currentChoicesRetained:true,editorBufferRetained:true,concurrentPolicyRetained:true});
  });
  await fixture('load-error',false,async()=>{const s=f.session,before=await Deno.readTextFile(`${f.state}/access.json`);
  s.page.onEvent(event=>{if(event.method==='Fetch.requestPaused')s.send('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:503,responseHeaders:[{name:'content-type',value:'application/json'}],body:btoa(JSON.stringify({detail:'Fixture access read unavailable'}))}).catch(()=>{});});
  await s.send('Fetch.enable',{patterns:[{urlPattern:'*/_/api/access',requestStage:'Response'}]});
  await showSidebar(s);await s.click('[aria-label=Settings]');await s.click('[data-settings-nav-id="core:access"]');
  await s.poll("document.querySelector('[data-settings-content]')?.textContent.includes('Fixture access read unavailable')");assert(!await s.evaluate("[...document.querySelectorAll('[data-settings-content] button')].some(el=>el.textContent.trim()==='Save access')"),'No submit after failed load');await retained();assert(await Deno.readTextFile(`${f.state}/access.json`)===before,'Read failure no write');await s.send('Fetch.disable');await s.click('[aria-label="Close settings"]');await retained();await finish({realReadResponseFailureRendered:true,submitUnavailable:true,configurationUnchanged:true,literalDirtyBufferRetained:true});
  });
  assert(outcomes.length===6,'All six retained consumers');
}catch(error){failure=error;}
finally { await finalizeNativeCase({ error: failure, report: () => Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({outcomes,failure:failure?.message},null,2)) }); }
if(failure)throw failure;
}
