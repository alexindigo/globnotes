// Feature-owned Appearance consumer: keyboard intent reaches the persisted palette.
export async function exerciseAppearanceDesign(session) {
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const inspect=expression=>session.evaluate(expression);
  await session.button('Appearance','[aria-label="Settings pages"]');
  assert(await inspect("document.querySelectorAll('[role=radiogroup] [role=radio]').length===16"),'Appearance must expose all 16 radio choices');
  const families=await inspect("[...document.querySelectorAll('[data-appearance-settings] > [role=group]')].map(el=>document.getElementById(el.getAttribute('aria-labelledby')).textContent)");
  assert(families.length===7,'Appearance family grouping is incomplete');
  assert(await inspect("document.querySelector('[data-theme-id=system] .theme-system-pair').children.length===2"),'System needs both default previews');
  await session.click('[data-theme-id=system]'); await session.poll("localStorage.getItem('globnotes-theme')==='system'");
  await session.key('ArrowRight',{windowsVirtualKeyCode:39}); await session.poll("document.activeElement?.dataset.themeId==='globnotes-light'");
  assert(await inspect("localStorage.getItem('globnotes-theme')==='system'"),'Arrow focus applied an unchosen theme');
  await session.key('Enter',{windowsVirtualKeyCode:13}); await session.poll("localStorage.getItem('globnotes-theme')==='globnotes-light' && document.querySelector('[data-theme-id=globnotes-light]').getAttribute('aria-checked')==='true'");
  const ring=await inspect("(()=>{const tile=document.querySelector('[data-theme-id=globnotes-light]'),face=tile.querySelector('.theme-tile-face'),s=getComputedStyle(face),a=tile.getBoundingClientRect(),b=face.getBoundingClientRect(),label=tile.querySelector('.theme-tile-label').getBoundingClientRect();const family=[...document.querySelectorAll('[role=group]')].find(el=>el.querySelector('h3')?.textContent==='Catppuccin');return {width:parseFloat(s.outlineWidth),offset:parseFloat(s.outlineOffset),separation:b.left-a.left,labelGap:label.top-b.bottom,fourColumns:[...family.querySelectorAll('[role=radio]')].map(el=>el.getBoundingClientRect().top),focused:document.activeElement===tile};})()");
  assert(ring.width===2&&ring.offset===2&&ring.separation>=6&&ring.labelGap>=8&&ring.focused,'Selection ring/focus/label are not distinct structural elements');
  assert(Math.max(...ring.fourColumns)-Math.min(...ring.fourColumns)<=.5,'Catppuccin does not fit four desktop columns');
  const keyboard={arrowsFocusOnly:true,enterApplies:true,families,ring};
  const ids=await inspect("[...document.querySelectorAll('[role=radio][data-theme-id]')].map(el=>el.dataset.themeId)"), contrast=[];
  for(const id of ids) {
    await session.click(`[data-theme-id="${id}"]`); await session.poll(`localStorage.getItem('globnotes-theme')===${JSON.stringify(id)}`);
    const row=await inspect(`(()=>{const s=getComputedStyle(document.documentElement),rgb=name=>s.getPropertyValue('--theme-'+name).trim().split(' ').filter(Boolean).map(Number),l=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0),ratio=(a,b)=>(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);return {id:${JSON.stringify(id)},ratios:['success','warning','danger','text','quiet','text-muted','text-very-muted','control-border'].flatMap(role=>['background','background-elevated'].map(surface=>({role,surface,threshold:role==='control-border'?3:4.5,ratio:ratio(rgb(role),rgb(surface))}))),dangerPaint:['danger','danger-hover'].map(surface=>({surface,ratio:ratio(rgb('on-danger'),rgb(surface))})),selected:document.querySelectorAll('[role=radio][aria-checked=true]').length};})()`);
    assert(row.selected===1&&row.ratios.every(value=>value.ratio>=value.threshold)&&row.dangerPaint.every(value=>value.ratio>=4.5),`Semantic contrast/selection failed ${JSON.stringify(row)}`); contrast.push(row);
  }
  await session.click('[data-theme-id=globnotes-dark]'); await session.poll("document.body.classList.contains('dark')");
  await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
  await inspect("window.__appearanceDocument='before-reload';true");
  await session.send('Page.reload'); await session.poll("window.__appearanceDocument===undefined && document.readyState==='complete' && !!document.querySelector('.toast-viewer') && document.body.classList.contains('dark')");
  if(await inspect("!!document.querySelector('[title=\"Open sidebar\"]')"))await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]'); await session.poll("document.querySelector('[data-theme-id=globnotes-dark]')?.getAttribute('aria-checked')==='true'");
  return {keyboard,contrast,reloadedSelection:'globnotes-dark',browserErrors:session.errors};
}
