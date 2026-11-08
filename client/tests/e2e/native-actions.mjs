// Admit a native pointer click only after assets, geometry and hit target settle.
// Presence alone is insufficient: late images can move a link between sampling
// its rectangle and dispatching the pointer at that rectangle.
export function visibleElement(el) {
  if (!el?.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
  }
  return true;
}
export async function clickReady(session, selector, { text } = {}) {
  const locate = text === undefined
    ? `document.querySelector(${JSON.stringify(selector)})`
    : `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&(${visibleElement.toString()})(el))`;
  await session.evaluate("document.fonts.ready.then(()=>true)");
  await session.poll("[...document.images].every(image=>image.complete)");
  const point = await session.poll(stablePoint(locate));
  await session.click(selector, point, locate);
}

function stablePoint(locate) {
  return `(async()=>{
    const el=${locate};
    if(!el)return false;
    el.scrollIntoView({block:'center',inline:'center'});
    const before=el.getBoundingClientRect();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const after=el.getBoundingClientRect();
    const hit=document.elementFromPoint(after.x+after.width/2,after.y+after.height/2);
    // A region marked aria-busy (a viewer still laying out its diagrams) is
    // still moving: its frame-stable rect is not its final one.
    const ready=el===(${locate})&&!el.matches(':disabled')&&!el.closest('[inert]')&&
      !el.parentElement?.closest('[aria-busy="true"]')&&(${visibleElement.toString()})(el)&&
      Math.abs(before.x-after.x)<=0.5&&Math.abs(before.y-after.y)<=0.5&&
      Math.abs(before.width-after.width)<=0.5&&Math.abs(before.height-after.height)<=0.5&&el.contains(hit);
    return ready ? {x:after.x+after.width/2,y:after.y+after.height/2} : false;
  })()`;
}

// Admission must happen in the page's event task, not a CDP round trip earlier.
// A missed press fails closed. No input is replayed: follow the same element
// through press-induced reflow, and fail closed if release still misses it.
export async function dispatchNativeClick(session, send, locate) {
  const key = "__globnotesNativeClick";
  // Observe click admission before a link's default action destroys its DOM.
  let clicked = false;
  const releaseEvents = session.onEvent(event => {
    if (event.method === "Runtime.bindingCalled" && event.params.name === "__globnotesNativeClickResult" && event.params.payload === "click") clicked = true;
  });
  await session.evaluate(`(()=>{
    if(window.${key})throw Error('Native click already owned');
    const state=window.${key}={el:null,admitted:false,clicked:false,missed:false,events:[]};
    const types=['pointerdown','mousedown','pointerup','mouseup','click'];
    const guard=event=>{
      if(!event.isTrusted)return;
      const hit=state.el?.isConnected&&state.el.contains(event.target);
      state.events.push({type:event.type,hit:!!hit,tag:event.target.tagName,x:event.clientX,y:event.clientY,connected:state.el?.isConnected,rect:state.el?.getBoundingClientRect().toJSON()});
      if(event.type==='pointerdown')state.admitted=!!hit;
      if(!state.admitted||!hit||state.missed){
        state.missed=true;event.preventDefault();event.stopImmediatePropagation();return;
      }
      if(event.type==='click'){state.clicked=true;window.__globnotesNativeClickResult('click');}
    };
    for(const type of types)window.addEventListener(type,guard,true);
    state.close=()=>{for(const type of types)window.removeEventListener(type,guard,true);delete window.${key};};
    return true;
  })()`);
  let pressed = false, point;
  try {
      await session.evaluate(`(()=>{const s=window.${key};s.el=${locate};s.admitted=false;s.clicked=false;s.missed=false;return true;})()`);
      point = await session.poll(stablePoint(`window.${key}.el`));
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      pressed = true;
      const admitted = await session.evaluate(`window.${key}.admitted`);
      if (admitted) point = await session.poll(stablePoint(`window.${key}.el`));
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      pressed = false;
      if (clicked) return;
      const result = await session.evaluate(`window.${key}?({admitted:window.${key}.admitted,clicked:window.${key}.clicked,missed:window.${key}.missed,events:window.${key}.events,focused:document.hasFocus(),active:document.activeElement===window.${key}.el,visibility:document.visibilityState}):null`);
      if (clicked) return;
      // Binding notifications and protocol replies have independent delivery.
      // The live document's trusted-event fact is authoritative too.
      if (result?.clicked) { clicked = true; return; }
      throw Error(`Native click did not reach its actual owner; action was not replayed: ${JSON.stringify({locate,result})}`);
  } finally {
    try {
      if (pressed) await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    } finally {
      releaseEvents();
      // Navigation may already have retired the guarded document.
      await session.evaluate(`window.${key}?.close(),true`).catch(error => { if (!clicked) throw error; });
    }
  }
}
