import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { showSidebar } from './sidebar-navigation-native.mjs';

const run=expression=>Function(`return (${expression})`)();
const opener='[title="Open sidebar"]',settings='aside [aria-label="Settings"]';
let hit;
const originalHitTest=Object.getOwnPropertyDescriptor(document,'elementFromPoint');
beforeEach(()=>Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>hit}));
function render({open=false,pinned=false,inert=false}={}) {
  document.body.innerHTML=`<main ${inert?'inert':''}>${open?'':'<button title="Open sidebar"></button>'}<aside ${pinned?'data-pinned':''} style="display:${open?'block':'none'}"><button aria-label="Settings"></button></aside></main>`;
  for(const el of document.querySelectorAll('*'))el.style.opacity='1';
  for(const el of document.querySelectorAll('button'))el.getBoundingClientRect=()=>({x:10,y:10,width:24,height:24});
  hit=document.querySelector(open?settings:opener);
}
function session(beforePoll=()=>{}) {
  const clicks=[];
  return {clicks,poll:vi.fn(async expression=>{await beforePoll(expression,clicks);const value=run(expression);expect(value).toBeTruthy();return value;}),
    async click(selector){clicks.push(selector);expect(selector).toBe(opener);render({open:true});}};
}
afterEach(()=>{document.body.innerHTML='';if(originalHitTest)Object.defineProperty(document,'elementFromPoint',originalHitTest);else delete document.elementFromPoint;});

it('waits for the rendered owner before deciding whether the sidebar is collapsed',async()=>{
  render();document.body.innerHTML='';hit=null;
  let held=true;
  const s=session((expression,clicks)=>{
    if(!held)return;
    expect(run(expression)).toBe(false);expect(clicks).toEqual([]);
    render();held=false;
  });
  await showSidebar(s);
  expect(s.clicks).toEqual([opener]);expect(s.poll).toHaveBeenCalledTimes(2);
});

it('does not treat a hidden Settings gear as an already-open sidebar',async()=>{
  render();
  const s=session();await showSidebar(s);
  expect(s.clicks).toEqual([opener]);
});

for(const pinned of [false,true])it(`keeps an already-open ${pinned?'pinned':'overlay'} sidebar open without toggling`,async()=>{
  render({open:true,pinned});
  const s=session();await showSidebar(s);
  expect(s.clicks).toEqual([]);
});

it('does not admit inert or covered controls as interactive owner signals',async()=>{
  render({open:true,inert:true});
  let held=true;
  const s=session((expression,clicks)=>{
    if(!held)return;
    expect(run(expression)).toBe(false);expect(clicks).toEqual([]);
    render({open:true});hit=document.body;
    expect(run(expression)).toBe(false);expect(clicks).toEqual([]);
    hit=document.querySelector(settings);held=false;
  });
  await showSidebar(s);expect(s.clicks).toEqual([]);
});
