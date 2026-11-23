import { expect, it, vi } from "vitest";
import { fixtureScope } from "./fixture-ownership.mjs";
import { fixtureScope as tsFixtureScope } from "../../../tests/helpers/fixture_scope.ts";
import { browserOwnershipControl } from "./native-ownership-control.mjs";
import { createNativeCaseLifetime } from "./native-case-finalization.mjs";

// Browser acquisition is injected at the pilot's normal adapter boundary.
vi.mock("./legacy-fixture.mjs", () => ({ runCase: vi.fn() }));
vi.mock("./cdp.mjs", () => ({ connect: vi.fn(), launchBrowser: vi.fn(), stopBrowser: vi.fn() }));

function fixture({ fail = "", closeFailures = [], browserUi = false, managedChurn = false, leakedPage = "", leakedContext = "", lostPreserved = "" } = {}) {
  const events = [], active = ["pre-existing"], contexts = ["context:pre-existing"], bindings = [];
  const ui = browserUi ? ["pre-existing-ui"] : [];
  const workers = [], peers = [];
  const lifetime = createNativeCaseLifetime(() => events.push("fixture:closed"));
  const primary = new Error(`failed ${fail}`);
  const note = { text: "Fixture readme. #inbox", href: "http://globnotes.test:9000/readme", secure: false };
  const allocate = name => { events.push(name); if (name === fail) throw primary; };
  const release = name => { events.push(name); const error = closeFailures.find(row => row.name === name); if (error) throw error; };
  const session = {
    targetId: "pre-existing", browserContextId: "context:pre-existing",
    browser: { async send(method) {
      if (method === "Target.getBrowserContexts") return { browserContextIds: [...contexts] };
      expect(method).toBe("Target.getTargets");
      return { targetInfos: [
        ...active.map(targetId => ({ targetId, type: "page", browserContextId: `context:${targetId}` })),
        ...ui.map(targetId => ({ targetId, type: "browser_ui" })),
        ...workers.map(targetId => ({ targetId, type: "service_worker", url: "chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/thunk.js" })),
        ...peers.map(targetId => ({ targetId, type: "page", browserContextId: "unrelated-context" })),
      ] };
    } },
    goto: async () => { events.push("pre-existing:goto"); },
    poll: async () => { events.push("pre-existing:read"); return note; },
  };
  const adapters = {
    port: 9335,
    launch() {
      const label = bindings.length ? "A" : "B";
      allocate(`binding:${label}`);
      const binding = { label };
      bindings.push(binding);
      if (browserUi) ui.push(`ui:${label}`);
      return binding;
    },
    connectPage({ binding }) {
      const { label } = binding;
      allocate(`page:${label}`);
      active.push(label);
      contexts.push(`context:${label}`);
      if (label === "B") {
        if (managedChurn === "worker") workers.push("browser-managed-worker");
        if (managedChurn === "page") peers.push("unrelated-page");
        if (managedChurn === "ui") ui.splice(0);
      }
      return {
        targetId: label, browserContextId: `context:${label}`,
        async goto() { events.push(`goto:${label}`); },
        async evaluate() { events.push(`storage:${label}`); return true; },
        async poll() { events.push(`read:${label}`); return note; },
        async close() {
          if (leakedPage !== label) active.splice(active.indexOf(label), 1);
          if (leakedContext !== label) contexts.splice(contexts.indexOf(`context:${label}`), 1);
          if (label === "A" && lostPreserved === "page") active.splice(active.indexOf("pre-existing"), 1);
          if (label === "A" && lostPreserved === "context") contexts.splice(contexts.indexOf("context:pre-existing"), 1);
          release(`close:page:${label}`);
        },
      };
    },
    stop(binding) {
      if (browserUi) ui.splice(ui.indexOf(`ui:${binding.label}`), 1);
      release(`close:binding:${binding.label}`);
    },
  };
  return { f: { session, baseUrl: "http://globnotes.test:9000", ownScope: lifetime.ownScope }, adapters, events, active, contexts, primary, note };
}

it("exports the same callback scope, not another native cleanup engine", async () => {
  expect(fixtureScope).toBe(tsFixtureScope);
  const value = {}, disposed = vi.fn();
  await fixtureScope(async scope => {
    const owned = await scope.acquire(() => value, disposed);
    expect(owned.value).toBe(value);
  });
  expect(disposed.mock.calls).toEqual([[value]]);
});

it("the actual A/B pilot closes A alone, then B, with exact targets and events", async () => {
  const test = fixture();
  const result = await browserOwnershipControl(test.f, test.adapters);
  expect(result).toEqual({
    closed: "A", retainedConsumer: "B", preservedTargets: ["pre-existing"], isolatedStorage: true,
    retainedNote: test.note, finalTargets: ["pre-existing"],
    ownedTargets: ["A", "B"], ownedContexts: ["context:A", "context:B"], finalContexts: ["context:pre-existing"],
    events: ["binding:B:acquired", "page:B:acquired", "binding:A:acquired", "page:A:acquired", "report:A", "page:A:closed", "binding:A:closed", "retained:B:read", "preserved:read", "report:B", "page:B:closed", "binding:B:closed"],
  });
  expect(test.events).toEqual(["pre-existing:goto", "binding:B", "page:B", "binding:A", "page:A", "goto:A", "goto:B", "storage:A", "storage:B", "close:page:A", "close:binding:A", "read:B", "pre-existing:read", "close:page:B", "close:binding:B"]);
  expect(test.active).toEqual(["pre-existing"]);
});

it("checks explicit resource identities rather than browser-managed UI targets", async () => {
  const test = fixture({ browserUi: true });
  const result = await browserOwnershipControl(test.f, test.adapters);
  expect(result.preservedTargets).toEqual(["pre-existing"]);
  expect(result.finalTargets).toEqual(["pre-existing"]);
  expect(result.finalContexts).toEqual(["context:pre-existing"]);
  expect(result.retainedNote).toBe(test.note);
});

for (const kind of ["worker", "ui", "page"]) {
  it(`does not claim unrelated ${kind} target churn`, async () => {
    const test = fixture({ browserUi: true, managedChurn: kind });
    const result = await browserOwnershipControl(test.f, test.adapters);
    expect(result.finalTargets).toEqual(["pre-existing"]);
    expect(result.finalContexts).toEqual(["context:pre-existing"]);
    expect(result.retainedNote).toBe(test.note);
    expect(test.active).toEqual(["pre-existing"]);
  });
}

for (const label of ["A", "B"]) {
  it(`rejects a leaked explicitly acquired ${label} page`, async () => {
    const test = fixture({ leakedPage: label });
    const error = await browserOwnershipControl(test.f, test.adapters).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(label === "A"
      ? 'Binding teardown affected page ownership: expected ["B","pre-existing"], observed ["A","B","pre-existing"]'
      : 'Browser resources escaped their scopes: expected ["pre-existing"], observed ["B","pre-existing"]');
  });
  it(`rejects a leaked explicitly acquired ${label} context even without a page`, async () => {
    const test = fixture({ leakedContext: label });
    const error = await browserOwnershipControl(test.f, test.adapters).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(label === "A"
      ? 'Binding teardown affected context ownership: expected ["context:B","context:pre-existing"], observed ["context:A","context:B","context:pre-existing"]'
      : 'Browser contexts escaped their scopes: expected ["context:pre-existing"], observed ["context:B","context:pre-existing"]');
    expect(test.active).toEqual(["pre-existing"]);
  });
}

for (const kind of ["page", "context"]) {
  it(`rejects loss of the explicitly preserved ${kind}`, async () => {
    const test = fixture({ lostPreserved: kind });
    const error = await browserOwnershipControl(test.f, test.adapters).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(kind === "page"
      ? 'Binding teardown affected page ownership: expected ["B","pre-existing"], observed ["B"]'
      : 'Binding teardown affected context ownership: expected ["context:B","context:pre-existing"], observed ["context:B"]');
  });
}

for (const [fail, expected] of [
  ["binding:B", ["binding:B"]],
  ["page:B", ["binding:B", "page:B", "close:binding:B"]],
  ["binding:A", ["binding:B", "page:B", "binding:A", "close:page:B", "close:binding:B"]],
  ["page:A", ["binding:B", "page:B", "binding:A", "page:A", "close:binding:A", "close:page:B", "close:binding:B"]],
]) {
  it(`cleans every earlier allocation when the actual pilot fails ${fail}`, async () => {
    const test = fixture({ fail });
    const error = await browserOwnershipControl(test.f, test.adapters).catch(error => error);
    expect(error).toBe(test.primary);
    expect(error.message).toBe(`failed ${fail}`);
    expect(test.events).toEqual(["pre-existing:goto", ...expected]);
    expect(test.active).toEqual(["pre-existing"]);
  });
}

for (const name of ["close:page:A", "close:binding:A", "close:page:B", "close:binding:B"]) {
  it(`attempts all remaining pilot cleanup after ${name} fails`, async () => {
    const failure = Object.assign(new Error(name), { name });
    const test = fixture({ closeFailures: [failure] });
    const error = await browserOwnershipControl(test.f, test.adapters).catch(error => error);
    expect(error).toBe(failure);
    const middle = name.endsWith(":B") ? ["read:B", "pre-existing:read"] : [];
    expect(test.events).toEqual(["pre-existing:goto", "binding:B", "page:B", "binding:A", "page:A", "goto:A", "goto:B", "storage:A", "storage:B", "close:page:A", "close:binding:A", ...middle, "close:page:B", "close:binding:B"]);
    expect(test.active).toEqual(["pre-existing"]);
  });
}

it("reports before release and preserves original and all finalization error identities", async () => {
  const primary = new Error("body"), report = new Error("report"), page = new Error("page"), binding = new Error("binding");
  const events = [];
  const error = await fixtureScope(scope => {
    scope.defer(() => { events.push("binding"); throw binding; });
    scope.defer(() => { events.push("page"); throw page; });
    throw primary;
  }, { report: () => { events.push("report"); throw report; } }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.message).toBe("Owned resource release failed");
  expect(error.cause).toBe(primary);
  expect(error.errors[0]).toBe(primary);
  expect(error.errors[1]).toBe(report);
  expect(error.errors[2].errors).toEqual([page, binding]);
  expect(error.errors[2].errors[0]).toBe(page);
  expect(error.errors[2].errors[1]).toBe(binding);
  expect(events).toEqual(["report", "page", "binding"]);
});

it("the actual pilot retains a failed allocation plus all nested scope cleanup failures", async () => {
  const failures = ["close:binding:A", "close:page:B", "close:binding:B"].map(name => Object.assign(new Error(name), { name }));
  const test = fixture({ fail: "page:A", closeFailures: failures });
  const error = await browserOwnershipControl(test.f, test.adapters).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.message).toBe("Owned resource release failed");
  expect(error.cause).toBe(error.errors[0]);
  expect(error.errors[0].cause).toBe(test.primary);
  expect(error.errors[0].errors).toEqual([test.primary, failures[0]]);
  expect(error.errors[0].errors[0]).toBe(test.primary);
  expect(error.errors[0].errors[1]).toBe(failures[0]);
  expect(error.errors[1].errors).toEqual([failures[1], failures[2]]);
  expect(error.errors[1].errors[0]).toBe(failures[1]);
  expect(error.errors[1].errors[1]).toBe(failures[2]);
  expect(test.events).toEqual(["pre-existing:goto", "binding:B", "page:B", "binding:A", "page:A", "close:binding:A", "close:page:B", "close:binding:B"]);
  expect(test.active).toEqual(["pre-existing"]);
});
