// Closing A's explicit binding must not close B or any pre-existing target.
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { runCase } from "./legacy-fixture.mjs";
import { assert } from "./test-outcomes.mjs";
await runCase("native-ownership-control", async f => {
  const port = Number(Deno.env.get("CDP_PORT") ?? 9335);
  const before = (await f.session.browser.send("Target.getTargets")).targetInfos.map(row => row.targetId);
  const bindingA = await launchBrowser({ port }), bindingB = await launchBrowser({ port });
  let a, b;
  try {
    a = await connect({ binding: bindingA }); b = await connect({ binding: bindingB });
    await a.goto(f.baseUrl + "/readme"); await b.goto(f.baseUrl + "/readme");
    await a.evaluate("localStorage.setItem('ownership-canary','A');true");
    assert(await b.evaluate("localStorage.getItem('ownership-canary')===null"), "Browser contexts share local storage");
    await stopBrowser(bindingA);
    await b.poll("document.querySelector('.toast-viewer')?.textContent.includes('Fixture readme')");
    const after = (await b.browser.send("Target.getTargets")).targetInfos.map(row => row.targetId);
    assert(!after.includes(a.targetId) && after.includes(b.targetId) && before.every(id => after.includes(id)), "Binding teardown affected another owner");
    return { closed: a.targetId, retainedConsumer: b.targetId, preservedTargets: before, isolatedStorage: true };
  } finally {
    await a?.close(); await stopBrowser(bindingB);
  }
});
