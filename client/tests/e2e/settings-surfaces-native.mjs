// Feature-owned complete Settings surface matrix. Ordinary HTTP; no test hooks in views.
import { nativeSession } from './native-cdp-session.mjs';
import { showSidebar } from './sidebar-navigation-native.mjs';
import { createServerWorkingDirectory } from '../../../tests/helpers/boot.ts';
import { awaitHealthy, bootServer, nativeFixtureAdmin } from './harness-helpers.mjs';
import { applicationServer, assertHttpTestUrl } from './http-origin.mjs';
import { nativeAccountScenario, nativeFixtureInput } from "./config-fixture.mjs";
import { signInNative, tokenExpression } from "./settings-access-native.mjs";
import { assertSettingsActionHierarchy, assertSettingsHeaderRuleEdge, assertSettingsHeaderGeometry, assertSettingRowAlignment, assertSettingsVisualLanes, assertSettingsPaneEdges, assertSettingsProseMeasure, assertSettingsUiRules } from './settings-frame-native.mjs';
import { assertSettingsActionZones } from './settings-primitives-native.mjs';

const assert=(value,message)=>{if(!value)throw Error(message);};
const cells=[];
for(const width of [320,360,768,1280])for(const dpr of [1,2])for(const mode of ['light','dark'])cells.push({width,height:width<640?640:900,dpr,mode,textScale:1});
for(const mode of ['light','dark'])cells.push({width:360,height:640,dpr:1,mode,textScale:2});
import { fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('../../..',import.meta.url)).replace(/\/$/,'');

// Account credentials occupy paired columns; retained facts span the full pane.
async function assertAccountPaneGeometry(session){
  const headerGeometry=await assertSettingsHeaderGeometry(session);
  const value=await session.read('[data-settings-content] form',`(()=>{
    const pane=document.querySelector('[data-settings-content]'),page=pane.querySelector('[data-settings-page]'),form=page.querySelector('form');
    const content=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),right:r.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight)-(el.offsetWidth-el.clientWidth-parseFloat(s.borderLeftWidth)-parseFloat(s.borderRightWidth))};};
    const paneBox=content(pane),pageBox=content(page);
    const rows=[...page.querySelectorAll('.setting-row')].filter(row=>!form.contains(row)).map(row=>({label:row.querySelector('.setting-row-label').textContent.trim(),left:row.getBoundingClientRect().left,right:row.getBoundingClientRect().right}));
    const fields=[...form.querySelectorAll('input')].map(input=>{const control=input.closest('.password-field')??input,r=control.getBoundingClientRect(),box=control.parentElement.getBoundingClientRect(),label=page.querySelector('label[for="'+input.id+'"]');return {id:input.id,left:r.left,right:r.right,width:r.width,laneLeft:box.left,laneRight:box.right,label:!!label,visible:!!r.width};});
    return {viewport:innerWidth,paneLeft:paneBox.left,paneRight:paneBox.right,pageLeft:pageBox.left,pageRight:pageBox.right,rows,fields,overflow:page.scrollWidth-page.clientWidth};
  })()`);
  if(Math.abs(value.pageLeft-value.paneLeft)>.5||Math.abs(value.pageRight-value.paneRight)>.5||value.rows.length!==2||value.rows.some(row=>Math.abs(row.left-value.paneLeft)>.5||Math.abs(row.right-value.paneRight)>.5)||value.fields.length<3||value.fields.some(field=>!field.label||!field.visible||Math.abs(field.left-field.laneLeft)>.5||Math.abs(field.right-field.laneRight)>.5||field.left<value.paneLeft-.5||field.right>value.paneRight+.5)||value.overflow>1)throw Error('Account form lanes: '+JSON.stringify(value));
  return {...value,headerGeometry};
}

async function assertAccessPaneGeometry(session){
  const headerGeometry=await assertSettingsHeaderGeometry(session);
  const value=await session.read('.access-list',`(()=>{
    const pane=document.querySelector('[data-settings-content]'),page=pane.querySelector('[data-settings-page]'),list=page.querySelector('.access-list');
    const content=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),right:r.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight)-(el.offsetWidth-el.clientWidth-parseFloat(s.borderLeftWidth)-parseFloat(s.borderRightWidth))};};
    const p=content(pane),q=content(page);return {viewport:innerWidth,paneLeft:p.left,paneRight:p.right,pageLeft:q.left,pageRight:q.right,overflow:page.scrollWidth-page.clientWidth,rows:[...list.querySelectorAll('.access-row')].map(row=>{const r=row.getBoundingClientRect(),field=row.querySelector('.setting-row'),f=field.getBoundingClientRect(),s=row.querySelector('select'),c=s?.getBoundingClientRect();return {left:r.left,right:r.right,label:field.querySelector('.setting-row-label').textContent.trim(),contained:f.left>=r.left&&f.right<=r.right,selectContained:!c||c.left>=f.left&&c.right<=f.right,everybody:row.hasAttribute('data-everybody-row'),levels:s?[...s.options].map(option=>JSON.parse(option.value)):[]};})};
  })()`);
  if(Math.abs(value.pageLeft-value.paneLeft)>.5||Math.abs(value.pageRight-value.paneRight)>.5||value.rows.length<2||value.rows.some(row=>Math.abs(row.left-value.paneLeft)>.5||Math.abs(row.right-value.paneRight)>.5||!row.contained||!row.selectContained)||!value.rows.at(-1).everybody||value.rows.at(-1).levels.includes('admin')||value.overflow>1)throw Error('Access list lanes: '+JSON.stringify(value));
  return {...value,headerGeometry};
}

export async function exerciseSettingsSurfaces({port,directory,matrix=cells,fixtures=['main','protected','first-run']}) {
  await Deno.mkdir(directory);
  const observations=[],owners=[];
  const actor = { login: "surface-user", password: "surface-password" };
  let session,server,adminHeaders,failure;
  const inspect=expression=>session.evaluate(expression);
  const settled=()=>inspect('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  async function replace(selector,value){await session.click(selector);await session.key('a',{code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});if(value)await session.type(value);else await session.key('Backspace',{windowsVirtualKeyCode:8});}
  async function open(){if(await inspect("!!document.querySelector('#settings-modal-title')"))return;await showSidebar(session);await session.click('[aria-label=Settings]');await session.poll("!!document.querySelector('#settings-modal-title')");}
  async function nav(id){await session.click(`[data-settings-nav-id="${id}"]`);await session.poll(`document.querySelector('[data-settings-content]')?.dataset.settingsCurrentPage===${JSON.stringify(id==='plugin:globnotes-backup'?'plugin:globnotes-backup:backup':id)}`);}
  async function probe(name,cell){
    if(name==='backups')await session.poll("(()=>{const input=document.querySelector('#settings-field-basePath');return !!input&&!input.readOnly&&!!input.parentElement.querySelector('button');})()");
    await settled();
    if(await inspect("!!document.querySelector('#settings-modal-title')")){await assertSettingsActionHierarchy(session);await assertSettingRowAlignment(session);await assertSettingsVisualLanes(session);}
    if(await inspect("!!document.querySelector('#settings-modal-title')")){await assertSettingsHeaderRuleEdge(session);await assertSettingsUiRules(session);}
      const result=await session.read(name==='account-setup-first-run'?'form':'[role=dialog]', `(()=>{const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(el=>el.getBoundingClientRect().width);const owners=new Set([document.documentElement,...dialogs]);for(const dialog of dialogs)for(const el of dialog.querySelectorAll('*')){const s=getComputedStyle(el);if(el.getBoundingClientRect().width&&(/auto|scroll/.test(s.overflowX)||/auto|scroll/.test(s.overflowY)))owners.add(el);}return {origin:location.origin,secure:isSecureContext,fontSize:parseFloat(getComputedStyle(document.documentElement).fontSize),owners:[...owners].map(el=>({name:el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.className,overflow:el.scrollWidth-el.clientWidth})),dialogRects:dialogs.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};})()`);
    assertHttpTestUrl(result.origin);
    assert(result.secure===false,'Surface matrix origin');
    assert(result.fontSize===16*cell.textScale,`Text scaling not applied: ${JSON.stringify(result)}`);
    if(['account','signed-in-account','access','editor','keybindings','plugins-collapsed','plugins-expanded','plugins-expanded-request'].includes(name))result.paneEdges=['account','signed-in-account'].includes(name)?await assertAccountPaneGeometry(session):name==='access'?await assertAccessPaneGeometry(session):await assertSettingsPaneEdges(session);
    if(await inspect("!!document.querySelector('#settings-modal-title')"))result.prose=await assertSettingsProseMeasure(session);
     if(result.owners.some(row=>row.overflow>1))result.overflowElements=await inspect("(()=>{const dialog=document.querySelector('[role=dialog]');if(!dialog)return [];const edge=dialog.getBoundingClientRect().right-parseFloat(getComputedStyle(dialog).paddingRight);return [...dialog.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().width&&el.getBoundingClientRect().right>edge+.5).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,text:el.children.length?undefined:el.textContent,classes:el.getAttribute('class'),width:r.width,right:r.right,parentWidth:el.parentElement.getBoundingClientRect().width,minWidth:s.minWidth,display:s.display,visibility:s.visibility,inactive:!!el.closest('[inert],[aria-hidden=true]')};}).slice(0,40);})()");
    assert(result.owners.every(row=>row.overflow<=1),`${name} ${JSON.stringify(cell)} scroll-owner overflow: ${JSON.stringify(result)}`);
    assert(result.dialogRects.every(r=>r.left>=0&&r.right<=cell.width+.5&&r.top>=0&&r.bottom<=cell.height+.5),`${name}: dialog outside viewport ${JSON.stringify({cell,result})}`);
    const dangling=await inspect("[...document.querySelectorAll('[role=dialog] label[for]')].filter(el=>!document.getElementById(el.htmlFor)).map(el=>({text:el.textContent,for:el.htmlFor}))");
    assert(!dangling.length,`${name}: labels name absent controls: ${JSON.stringify(dangling)}`);
    if(name==='appearance'){
      await session.key('Tab',{windowsVirtualKeyCode:9});
      result.navFocus=await inspect("(()=>{const nav=document.querySelector('[aria-label=\"Settings pages\"]'),el=nav.querySelector('[aria-current=page]');el.focus();const a=nav.getBoundingClientRect(),b=el.getBoundingClientRect(),s=getComputedStyle(el),outset=parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset);return {visible:el.matches(':focus-visible'),style:s.outlineStyle,width:parseFloat(s.outlineWidth),contained:b.left-outset>=a.left&&b.right+outset<=a.right};})()");
      assert(result.navFocus.visible&&result.navFocus.style==='solid'&&result.navFocus.width===2&&result.navFocus.contained,'Navigation focus ring clipped');
    }
    if(name==='backups'){
       result.controlRects=await session.read('#settings-field-basePath', "(()=>{const row=document.querySelector('#settings-field-basePath').parentElement;return [...row.querySelectorAll('input,button')].map(el=>el.getBoundingClientRect().toJSON());})()");
      result.controlHeights=result.controlRects.map(rect=>rect.height);
      assert(result.controlRects.length===2&&result.controlHeights.every(height=>height>=44*cell.textScale-.5),`Input/secondary minimum height: ${JSON.stringify(result.controlRects)}`);
      if(Math.abs(result.controlRects[0].top-result.controlRects[1].top)<.5)assert(Math.max(...result.controlHeights)-Math.min(...result.controlHeights)<=.5,`Paired input/secondary control heights diverge: ${JSON.stringify(result.controlRects)}`);
    }
    if(await inspect("!!document.querySelector('#settings-modal-title')"))result.actionZones=await assertSettingsActionZones(session);
    else {
      const action=await inspect("(()=>{const form=document.querySelector('form'),code=document.querySelector('#setup-authenticator-code'),qr=document.querySelector('.authenticator-qr'),button=form.querySelector('button[type=submit]');button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {code:!!code,qr:!!qr,button:r.toJSON(),hit:button.contains(hit),hitTag:hit?.tagName,hitClass:hit?.getAttribute('class'),scrollWidth:form.scrollWidth,clientWidth:form.clientWidth};})()");
      if(action.scrollWidth>action.clientWidth+1)action.elements=await inspect("(()=>{const form=document.querySelector('form'),edge=form.getBoundingClientRect().right;return [...form.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>edge+.5||el.scrollWidth>el.clientWidth+1).map(el=>({tag:el.tagName,text:el.children.length?undefined:el.textContent,classes:el.getAttribute('class'),rect:el.getBoundingClientRect().toJSON(),scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,overflowWrap:getComputedStyle(el).overflowWrap,parentWidth:el.parentElement.getBoundingClientRect().width}));})()");
      assert(action.code&&action.qr&&action.button.width>0&&action.hit&&action.scrollWidth<=action.clientWidth+1,`Setup enrollment/action containment ${JSON.stringify({name,cell,action})}`);
    }
    observations.push({name,...cell,...result});
  }
  async function api(path,method='GET',body){const r=await fetch(`${server.baseUrl}/_/api/${path}`,{method,headers:{'content-type':'application/json',...adminHeaders},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await r.json();assert(r.ok,`Matrix fixture ${path}: ${JSON.stringify(data)}`);return data;}
  async function fixture(name){
    const logs=`${directory}/${name}`;await Deno.mkdir(logs);
    const vault=await Deno.makeTempDir({prefix:'settings-surfaces-vault-'}),state=await metadataDirectory({prefix:'settings-surfaces-state-'});
    await Deno.writeTextFile(`${vault}/Note.md`,'# Surface matrix\n');await Deno.mkdir(`${vault}/Archive`);
    if(name==='main')await Deno.writeTextFile(`${state}/config.toml`, '[brand]\nname="Surface notes"\n');
    if(name==='main'){
      const plugin=`${state}/plugins/surface-probe`;await Deno.mkdir(plugin,{recursive:true});
      const page=id=>({id,label:id==='one'?'One':'LongUnbroken'.repeat(12),description:'A real declared page with multiple control types.',renderer:{kind:'declarative-v1',version:1},fields:[{key:'message',label:'Message',type:'text',default:'A retained value'},{key:'limit',label:'Limit',type:'number',default:2},{key:'body',label:'Body',type:'textarea',default:'Long text'},{key:'enabled',label:'Enabled',type:'toggle',default:false}]});
      await Deno.writeTextFile(`${plugin}/manifest.json`,JSON.stringify({id:'surface-probe',name:'Surface probe',runtime:{server:'service.js'},capabilities:{network:['surface.example:443']},settings:[page('one'),page('long')]}));
      await Deno.writeTextFile(`${plugin}/service.js`,"let sequence=0;export function activate(ctx){ctx.commands.register({id:'request',label:'Surface request',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['surface-'+(++sequence)+'.example:443'],reason:'Surface matrix request'}));}");
    }
    if(name==='first-run'){
      const cwd=await createServerWorkingDirectory();
      const {host,origin}=applicationServer(),listener=Deno.listen({hostname:host,port:0}),appPort=listener.addr.port;listener.close();
      const child=new Deno.Command(Deno.execPath(),{args:['run','--cached-only','--frozen',`--config=${ROOT}/deno.json`,'--unstable-worker-options','--allow-read','--allow-write','--allow-net','--allow-env',`${ROOT}/server/main.ts`],cwd,clearEnv:true,env:{PATH:Deno.env.get('PATH'),HOME:Deno.env.get('HOME'),TMPDIR:Deno.env.get('TMPDIR'),GLOBNOTES_GLOBNOTES_PATH:vault,GLOBNOTES__METADATA_PATH:metadataBase(vault,state),GLOBNOTES__SERVER_HOST:host,GLOBNOTES__SERVER_PORT:String(appPort),GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE:'false'},stdout:'piped',stderr:'piped'}).spawn();
      const drains=['stdout','stderr'].map(async channel=>{const file=await Deno.open(`${logs}/server-${channel}.log`,{write:true,createNew:true});try{for await(const bytes of child[channel]){let at=0;while(at<bytes.length)at+=await file.write(bytes.subarray(at));}}finally{file.close();}});
      server={baseUrl:origin(appPort),pid:child.pid,cwd,async close(){try{child.kill('SIGTERM');await child.status;await Promise.all(drains);}finally{await Deno.remove(cwd,{recursive:true});}}};
      await awaitHealthy(server.baseUrl,{label:'Surface first-run health',child});
    }else{
      const input = await nativeFixtureInput(nativeAccountScenario({ account: actor, everybody: name === "protected" ? "none" : "edit" }));
      server = await bootServer(vault,state,{...input,env:{TMPDIR:Deno.env.get('TMPDIR')},logsDir:logs});
      ({ headers: adminHeaders } = await nativeFixtureAdmin(server));
    }
    session=await nativeSession({port});owners.push({name,vault,state,pid:server.pid,cwd:server.cwd,origin:server.baseUrl,targetId:session.targetId});
  }
  async function visit(cell,name){
    await session.send('Emulation.setDeviceMetricsOverride',{width:cell.width,height:cell.height,deviceScaleFactor:cell.dpr,mobile:false});
    await session.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('globnotes-theme','globnotes-${cell.mode}');localStorage.setItem('sidebarVisible','false');`});
    await session.goto(`${server.baseUrl}/Note`);
    if (name !== "first-run" && !await session.evaluate(tokenExpression())) {
      await signInNative(session, server, actor, { returnPath: "/Note" });
    }
    if(name!=='first-run'){await session.poll("!!document.querySelector('.toast-viewer')");await open();}
    else await session.poll("!!document.querySelector('#identity-setup-title')");
    if(cell.textScale!==1)await inspect(`document.documentElement.style.fontSize='${16*cell.textScale}px';true`);
  }
  async function close(){
    if(!session&&!server)return;
    const owner=owners.at(-1),errors=[...session.errors];
    try{await session.close();}finally{await server.close();}
    const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());owner.targetClosed=!targets.some(target=>target.id===owner.targetId);
    try{await fetch(`${server.baseUrl}/_/api/health`,{signal:AbortSignal.timeout(1500)});owner.serverClosed=false;}catch{owner.serverClosed=true;}
    session=null;server=null;assert(!errors.length&&owner.targetClosed&&owner.serverClosed,`Surface fixture cleanup/errors: ${JSON.stringify(errors)}`);
  }
  try{
    if(fixtures.includes('main')){
    await fixture('main');
    for(const cell of matrix){
      await visit(cell,'main');
      for(const [id,name] of [['core:appearance','appearance'],['core:editor','editor'],['core:keybindings','keybindings'],['core:diagnostics','diagnostics'],['core:plugins','plugins-collapsed'],['plugin:globnotes-backup','backups'],['core:branding','branding'],['core:access','access'],['core:account','account']]){
        await nav(id);if(id==='core:access')await session.poll("!!document.querySelector('#access-everybody')");if(id==='plugin:globnotes-backup')await session.poll("!!document.querySelector('#settings-field-basePath')");await probe(name,cell);
      }
      await session.click('[data-settings-nav-id="plugin:surface-probe"]');await session.poll("!!document.querySelector('#settings-field-message')");await probe('plugin-page-one',cell);
      await session.click('[data-settings-tab-id="plugin:surface-probe:long"]');await probe('plugin-page-long',cell);
      await nav('core:plugins');await session.click('[data-plugin-inventory-id=surface-probe] button[aria-expanded]');await session.poll("!!document.querySelector('[data-plugin-inventory-id=surface-probe] [data-plugin-permission-panel]')");await probe('plugins-expanded',cell);
       const aligned=await session.read(['.plugin-policy-row [role=switch]', '[data-plugin-inventory-id=surface-probe] .plugin-row-toggle-lane [role=switch]', '[data-plugin-inventory-id=surface-probe] [data-plugin-permission-panel] [role=switch]'], "(()=>{const root=document.querySelector('[data-plugin-inventory]'),policy=root.querySelector('.plugin-policy-row [role=switch]'),plugin=root.querySelector('[data-plugin-inventory-id=surface-probe]'),row=plugin.querySelector('.plugin-row-toggle-lane [role=switch]'),master=plugin.querySelector('[data-plugin-permission-panel] [role=switch]');return [policy,row,master].map(el=>el.getBoundingClientRect().right);})()");
      assert(Math.max(...aligned)-Math.min(...aligned)<=.5,`Policy/header/master right edges diverged: ${JSON.stringify(aligned)}`);
      await nav('core:branding');await session.poll("!!document.querySelector('#brand-name')");await session.button('Reset branding…');await session.poll("document.querySelector('[data-modal-top=true] h2')?.textContent==='Reset branding?'");await probe('confirmation',cell);
       const hover=await session.read('[data-variant=danger-primary]', "(()=>{const button=document.querySelector('[data-variant=danger-primary]'),r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',...hover});
       const danger=await session.read('[data-variant=danger-primary]', "(()=>{const el=document.querySelector('[data-variant=danger-primary]'),s=getComputedStyle(el),r=getComputedStyle(document.documentElement);return {background:s.backgroundColor,color:s.color,expectedBackground:'rgb('+r.getPropertyValue('--theme-danger-hover').trim().split(' ').join(', ')+')',expectedColor:'rgb('+r.getPropertyValue('--theme-on-danger').trim().split(' ').join(', ')+')'};})()");
      assert(danger.background===danger.expectedBackground&&danger.color===danger.expectedColor,`Danger hover lost semantic paint: ${JSON.stringify(danger)}`);
      await session.button('Cancel','[data-modal-top=true]');await replace('#brand-name','Retained surface choice');await session.click('[data-settings-nav-id="core:appearance"]');await session.poll("document.querySelector('[data-modal-top=true] h2')?.textContent==='Unsaved changes'");await probe('unsaved-changes',cell);await session.button('Keep editing','[data-modal-top=true]');await session.button('Cancel changes');
      await nav('plugin:globnotes-backup');await session.poll("!!document.querySelector('#settings-field-basePath')");await session.button('Choose folder…');await session.poll("!!document.querySelector('[aria-current=location]') && !document.querySelector('[data-modal-top=true] [role=status]')");await probe('folder-chooser',cell);await session.button('Cancel','[data-modal-top=true]');
      await api('plugin-host/surface-probe/commands/request','POST',{});await session.poll("!!document.querySelector('#permission-request-title')");await session.button('Review later','[data-modal-top=true]');await session.poll("!!document.querySelector('[data-settings-attention] button')");await probe('needs-attention',cell);
      await nav('core:plugins');await session.click('[data-plugin-inventory-id=surface-probe] button[aria-expanded]');await session.poll("!!document.querySelector('[data-pending-permission-requests]')");
       assert(await session.read('[data-pending-permission-requests] button', "document.querySelector('[data-pending-permission-requests]').textContent.includes('Surface matrix request') && document.querySelector('[data-pending-permission-requests] button').getAttribute('aria-label').includes('Surface matrix request')"),'Expanded request lost its reason/contextual name');
      await probe('plugins-expanded-request',cell);await nav('plugin:globnotes-backup');await session.poll("!!document.querySelector('#settings-field-basePath')");
      await session.click('[data-settings-attention] button');await session.poll("!!document.querySelector('#permission-request-title')");await probe('request-from-attention-over-backups',cell);await session.button('Deny','[data-modal-top=true]');await session.poll("!document.querySelector('#permission-request-title') && !document.querySelector('[data-settings-attention]')");
    }
    await close();
    }
    for(const name of ['protected','first-run'].filter(name=>fixtures.includes(name))){
      await fixture(name);
      for(const cell of matrix){
        await visit(cell,name);
          if(name==='protected'){await nav('core:account');await session.poll("document.querySelector('[data-settings-content]')?.textContent.includes('surface-user')");await probe('signed-in-account',cell);await session.button('Add authenticator');}
         else{await replace('#setup-login','surface-user');await replace('#setup-password','surface-password');await session.click('#setup-authenticator');}
         await session.poll("document.querySelector('.authenticator-qr')?.naturalWidth>0");await probe(`account-${name==='protected'?'authenticator-existing':'setup-first-run'}`,cell);
      }
      await close();
    }
  }catch(error){
    failure=error;
    if(session){
      const observation=await inspect("(async()=>{const token=sessionStorage.getItem('globnotes:session:root'),headers=token?{authorization:'Bearer '+token}:{},config=await fetch('/_/api/config',{headers}).then(r=>r.json()),response=await fetch('/_/api/access',{headers}),view=await response.json();return {url:location.href,hasToken:!!token,body:document.body.innerText,access:{status:response.status,everybody:view.everybody},config:{principal:config.principal,capabilities:config.capabilities,setupRequired:config.setupRequired,authorityRevision:config.authorityRevision}};})()").catch(cause=>({diagnosticError:cause.message}));
      await Deno.writeTextFile(`${directory}/failure-observation.json`,JSON.stringify(observation,null,2),{createNew:true});
    }
    throw error;
  }
  finally{if(session)await close();await Deno.writeTextFile(`${directory}/matrix.json`,JSON.stringify({cells:matrix,observations,owners,failure:failure?.message??null},null,2),{createNew:true});}
  return {cells:matrix.length,surfaces:observations.length,maximumOverflow:Math.max(...observations.flatMap(row=>row.owners.map(owner=>owner.overflow))),owners};
}
import { metadataBase, metadataDirectory } from "./config-fixture.mjs";
