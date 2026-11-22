// Closing A's explicit binding must not close B or any pre-existing target.
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
  const targets = async () => {
    const { targetInfos } = await f.session.browser.send("Target.getTargets");
    console.log(JSON.stringify({ type: "ownership-targets", targets: targetInfos.map(({ targetId, type, url }) => ({ targetId, type, url })) }));
    return {
      all: targetInfos.map(row => row.targetId).sort(),
      pages: targetInfos.filter(row => row.type === "page").map(row => row.targetId).sort(),
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
  let result;
  await fixtureScope(async bScope => {
    const bindingB = (await bScope.acquire(() => launch({ port }), async binding => {
      await stop(binding); events.push("binding:B:closed");
    })).value;
    events.push("binding:B:acquired");
    const b = (await bScope.acquire(() => connectPage({ binding: bindingB }), async page => {
      await page.close(); events.push("page:B:closed");
    })).value;
    events.push("page:B:acquired");
    await fixtureScope(async aScope => {
      const bindingA = (await aScope.acquire(() => launch({ port }), async binding => {
        await stop(binding); events.push("binding:A:closed");
      })).value;
      events.push("binding:A:acquired");
      const a = (await aScope.acquire(() => connectPage({ binding: bindingA }), async page => {
        await page.close(); events.push("page:A:closed");
      })).value;
      events.push("page:A:acquired");
      await aScope.admit(() => a.goto(f.baseUrl + "/readme"));
      await bScope.admit(() => b.goto(f.baseUrl + "/readme"));
      await aScope.admit(() => a.evaluate("localStorage.setItem('ownership-canary','A');true"));
      const isolated = await bScope.admit(() => b.evaluate("localStorage.getItem('ownership-canary')===null"));
      assert(isolated.value === true, "Browser contexts share local storage");
      result = { closed: a.targetId, retainedConsumer: b.targetId, preservedTargets: before.all, isolatedStorage: true };
      equal((await targets()).pages, [...before.pages, a.targetId, b.targetId].sort(), "Unexpected acquired page targets");
    }, { report: () => { events.push("report:A"); } });
    const afterA = await targets();
    equal(afterA.pages, [...before.pages, b.targetId].sort(), "Binding teardown affected another page owner");
    equal(afterA.all.filter(id => before.all.includes(id)), before.all, "Binding teardown affected a pre-existing target");
    const retained = (await bScope.admit(() => note(b))).value;
    equal(retained, expectedNote, "B lost its rendered note");
    equal(await note(f.session), expectedNote, "Pre-existing target is unusable");
    events.push("retained:B:read", "preserved:read");
    result.retainedNote = retained;
  }, { report: () => { events.push("report:B"); } });
  const finalTargets = (await targets()).all;
  equal(finalTargets, before.all, "Browser resources escaped their scopes");
  equal(events, [
    "binding:B:acquired", "page:B:acquired", "binding:A:acquired", "page:A:acquired",
    "report:A", "page:A:closed", "binding:A:closed", "retained:B:read", "preserved:read",
    "report:B", "page:B:closed", "binding:B:closed",
  ], "Unexpected browser resource events");
  return { ...result, events, finalTargets };
}

if (import.meta.main) await runCase("native-ownership-control", browserOwnershipControl);
