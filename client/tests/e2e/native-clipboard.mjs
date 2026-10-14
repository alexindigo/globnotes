// Clipboard snapshots remain guest-process memory only, never logs/artifacts.
export async function captureClipboard(page) {
  return page.evaluate("navigator.clipboard.read().then(items=>Promise.all(items.map(async item=>Promise.all([...item.types].sort().map(async type=>({type,bytes:[...new Uint8Array(await (await item.getType(type)).arrayBuffer())]}))))))");
}
export async function restoreClipboard(page, snapshot) {
  if (!snapshot.length) {
    await page.evaluate("navigator.clipboard.writeText('').then(()=>true)");
    if (await page.readClipboard() !== "") throw Error("Prior empty clipboard was not restored");
    return;
  }
  await page.evaluate(`navigator.clipboard.write(${JSON.stringify(snapshot)}.map(items=>new ClipboardItem(Object.fromEntries(items.map(({type,bytes})=>[type,new Blob([new Uint8Array(bytes)],{type})]))))).then(()=>true)`);
  if (JSON.stringify(await captureClipboard(page)) !== JSON.stringify(snapshot)) throw Error("Prior clipboard bytes were not restored");
}
