import { afterEach, expect, it } from "vitest";
import { createPagePoll, createPageRead } from "./native-cdp-session.mjs";

afterEach(() => { document.body.innerHTML = ""; });
const run = expression => Function(`return (${expression})`)();

it("waits for the owning DOM and captures the snapshot in that same expression", async () => {
  let probes = 0;
  const read = createPageRead(createPagePoll(async expression => {
    probes++;
    const result = run(expression);
    if (probes === 1) document.body.innerHTML = '<article id="result"><b>ready</b></article>';
    return result;
  }));
  const result = await read("#result b", "({text:document.querySelector('#result').querySelector('b').textContent})");
  expect(result).toEqual({ text: "ready" });
  expect(probes).toBe(2);
});

it("preserves false, zero and null observations rather than waiting for them to pass", async () => {
  document.body.innerHTML = '<article id="result"></article>';
  for (const expression of ["false", "0", "null"]) {
    let probes = 0;
    const read = createPageRead(createPagePoll(async source => { probes++; return run(source); }));
    expect(await read("#result", expression)).toBe(run(expression));
    expect(probes).toBe(1);
  }
});

it("does not hide exceptions or permit an asynchronous snapshot after admission", async () => {
  const read = createPageRead(createPagePoll(async expression => run(expression)));
  await expect(read("body", "(()=>{throw Error('broken consumer');})()")).rejects.toThrow("broken consumer");
  await expect(read("body", "Promise.resolve(1)")).rejects.toThrow("must be synchronous");
  await expect(read([], "1")).rejects.toThrow("owning selectors");
});
