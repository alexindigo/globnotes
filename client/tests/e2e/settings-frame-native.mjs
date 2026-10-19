// Feature-owned geometry consumer: the rule reaches the frame's inner edge.
export async function settingsHeaderRuleEdge(session) {
  return session.evaluate(`(() => {
    const title = document.querySelector('#settings-modal-title');
    const header = title?.parentElement?.parentElement;
    const frame = title?.closest('[role=dialog]');
    if (!header || !frame) throw Error('Settings frame/header is not rendered');
    const box = frame.getBoundingClientRect(), rule = header.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const innerRight = box.right - parseFloat(style.borderRightWidth);
    return { width:innerWidth, height:innerHeight, frame:box.toJSON(), header:rule.toJSON(),
      innerRight, ruleRight:rule.right, edgeDelta:innerRight-rule.right,
      overflowY:style.overflowY, scrollbarGutter:style.scrollbarGutter };
  })()`);
}

export async function assertSettingsHeaderRuleEdge(session) {
  const observation = await settingsHeaderRuleEdge(session);
  if (Math.abs(observation.edgeDelta) > 0.5) throw Error(`header-rule-edge: ${JSON.stringify(observation)}`);
  return observation;
}

export async function assertSettingsActionHierarchy(session) {
  const counts=await session.evaluate("[...document.querySelectorAll('[role=dialog],form')].filter(el=>!!el.getBoundingClientRect().width).map(el=>({name:el.getAttribute('aria-labelledby')||el.tagName,primary:el.querySelectorAll('button.bg-theme-brand,button[data-variant=danger-primary]').length}))");
  if(counts.some(row=>row.primary>1))throw Error(`Multiple primary actions: ${JSON.stringify(counts)}`);
  return counts;
}

export async function assertSettingRowAlignment(session) {
  const rows=await session.evaluate("[...document.querySelectorAll('.setting-row-short')].filter(row=>!row.closest('[inert]')).map(row=>{const label=row.querySelector('.setting-row-label'),control=row.querySelector('.setting-row-control'),a=label.getBoundingClientRect(),b=control.getBoundingClientRect();return {label:label.textContent.trim(),visible:!!a.width&&!!b.width,delta:(a.top+a.bottom-b.top-b.bottom)/2};}).filter(row=>row.visible)");
  if(rows.some(row=>Math.abs(row.delta)>0.5))throw Error(`Setting row centerlines: ${JSON.stringify(rows)}`);
  return rows;
}

export async function assertSettingRowErrors(session) {
  const errors=await session.evaluate("(()=>{const expected=getComputedStyle(document.documentElement).getPropertyValue('--theme-danger').trim().split(' ').filter(Boolean).map(Number);return [...document.querySelectorAll('.setting-row [role=alert]')].filter(el=>!el.closest('[inert]')&&!!el.getBoundingClientRect().width).map(el=>({text:el.textContent,actual:getComputedStyle(el).color.match(/[0-9.]+/g).slice(0,3).map(Number),expected}));})()");
  if(errors.some(row=>JSON.stringify(row.actual)!==JSON.stringify(row.expected)))throw Error(`Validation error ink: ${JSON.stringify(errors)}`);
  return errors;
}

export async function settingsVisualLanes(session) {
  return session.evaluate("(()=>{const pair=document.querySelector('[data-theme-id=system] .theme-system-pair'),previews=pair?[...pair.children].map(el=>el.getBoundingClientRect()):[];const actions=[...document.querySelectorAll('[data-plugin-inventory-id]')].flatMap(row=>{const name=row.querySelector('.plugin-row-name')?.getClientRects()[0];if(!name)return [];return [...row.querySelectorAll('.plugin-row-action-lane button .icon-label-wrap > span')].map(el=>{const r=el.getBoundingClientRect(),line=parseFloat(getComputedStyle(el).lineHeight);return {plugin:row.dataset.pluginInventoryId,label:el.textContent,oneLine:r.height<=line+.5,delta:(r.top+r.bottom-name.top-name.bottom)/2};});});return {systemSeam:previews.length===2?previews[1].left-previews[0].right:null,actions};})()");
}

export async function assertSettingsVisualLanes(session) {
  const result=await settingsVisualLanes(session);
  if(result.systemSeam!==null&&Math.abs(result.systemSeam)>.5||result.actions.some(row=>row.oneLine&&Math.abs(row.delta)>.5))throw Error(`Settings visual lanes: ${JSON.stringify(result)}`);
  return result;
}
