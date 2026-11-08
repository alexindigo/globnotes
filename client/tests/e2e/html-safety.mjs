import { runCase } from "./legacy-fixture.mjs";
import { assert } from "./test-outcomes.mjs";

await runCase("html-safety", async f => {
  const payload = '<img src=x onerror="window.noteXss=(window.noteXss||0)+1"><script>window.noteXss=99</script>';
  const content = `---\ntitle: '${payload}'\n---\n\nneedleprobe ${payload}\n\n<strong>safe formatting</strong>\n`;
  assert((await f.api("notes", "POST", { path: "html-safety", content })).status === 200, "Note fixture failed");
  await f.page.goto(f.baseUrl + "/_/search?term=needleprobe");
  const search = await f.page.read('.content-column a[href="/html-safety"] b.match', `(()=>{const row=document.querySelector('.content-column a[href="/html-safety"]'),mark=row.querySelector('b.match'),rect=mark.getBoundingClientRect();return{text:row.textContent,unsafe:row.querySelectorAll('img,script,[onerror]').length,executions:window.noteXss||0,highlight:mark.textContent,visible:rect.width>0&&rect.height>0};})()`);
  assert(search.unsafe === 0 && search.executions === 0, "Search interpreted note markup: " + JSON.stringify(search));
  assert(search.text.includes(payload) && search.highlight === "needleprobe" && search.visible, "Search lost literal note text or visible highlights");
  await f.page.goto(f.baseUrl + "/html-safety");
  const observe = selector => f.page.read(selector+' strong', `(()=>{const root=document.querySelector(${JSON.stringify(selector)});return{unsafe:root.querySelectorAll('script,[onerror],[onload],[href^="javascript:"]').length,executions:window.noteXss||0,formatting:root.querySelector('strong')?.textContent};})()`);
  const saved = await observe(".toast-viewer");
  assert(saved.unsafe === 0 && saved.executions === 0 && saved.formatting === "safe formatting", "Saved note safety/formatting differs: " + JSON.stringify(saved));
  await f.page.button("Edit", ".content-column");
  await f.page.button("Source", ".content-column");
  await f.page.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await f.page.click('.cm-content[contenteditable=true]');
  await f.page.send("Input.insertText", { text: "previewprobe " });
  await f.page.button("Preview", ".content-column");
  const preview = await observe(".preview-buffer");
  assert(preview.unsafe === 0 && preview.executions === 0 && preview.formatting === "safe formatting", "Preview safety/formatting differs: " + JSON.stringify(preview));
  return { search, saved, preview };
}, { empty: true });
