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
  const point = await session.poll(`(async()=>{
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
  })()`);
  await session.click(selector, point);
}
