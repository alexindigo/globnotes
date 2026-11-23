// Closing A's explicit binding must not close B or the retained fixture.
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { fixtureScope } from "./fixture-ownership.mjs";
import { runCase } from "./legacy-fixture.mjs";
import { assert } from "./test-outcomes.mjs";

// Export the bounded consumer so ordinary tests can fail each real acquisition.
// B encloses A: A's callback exit releases only A while B remains admitted.
export async function browserOwnershipControl(f, {
  port = Number(Deno.env.get("CDP_PORT") ?? 9335),
  launch = launchBrowser, connectPage = connect, stop = stopBrowser,
} = {}) {
  const events = [];
  // Issued identities establish ownership, not arrival in a shared roster.
  // Chrome's extension workers/UI have a lifecycle independent of our scopes.
  const targetIds = [f.session.targetId], contextIds = [f.session.browserContextId];
  const targets = async () => {
    const { targetInfos } = await f.session.browser.send("Target.getTargets");
    const { browserContextIds } = await f.session.browser.send("Target.getBrowserContexts");
    console.log(JSON.stringify({ type: "ownership-targets", targets: targetInfos.map(({ targetId, browserContextId, type, url }) => ({ targetId, browserContextId, type, url })), browserContextIds }));
    return {
      all: targetInfos.map(row => row.targetId).filter(id => targetIds.includes(id)).sort(),
      contexts: browserContextIds.filter(id => contextIds.includes(id)).sort(),
    };
  };
  const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  const note = async page => await page.poll(`(()=>{
    const viewer=document.querySelector('.toast-viewer');
    if(!viewer?.textContent.includes('Fixture readme'))return false;
    return {text:viewer.querySelector('p')?.textContent,href:location.href,secure:isSecureContext};
  })()`);
  const expectedNote = { text: "Fixture readme. #inbox", href: f.baseUrl + "/readme", secure: false };
  await f.session.goto(f.baseUrl + "/readme");
  const before = await targets();
  equal(before.all, targetIds, "Retained fixture target missing");
  equal(before.contexts, contextIds, "Retained fixture context missing");
  let result;
  await fixtureScope(async bScope => {
    f.ownScope(bScope);
    const bindingB = (await bScope.acquire(() => launch({ port }), async binding => {
      await stop(binding); events.push("binding:B:closed");
    })).value;
    events.push("binding:B:acquired");
    const b = (await bScope.acquire(() => connectPage({ binding: bindingB }), async page => {
      await page.close(); events.push("page:B:closed");
    })).value;
    targetIds.push(b.targetId); contextIds.push(b.browserContextId);
    events.push("page:B:acquired");
    await fixtureScope(async aScope => {
      f.ownScope(aScope);
      const bindingA = (await aScope.acquire(() => launch({ port }), async binding => {
        await stop(binding); events.push("binding:A:closed");
      })).value;
      events.push("binding:A:acquired");
      const a = (await aScope.acquire(() => connectPage({ binding: bindingA }), async page => {
        await page.close(); events.push("page:A:closed");
      })).value;
      targetIds.push(a.targetId); contextIds.push(a.browserContextId);
      events.push("page:A:acquired");
      await aScope.admit(() => a.goto(f.baseUrl + "/readme"));
      await bScope.admit(() => b.goto(f.baseUrl + "/readme"));
      await aScope.admit(() => a.evaluate("localStorage.setItem('ownership-canary','A');true"));
      const isolated = await bScope.admit(() => b.evaluate("localStorage.getItem('ownership-canary')===null"));
      assert(isolated.value === true, "Browser contexts share local storage");
      result = { closed: a.targetId, retainedConsumer: b.targetId, preservedTargets: before.all, isolatedStorage: true,
        ownedTargets: [a.targetId, b.targetId].sort(), ownedContexts: [a.browserContextId, b.browserContextId].sort() };
      const acquired = await targets();
      equal(acquired.all, [...targetIds].sort(), "Unexpected acquired page targets");
      equal(acquired.contexts, [...contextIds].sort(), "Unexpected acquired browser contexts");
    }, { report: () => { events.push("report:A"); } });
    const afterA = await targets();
    equal(afterA.all, [...before.all, b.targetId].sort(), "Binding teardown affected page ownership");
    equal(afterA.contexts, [...before.contexts, b.browserContextId].sort(), "Binding teardown affected context ownership");
    const retained = (await bScope.admit(() => note(b))).value;
    equal(retained, expectedNote, "B lost its rendered note");
    equal(await note(f.session), expectedNote, "Pre-existing target is unusable");
    events.push("retained:B:read", "preserved:read");
    result.retainedNote = retained;
  }, { report: () => { events.push("report:B"); } });
  const final = await targets(), finalTargets = final.all, finalContexts = final.contexts;
  equal(finalTargets, before.all, "Browser resources escaped their scopes");
  equal(finalContexts, before.contexts, "Browser contexts escaped their scopes");
  equal(events, [
    "binding:B:acquired", "page:B:acquired", "binding:A:acquired", "page:A:acquired",
    "report:A", "page:A:closed", "binding:A:closed", "retained:B:read", "preserved:read",
    "report:B", "page:B:closed", "binding:B:closed",
  ], "Unexpected browser resource events");
  return { ...result, events, finalTargets, finalContexts };
}

if (import.meta.main) await runCase("native-ownership-control", browserOwnershipControl);
