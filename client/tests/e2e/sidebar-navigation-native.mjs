// SidebarPanel's rendered controls own readiness, not document.complete or
// absence of its floating opener. Keep the state decision in the same DOM read.
import { visibleElement } from './native-actions.mjs';

export async function showSidebar(session) {
  const opener='[title="Open sidebar"]', settings='aside [aria-label="Settings"]';
  const ready=selector=>`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!(${visibleElement.toString()})(el)||el.matches(':disabled')||el.closest('[inert]'))return false;
    const r=el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  })()`;
  const control=await session.poll(`(${ready(opener)})?${JSON.stringify(opener)}:(${ready(settings)})?${JSON.stringify(settings)}:false`);
  if(control===opener)await session.click(opener);
  await session.poll(ready(settings));
}
