// Observe shared appearance at real main/Settings consumers and layout at every
// action row. No test-only render path or synthetic CSS is injected into the app.
import { nativeSession } from './native-cdp-session.mjs';
import { bootServer } from './harness-helpers.mjs';

export async function settingsActionZones(session) {
  return session.evaluate(`(()=>{
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&!el.closest('[inert]');};
    const rect=el=>el.getBoundingClientRect().toJSON();
    const gap=(a,b)=>Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+.5
      ? Math.max(b.left-a.right,a.left-b.right)
      : Math.max(b.top-a.bottom,a.top-b.bottom);
    return [...document.querySelectorAll('[data-settings-actions]')].filter(visible).map(row=>{
      const zones=[...row.children].filter(el=>el.matches('[data-settings-actions-start],[data-settings-actions-end]')&&visible(el)).map(zone=>{
        const buttons=[...zone.querySelectorAll('button')].filter(visible).map(el=>{const s=getComputedStyle(el),root=getComputedStyle(document.documentElement);return {label:el.textContent.trim(),variant:el.dataset.variant,rect:rect(el),metrics:{fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom},secondaryBorder:el.dataset.variant==='secondary'?{shadow:s.boxShadow,expected:root.getPropertyValue('--theme-control-border').trim().split(' ').map(Number)}:null};});
        return {name:zone.hasAttribute('data-settings-actions-start')?'start':'end',rect:rect(zone),buttons,
          adjacentGaps:buttons.slice(1).map((button,index)=>gap(buttons[index].rect,button.rect))};
      }).filter(zone=>zone.buttons.length);
      return {zones,zoneGap:zones.length===2?gap(zones[0].rect,zones[1].rect):null};
    });
  })()`);
}

export async function assertSettingsActionZones(session) {
  const rows = await settingsActionZones(session);
  for (const row of rows) {
    if (row.zoneGap !== null && row.zoneGap < 24 - .5) throw Error(`Action zones too close: ${JSON.stringify(row)}`);
    for (const zone of row.zones) {
      if (zone.adjacentGaps.some(gap => gap < 16 - .5)) throw Error(`Adjacent actions too close: ${JSON.stringify(row)}`);
      const primary = zone.buttons.findIndex(button => ['cta', 'danger-primary'].includes(button.variant));
      if (primary !== -1 && (zone.name !== 'end' || primary !== zone.buttons.length - 1)) throw Error(`Primary order/zone: ${JSON.stringify(row)}`);
      if (zone.buttons.some(button => button.variant === 'cta') && zone.buttons.some(button => ['danger', 'danger-text'].includes(button.variant))) throw Error(`Destructive action shares primary zone: ${JSON.stringify(row)}`);
      const cta = zone.buttons.find(button => button.variant === 'cta');
      for (const secondary of zone.buttons.filter(button => button.variant === 'secondary')) {
        const border = secondary.secondaryBorder;
        const colors = [...border.shadow.matchAll(/rgba?\(([^)]+)\)/g)].map(match => match[1].split(/[,\s]+/).slice(0,3).map(Number));
        if (!border.shadow.includes('inset') || !border.shadow.includes('1px') || !colors.some(color => JSON.stringify(color) === JSON.stringify(border.expected))) throw Error(`Secondary control border not painted: ${JSON.stringify(row)}`);
        if (cta && JSON.stringify(cta.metrics) !== JSON.stringify(secondary.metrics)) throw Error(`Paired action metrics differ: ${JSON.stringify(row)}`);
        if (cta && Math.abs(cta.rect.top-secondary.rect.top)<.5 && Math.abs(cta.rect.height-secondary.rect.height)>.5) throw Error(`Paired action heights differ: ${JSON.stringify(row)}`);
      }
    }
  }
  return rows;
}

export async function primaryStyle(session, selector) {
  return session.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing primary consumer');const s=getComputedStyle(el);return Object.fromEntries(['backgroundColor','color','webkitTextStroke','paintOrder','fontWeight','fontFamily','paddingTop','paddingRight','paddingBottom','paddingLeft','fontSize','lineHeight','opacity'].map(key=>[key,s[key]]));})()`);
}

async function hoverStyle(session, selector, directory, label) {
  const geometry=await session.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {rect:r.toJSON(),point:{x,y},hit:hit&&{tag:hit.tagName,classes:hit.className,text:hit.textContent.slice(0,120)},targetHit:el.contains(hit),sidebarVisible:localStorage.getItem('sidebarVisible'),viewport:{width:innerWidth,height:innerHeight,outerWidth,outerHeight},visibility:document.visibilityState,focused:document.hasFocus()};})()`);
  await Deno.writeTextFile(`${directory}/${label}-hover.json`,JSON.stringify(geometry,null,2),{createNew:true});
  if(!geometry.targetHit)throw Error(`Hover target is obstructed: ${label} ${JSON.stringify(geometry)}`);
  const point=geometry.point;
  await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await session.poll(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`);
  return primaryStyle(session,selector);
}

export async function exercisePrimitiveOwnership({ port, directory }) {
  await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: 'settings-primary-vault-' });
  const state = await Deno.makeTempDir({ prefix: 'settings-primary-state-' });
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: 'none' }));
  const plugin = `${state}/plugins/primary-probe`;
  await Deno.mkdir(plugin, { recursive: true });
  await Deno.writeTextFile(`${plugin}/manifest.json`, JSON.stringify({ id: 'primary-probe', name: 'Primary probe', runtime: { server: 'service.js' }, capabilities: { network: true } }));
  await Deno.writeTextFile(`${plugin}/service.js`, "let n=0;export function activate(ctx){ctx.commands.register({id:'request',label:'Request',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['primary-'+(++n)+'.example:443'],reason:'Shared primary and decision-zone consumer'}));}");
  const server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: '', TMPDIR: Deno.env.get('TMPDIR') }, logsDir: directory });
  const session = await nativeSession({ port });
  const results = [];
  let failure;
  try {
    for (const mode of ['light', 'dark']) {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('globnotes-theme','globnotes-${mode}');` });
      await session.goto(`${server.baseUrl}/`);
      await session.poll("!!document.querySelector('button[data-variant=cta]') && document.fonts.status==='loaded'");
      if(await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width"))await session.click('[title="Close sidebar"]');
      await session.poll("!!document.querySelector('[title=\"Open sidebar\"]')");
      await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',...await session.evaluate('({x:innerWidth-1,y:innerHeight-1})')});
      const main = await primaryStyle(session, 'button[data-variant=cta]');
      const mainHover = await hoverStyle(session, 'button[data-variant=cta]', directory, `${mode}-main`);
      if (await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
      await session.click('[aria-label=Settings]');
      await session.poll("!!document.querySelector('#settings-modal-title')");
      await session.click('[data-settings-nav-id="core:branding"]');
      await session.poll("!!document.querySelector('#brand-name')");
      await session.click('#brand-name');await session.type('Primary consumer');
      await session.poll("document.querySelector('[data-branding-settings] [data-variant=cta]')?.disabled===false");
      const settings = await primaryStyle(session, '[data-branding-settings] [data-variant=cta]');
      const settingsHover = await hoverStyle(session, '[data-branding-settings] [data-variant=cta]', directory, `${mode}-branding`);
      const branding = await settingsActionZones(session);
      await session.button('Cancel changes','[data-branding-settings]');
      await session.poll("document.querySelector('[data-branding-settings] [data-variant=cta]')?.disabled===true");
      const response = await fetch(`${server.baseUrl}/_/api/plugin-host/primary-probe/commands/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error(`Primary fixture request rejected: ${response.status}`);
      await response.body?.cancel();
      await session.poll("!!document.querySelector('#permission-request-title')");
      await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',...await session.evaluate('({x:innerWidth-1,y:innerHeight-1})')});
      const request = await primaryStyle(session, '[data-modal-top=true] [data-variant=cta]');
      const requestHover = await hoverStyle(session, '[data-modal-top=true] [data-variant=cta]', directory, `${mode}-request`);
      const requestRows = await settingsActionZones(session);
      results.push({ mode, main, settings, request, mainHover, settingsHover, requestHover, branding, requestRows,
        equal: JSON.stringify(main) === JSON.stringify(settings) && JSON.stringify(main) === JSON.stringify(request) && JSON.stringify(mainHover) === JSON.stringify(settingsHover) && JSON.stringify(mainHover) === JSON.stringify(requestHover) });
      await session.button('Deny', '[data-modal-top=true]');
      await session.poll("!document.querySelector('#permission-request-title')");
    }
    await Deno.writeTextFile(`${directory}/measurements.json`, JSON.stringify(results, null, 2), { createNew: true });
    if (results.some(row => !row.equal)) throw Error(`Main/Settings CTA style differs: ${JSON.stringify(results)}`);
    // The full matrix invokes this assertion for every page/dialog as well.
    await assertSettingsActionZones(session);
    for (const row of results) for (const layout of [...row.branding, ...row.requestRows]) for (const zone of layout.zones) {
      if (zone.adjacentGaps.some(gap => gap < 15.5) || layout.zoneGap !== null && layout.zoneGap < 23.5 || zone.buttons.some(button => button.variant === 'cta') && zone.buttons.some(button => ['danger', 'danger-text'].includes(button.variant))) throw Error(`Decision layout differs: ${JSON.stringify(row)}`);
    }
  } catch (error) { failure = error; throw error; }
  finally {
    try { await session.close(); } finally { await server.close(); }
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    const targetClosed = !targets.some(target => target.id === session.targetId);
    let serverClosed = false;
    try { const response = await fetch(`${server.baseUrl}/_/api/health`, { signal: AbortSignal.timeout(1500) }); await response.body?.cancel(); }
    catch (error) { if (!(error instanceof TypeError)) throw error; serverClosed = true; }
    await Deno.writeTextFile(`${directory}/closure.json`, JSON.stringify({ targetClosed, serverClosed, failure: failure?.message ?? null, pid: server.pid, targetId: session.targetId, vault, state }, null, 2), { createNew: true });
    if (!targetClosed || !serverClosed || session.errors.length) throw Error(`Primitive fixture closure/browser errors: ${JSON.stringify({targetClosed,serverClosed,errors:session.errors})}`);
  }
  return { results, targetClosed: true, serverClosed: true };
}
