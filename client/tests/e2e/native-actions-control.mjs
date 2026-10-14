// Real pointer consumers: containers cannot substitute for controls, and only
// the topmost modal owns a named action when labels occur in multiple places.
import { connect } from "./cdp.mjs";
import { assert } from "./test-outcomes.mjs";
const page = await connect({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
try {
  await page.goto("about:blank");
  await page.evaluate("(()=>{document.body.innerHTML='<div style=\"width:800px;height:80px\"><button>Delete</button></div>';window.actionCount=0;document.querySelector('button').onclick=()=>window.actionCount++;return true;})()");
  await page.clickText("Delete");
  assert(await page.evaluate("window.actionCount===1&&document.querySelector('[data-cdp-click-target]').tagName==='BUTTON'"), "Named native action missed its actual control");
  await page.evaluate("(()=>{document.body.innerHTML='<button id=background>Delete</button><div data-modal-top=true style=\"margin-top:80px\"><button id=modal>Delete</button></div>';window.backgroundCount=0;window.modalCount=0;document.querySelector('#background').onclick=()=>window.backgroundCount++;document.querySelector('#modal').onclick=()=>window.modalCount++;return true;})()");
  await page.clickText("Delete");
  assert(await page.evaluate("window.backgroundCount===0&&window.modalCount===1"), "Named action reached a background control");
  console.log("Native pointer controls reached their actual topmost owners");
} finally { await page.close(); }
