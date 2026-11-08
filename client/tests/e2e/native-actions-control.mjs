// Real pointer consumers: containers cannot substitute for controls, and only
// the topmost modal owns a named action when labels occur in multiple places.
import { connect } from "./cdp.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { assert } from "./test-outcomes.mjs";
const page = await connect({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
try {
  // A helper control on the owned target's initial about:blank, not an application
  // page, so it does not navigate through the application-origin goto().
  await page.poll("location.href === 'about:blank' && document.readyState === 'complete'");
  await page.evaluate("(()=>{document.body.innerHTML='<div style=\"width:800px;height:80px\"><button>Delete</button></div>';window.actionCount=0;document.querySelector('button').onclick=()=>window.actionCount++;return true;})()");
  await page.clickText("Delete");
  assert(await page.evaluate("window.actionCount===1&&document.querySelector('[data-cdp-click-target]').tagName==='BUTTON'"), "Named native action missed its actual control");
  await page.evaluate("(()=>{document.body.innerHTML='<button id=background>Delete</button><div data-modal-top=true style=\"margin-top:80px\"><button id=modal>Delete</button></div>';window.backgroundCount=0;window.modalCount=0;document.querySelector('#background').onclick=()=>window.backgroundCount++;document.querySelector('#modal').onclick=()=>window.modalCount++;return true;})()");
  await page.clickText("Delete");
  assert(await page.evaluate("window.backgroundCount===0&&window.modalCount===1"), "Named action reached a background control");
  console.log("Native pointer controls reached their actual topmost owners");
} finally { await page.close(); }

// The lower-level session must enforce readiness too. A sampled rectangle is
// not actionable when a pending render moves/replaces its control. Relocate
// during sampling deterministically, then observe the actual native consumer.
const native = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
try {
  await native.poll("location.href === 'about:blank' && document.readyState === 'complete'");
  const outcomes = [];
  for (const action of ["click", "button"]) {
    await native.evaluate(`(()=>{
      document.body.innerHTML='<button id="decoy" style="position:absolute;left:40px;top:40px">Wrong control</button><button id="moving" style="position:absolute;left:40px;top:40px">Moving control</button>';
      window.correctClicks=0;window.wrongClicks=0;
      document.querySelector('#decoy').onclick=()=>window.wrongClicks++;
      const target=document.querySelector('#moving'),rect=target.getBoundingClientRect.bind(target);
      target.onclick=()=>window.correctClicks++;
      let samples=0;
      target.getBoundingClientRect=()=>{const before=rect();if(++samples===${action === "click" ? 1 : 2})target.style.top='160px';return before;};
      return true;
    })()`);
    if (action === "click") await native.click("#moving");
    else await native.button("Moving control");
    outcomes.push({ action, ...await native.evaluate("({correct:window.correctClicks,wrong:window.wrongClicks})") });
  }
  assert(outcomes.every(row => row.correct === 1 && row.wrong === 0), `Native action dispatched before its actual hit target settled: ${JSON.stringify(outcomes)}`);
  console.log("Direct native actions waited for the real hit target before one dispatch");
  // Force both gaps: movement after sampling but before actual press, then
  // movement caused by the admitted press itself. Neither may hit the decoy.
  await native.evaluate(`(()=>{
    document.body.innerHTML='<button id="decoy" style="position:absolute;left:40px;top:40px">Wrong</button><button id="moving" style="position:absolute;left:40px;top:40px">Moving</button>';
    window.correctClicks=0;window.wrongClicks=0;window.correctPresses=0;window.wrongPresses=0;
    const el=document.querySelector('#moving'),wrong=document.querySelector('#decoy');
    wrong.onpointerdown=()=>window.wrongPresses++;wrong.onclick=()=>window.wrongClicks++;
    el.onpointerdown=()=>{window.correctPresses++;el.style.top='240px';};
    el.onclick=()=>window.correctClicks++;
    return true;
  })()`);
  const send = native.page.send;
  let moved = false;
  native.page.send = async (method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && !moved) {
      moved = true;
      await native.evaluate("document.querySelector('#moving').style.top='160px';true");
    }
    return send(method, params);
  };
  let rejected = false;
  try { await native.click("#moving"); }
  catch (error) { rejected = String(error).includes("action was not replayed"); }
  finally { native.page.send = send; }
  const blocked = await native.evaluate("({correct:window.correctClicks,wrong:window.wrongClicks,presses:window.correctPresses,wrongPresses:window.wrongPresses})");
  assert(rejected && blocked.correct === 0 && blocked.presses === 0 && blocked.wrong === 0 && blocked.wrongPresses === 0, `Stale pointer dispatch reached a page consumer: ${JSON.stringify(blocked)}`);
  await native.click("#moving");
  const delivered = await native.evaluate("({correct:window.correctClicks,wrong:window.wrongClicks,presses:window.correctPresses,wrongPresses:window.wrongPresses})");
  assert(delivered.correct === 1 && delivered.presses === 1 && delivered.wrong === 0 && delivered.wrongPresses === 0, `Event-time click ownership failed: ${JSON.stringify(delivered)}`);
  console.log("Native click rejected stale dispatch without replay, then followed press reflow with one admitted click");
  // A delayed observer notification cannot overrule the actual page event.
  await native.evaluate("document.body.innerHTML='<button id=ack>Consumer</button>';window.ackClicks=0;document.querySelector('#ack').onclick=()=>window.ackClicks++;true");
  const onEvent = native.page.onEvent, held = [];
  native.page.onEvent = listener => onEvent(event => {
    if (event.method === "Runtime.bindingCalled" && event.params.name === "__globnotesNativeClickResult") held.push(() => listener(event));
    else listener(event);
  });
  try { await native.click("#ack"); }
  finally { native.page.onEvent = onEvent; for (const deliver of held) deliver(); }
  assert(held.length === 1 && await native.evaluate("window.ackClicks") === 1, "Delayed binding acknowledgement overruled the actual native click consumer");
  console.log("Native click completion observed at the page despite a delayed CDP binding notification");
} finally { await native.close(); }
