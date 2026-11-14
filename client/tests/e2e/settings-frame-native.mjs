// Feature-owned geometry consumer: the rule reaches the frame's inner edge.
export async function settingsHeaderRuleEdge(session) {
   return session.read('#settings-modal-title', `(() => {
    const title = document.querySelector('#settings-modal-title');
    const header = title?.parentElement?.parentElement;
    const frame = title?.closest('[role=dialog]');
    if (!header || !frame) throw Error('Settings frame/header is not rendered');
    const box = frame.getBoundingClientRect(), rule = header.getBoundingClientRect();
    const style = getComputedStyle(frame), close = header.querySelector('[aria-label="Close settings"]');
    const closeBox = close.getBoundingClientRect();
    const innerRight = box.right - parseFloat(style.borderRightWidth);
    return { width:innerWidth, height:innerHeight, frame:box.toJSON(), header:rule.toJSON(),
      textScale:parseFloat(getComputedStyle(document.documentElement).fontSize)/16,
      closeContained:closeBox.left>=rule.left&&closeBox.right<=rule.right&&closeBox.top>=rule.top&&closeBox.bottom<=rule.bottom,
      innerRight, ruleRight:rule.right, edgeDelta:innerRight-rule.right,
      overflowY:style.overflowY, scrollbarGutter:style.scrollbarGutter,
      close:{width:closeBox.width,height:closeBox.height,variant:close.dataset.variant} };
  })()`);
}

export async function assertSettingsHeaderRuleEdge(session) {
  const observation = await settingsHeaderRuleEdge(session);
  if (Math.abs(observation.edgeDelta) > 0.5) throw Error(`header-rule-edge: ${JSON.stringify(observation)}`);
  return observation;
}

// Rendered fd214f0 baseline at 1280, 1600 and 360px with the default text size.
// Icon-only chrome stays compact in rem units; enlarged text can reflow the header.
export async function assertSettingsHeaderGeometry(session) {
  const observation = await settingsHeaderRuleEdge(session);
  const scale=observation.textScale;
  if(scale===1&&Math.abs(observation.header.height-53)>.5||Math.abs(observation.close.width-20*scale)>.5||Math.abs(observation.close.height-28*scale)>.5||!observation.closeContained||observation.close.variant!=='text')throw Error(`Settings header geometry: ${JSON.stringify(observation)}`);
  return {height:observation.header.height,close:observation.close};
}

export async function assertSettingsActionHierarchy(session) {
   const counts=await session.read('[role=dialog]', "[...document.querySelectorAll('[role=dialog],form')].filter(el=>!!el.getBoundingClientRect().width).map(el=>({name:el.getAttribute('aria-labelledby')||el.tagName,primary:el.querySelectorAll('button.bg-theme-brand,button[data-variant=danger-primary]').length}))");
  if(counts.some(row=>row.primary>1))throw Error(`Multiple primary actions: ${JSON.stringify(counts)}`);
  return counts;
}

export async function assertSettingRowAlignment(session) {
   const rows=await session.read('[role=dialog]', "[...document.querySelectorAll('.setting-row-short')].filter(row=>!row.closest('[inert]')).map(row=>{const label=row.querySelector('.setting-row-label'),control=row.querySelector('.setting-row-control'),a=label.getBoundingClientRect(),b=control.getBoundingClientRect(),r=row.getBoundingClientRect(),s=getComputedStyle(row);return {label:label.textContent.trim(),visible:!!a.width&&!!b.width,stacked:b.top>=a.bottom,contained:b.left>=r.left-.5&&b.right<=r.right+.5,delta:(a.top+a.bottom-b.top-b.bottom)/2,inline:Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top),inlineGap:b.left-a.right,rowGap:b.top-a.bottom,expectedColumnGap:parseFloat(s.columnGap)||0,expectedRowGap:parseFloat(s.rowGap)||0,endDelta:r.right-b.right,overflow:Math.max(a.right-r.right,b.right-r.right,r.left-a.left,r.left-b.left)};}).filter(row=>row.visible)");
  if(rows.some(row=>!row.contained||!row.stacked&&Math.abs(row.delta)>0.5))throw Error(`Setting row centerlines/reflow: ${JSON.stringify(rows)}`);
  assertSettingRowMeasurements(rows);
  return rows;
}

export async function assertSettingsFormRows(session) {
  const rows=await session.read('[data-settings-content]', `(()=>{
    return [...document.querySelectorAll('[data-settings-content] .setting-row-form')].map(row=>{
      const label=row.querySelector('.setting-row-label').getBoundingClientRect(),lane=row.querySelector('.setting-row-control').getBoundingClientRect(),box=row.getBoundingClientRect();
      const inputs=[...row.querySelectorAll('input:not([type=color]):not([type=hidden]),select,textarea')].filter(el=>el.type!=='range'&&el.getBoundingClientRect().width>0).map(el=>{const r=el.getBoundingClientRect();return {id:el.id,left:r.left,right:r.right,width:r.width,expectedWidth:Math.min(lane.width,el.type==='number'?96:384)};});
      return {label:row.querySelector('.setting-row-label').textContent.trim(),width:box.width,right:box.right,lane:lane.toJSON(),stacked:lane.top>=label.bottom,delta:(label.top+label.bottom-lane.top-lane.bottom)/2,inputs};
    });
  })()`);
  if(!rows.length||rows.some(row=>!row.stacked&&Math.abs(row.delta)>.5||Math.abs(row.lane.right-row.right)>.5||Math.abs(row.lane.width-Math.min(384,row.width))>.5||row.inputs.some(input=>Math.abs(input.right-row.lane.right)>.5||Math.abs(input.width-input.expectedWidth)>.5)))throw Error(`Settings form rows: ${JSON.stringify(rows)}`);
  return rows;
}

export async function assertSettingsUiRules(session) {
  await assertSettingsTypography(session);
  const result=await session.read('#settings-modal-title', `(()=>{
    const frame=document.querySelector('#settings-modal-title').closest('[role=dialog]');
    const visible=el=>el.getBoundingClientRect().width>0&&!el.closest('[inert]');
    const root=getComputedStyle(document.documentElement),color=name=>'rgb('+root.getPropertyValue(name).trim().split(' ').filter(Boolean).join(', ')+')';
    const muted=[color('--theme-text-muted'),color('--theme-text-very-muted')];
    const mutedActions=[...frame.querySelectorAll('button[data-variant=text],.settings-nav button,.settings-tabs button,.keybinding-picker button,summary')].filter(visible).filter(el=>muted.includes(getComputedStyle(el).color)).map(el=>({label:el.textContent.trim()||el.getAttribute('aria-label'),color:getComputedStyle(el).color}));
    return {disabled:[...frame.querySelectorAll('[disabled]')].map(el=>el.textContent||el.id),mutedActions,actionStyles:[...frame.querySelectorAll('.custom-button')].filter(visible).filter(el=>el.textContent.trim()).filter(el=>['text','danger-text'].includes(el.dataset.variant)||getComputedStyle(el).fontSize!=='14px').map(el=>({label:el.textContent,variant:el.dataset.variant,font:getComputedStyle(el).fontSize})),staticHints:[...frame.querySelectorAll('[data-keybindings-settings] > div > p')].map(el=>el.textContent).filter(text=>/Ctrl|Escape|Alt[+]/.test(text))};
  })()`);
  if(result.disabled.length||result.mutedActions.length||result.actionStyles.length||result.staticHints.length)throw Error(`Settings UI rules: ${JSON.stringify(result)}`);
  return result;
}

export async function assertSettingsPaneEdges(session) {
  const headerGeometry = await assertSettingsHeaderGeometry(session);
  const result = await session.read(['[data-settings-content]', '[data-settings-page]', '.setting-row'], `(()=>{
    const pane=document.querySelector('[data-settings-content]'),page=pane.querySelector('[data-settings-page]');
    const content=el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el),borderLeft=parseFloat(style.borderLeftWidth),borderRight=parseFloat(style.borderRightWidth),scrollbar=el.offsetWidth-el.clientWidth-borderLeft-borderRight;return {left:box.left+borderLeft+parseFloat(style.paddingLeft),right:box.right-borderRight-parseFloat(style.paddingRight)-scrollbar};};
    const paneBox=content(pane),pageBox=content(page);
    return {viewport:innerWidth,paneLeft:paneBox.left,paneRight:paneBox.right,pageLeft:pageBox.left,pageRight:pageBox.right,rows:[...page.querySelectorAll('.setting-row')].filter(row=>row.getBoundingClientRect().width&&!row.closest('[inert]')).map(row=>({label:row.querySelector('.setting-row-label').textContent.trim(),left:row.getBoundingClientRect().left,right:row.getBoundingClientRect().right}))};
  })()`);
  if(Math.abs(result.pageLeft-result.paneLeft)>.5||Math.abs(result.pageRight-result.paneRight)>.5||result.rows.some(row=>Math.abs(row.left-result.paneLeft)>.5||Math.abs(row.right-result.paneRight)>.5))throw Error(`Settings pane edges: ${JSON.stringify(result)}`);
  return {...result,headerGeometry};
}

export async function assertSettingsProseMeasure(session) {
  const result=await session.read('[role=dialog]', "[...document.querySelectorAll('.setting-row p > span,[data-keybindings-settings] > div > p,[data-sync-settings] > p,.driver-instance > p,.driver-secret p,.settings-page-description,.settings-section-intro p')].filter(el=>el.getBoundingClientRect().width&&!el.closest('[inert]')).map(el=>({text:el.textContent,width:el.getBoundingClientRect().width,maxWidth:getComputedStyle(el).maxWidth}))");
  if(result.some(p=>p.maxWidth==='none'||p.width>parseFloat(p.maxWidth)+.5))throw Error(`Settings prose measure: ${JSON.stringify(result)}`);
  return result;
}

export function assertSettingRowMeasurements(rows) {
  // Short controls share a centerline when beside their label. Flex reflow
  // instead puts them at the end of the next line with the declared row gap.
  const invalid = rows.filter(row => row.overflow > .5 || (row.inline
    ? Math.abs(row.delta) > .5 || Math.abs(row.inlineGap-row.expectedColumnGap) > .5
    : Math.abs(row.endDelta) > .5 || Math.abs(row.rowGap-row.expectedRowGap) > .5));
  if (invalid.length) throw Error(`Setting row alignment/reflow: ${JSON.stringify(invalid)}`);
}

export async function assertSettingRowErrors(session) {
   const errors=await session.read('[role=dialog]', "(()=>{const expected=getComputedStyle(document.documentElement).getPropertyValue('--theme-danger').trim().split(' ').filter(Boolean).map(Number);return [...document.querySelectorAll('.setting-row [role=alert]')].filter(el=>!el.closest('[inert]')&&!!el.getBoundingClientRect().width).map(el=>({text:el.textContent,actual:getComputedStyle(el).color.match(/[0-9.]+/g).slice(0,3).map(Number),expected}));})()");
  if(errors.some(row=>JSON.stringify(row.actual)!==JSON.stringify(row.expected)))throw Error(`Validation error ink: ${JSON.stringify(errors)}`);
  return errors;
}

export async function settingsVisualLanes(session) {
   return session.read('[role=dialog]', "(()=>{const pair=document.querySelector('[data-theme-id=system] .theme-system-pair'),previews=pair?[...pair.children].map(el=>el.getBoundingClientRect()):[];const actions=[...document.querySelectorAll('[data-plugin-inventory-id]')].flatMap(row=>{const name=row.querySelector('.plugin-row-name')?.getClientRects()[0];if(!name)return [];return [...row.querySelectorAll('.plugin-row-action-lane button .icon-label-wrap > span')].map(el=>{const r=el.getBoundingClientRect(),line=parseFloat(getComputedStyle(el).lineHeight);return {plugin:row.dataset.pluginInventoryId,label:el.textContent,oneLine:r.height<=line+.5,delta:(r.top+r.bottom-name.top-name.bottom)/2};});});return {systemSeam:previews.length===2?previews[1].left-previews[0].right:null,actions};})()");
}

export async function assertSettingsVisualLanes(session) {
  const result=await settingsVisualLanes(session);
  if(result.systemSeam!==null&&Math.abs(result.systemSeam)>.5||result.actions.some(row=>row.oneLine&&Math.abs(row.delta)>.5))throw Error(`Settings visual lanes: ${JSON.stringify(result)}`);
  return result;
}

export async function assertSettingsTypography(session) {
  const mismatches=await session.read('[role=dialog]', `(()=>{
    const roles={'settings-text':['14px','21px'],'settings-help':['13px','19.5px'],'settings-small':['12px','18px'],'settings-heading':['18px','27px']};
    return Object.entries(roles).flatMap(([role,expected])=>[...document.querySelectorAll('.'+role)].filter(el=>el.getBoundingClientRect().width&&!el.closest('[inert]')).flatMap(el=>{const s=getComputedStyle(el);return s.fontSize===expected[0]&&s.lineHeight===expected[1]?[]:[{role,text:el.textContent.slice(0,80),actual:[s.fontSize,s.lineHeight],expected}];}));
  })()`);
  if(mismatches.length)throw Error(`Settings typography: ${JSON.stringify(mismatches)}`);
  return mismatches;
}
