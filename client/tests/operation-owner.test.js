import { describe, expect, it } from "vitest";
import { createOperationOwner } from "../operationOwner.js";
import { OwnershipError } from "../../shared/ownership.js";
import { heldOperation } from "../../tests/helpers/owned_operation.ts";

const workflow = () => Object.freeze({});
const create = adapters => createOperationOwner({ owner: workflow(), dispatch: value => value, ...adapters });

describe("plain operation owner", () => {
  it("requires an immutable non-null owner and rejects forged/cross-owner handles through promises", async () => {
    for (const owner of [null, undefined, {}, "owner"]) {
      expect(() => create({ owner })).toThrow(new TypeError("Operation owner requires a non-null immutable workflow identity"));
    }
    const owner = create(), foreign = create();
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner.identity)).toBe(true);
    const operation = owner.operation();
    for (const handle of [null, {}, { ...operation }, foreign.operation()]) {
      const rejected = owner.dispatch(handle, "unsent");
      await expect(rejected).rejects.toEqual(new OwnershipError("Operation was not issued to this owner"));
    }
    expect(owner.hasWork()).toBe(false);
    expect((await owner.dispose()).errors).toEqual([]);
    expect((await foreign.dispose()).errors).toEqual([]);
  });

  it("binds adapters once with receivers and keeps owned values in handles", async () => {
    const calls = [], data = { then() { throw new Error("data was assimilated"); } };
    const adapters = { owner: workflow(), marker: "bound",
      dispatch(value) { calls.push([this.marker, value]); return { data }; },
      release(value) { calls.push([this.marker, value.data]); } };
    const owner = createOperationOwner(adapters);
    adapters.dispatch = () => { throw new Error("replacement transport"); };
    const operation = owner.operation();
    const result = await owner.dispatch(operation, "intent");
    expect(result.value.data).toBe(data);
    expect(calls).toEqual([["bound", "intent"]]);
    await owner.release(operation);
    expect(calls).toEqual([["bound", "intent"], ["bound", data]]);
    expect((await owner.dispose()).errors).toEqual([]);
  });

  it("fences queued dispatch and reentrant preparation without starting another transport", async () => {
    const calls = [];
    const owner = create({ dispatch: value => { calls.push(value); return value; } });
    const queued = owner.operation();
    owner.revoke();
    await expect(owner.dispatch(queued, "stale")).rejects.toEqual(new OwnershipError("Owner is retired"));
    expect(calls).toEqual([]);
    expect((await owner.dispose()).errors).toEqual([]);

    let preparedOwner;
    preparedOwner = create({ prepare() { preparedOwner.revoke(); return { value: "retired in prepare" }; },
      dispatch: value => calls.push(value) });
    await expect(preparedOwner.dispatch(preparedOwner.operation(), "intent")).rejects.toEqual(new OwnershipError("Owner is retired"));
    expect(calls).toEqual([]);
    expect((await preparedOwner.dispose()).errors).toEqual([]);
  });

  it("checks every event and completion after getter preparation, preserving the complete ordered cursor list", async () => {
    const events = [];
    let owner;
    owner = create({ channels: { event: {
      prepare: value => ({ value: value.event }),
      deliver(value) { events.push(value); if (value === "first") owner.revoke(); },
    } } });
    const operation = owner.operation();
    await owner.dispatch(operation, "wire");
    expect(owner.deliver(operation, "event", { event: "first" })).toBe(true);
    expect(owner.deliver(operation, "event", { event: "second" })).toBe(false);
    expect(owner.deliver(operation, "event", { event: "cursor" })).toBe(false);
    expect(events).toEqual(["first"]);
    expect((await owner.dispose()).errors).toEqual([]);

    let getterOwner, reads = 0;
    getterOwner = create({ channels: { event: {
      prepare: () => ({ get value() { reads++; getterOwner.revoke(); return "stale"; } }),
      deliver: value => events.push(value),
    } } });
    const getterOp = getterOwner.operation(); await getterOwner.dispatch(getterOp, "wire");
    expect(getterOwner.deliver(getterOp, "event", {})).toBe(false);
    expect([reads, events]).toEqual([1, ["first"]]);
    expect((await getterOwner.dispose()).errors).toEqual([]);
  });

  it("retained/outcome/recovery work accepts one matching completion, never live navigation or new dispatch", async () => {
    for (const mode of ["live", "retained", "outcome", "recovery"]) {
      const events = [];
      const owner = create({ completion: { deliver: value => events.push(["completed", value]) },
        channels: { navigate: { deliver: value => events.push(["navigate", value]) } } });
      const operation = owner.operation(mode);
      await owner.dispatch(operation, "original wire");
      owner.revoke();
      expect(owner.complete(operation, "matching")).toBe(mode !== "live");
      expect(owner.complete(operation, "duplicate")).toBe(false);
      expect(owner.deliver(operation, "navigate", "notes")).toBe(false);
      await expect(owner.dispatch(operation, "retry")).rejects.toEqual(new OwnershipError("Owner is retired"));
      expect(events).toEqual(mode === "live" ? [] : [["completed", "matching"]]);
      expect((await owner.dispose()).errors).toEqual([]);
    }
  });

  it("a retained pending wire stays accounted but cannot navigate a replacement sign-in", async () => {
    const events = [];
    let delivery, hold;
    const owner = create({ async dispatch(value, context) { delivery = context; events.push(["sent", value]); await hold(); return "original result"; },
      completion: { deliver: value => events.push(["complete", value]) },
      channels: { navigate: { deliver: value => events.push(["navigate", value]) } },
      release: value => events.push(["release", value]), cancel: () => events.push(["cancel"]) });
    const operation = owner.operation("retained");
    await heldOperation({ label: "original retained wire", owner: () => owner.identity, progress: { kind: "controlled", clock: "external" } },
      boundary => { hold = boundary; return owner.dispatch(operation, "original"); }, async original => {
    await original.reached();
    expect(owner.hasWork()).toBe(true);
    owner.revoke();
    expect(delivery.complete("ack")).toBe(true);
    const replacement = create();
    const close = owner.dispose();
    expect(owner.dispose()).toBe(close);
    expect(owner.hasWork()).toBe(true);
    expect(owner.complete(operation, "late")).toBe(false);
    expect(delivery.deliver("navigate", "replacement")).toBe(false);
    await expect(original.result()).rejects.toEqual(new OwnershipError("Owner is retired"));
    expect((await close).errors).toEqual([]);
    expect(owner.hasWork()).toBe(false);
    expect(events).toEqual([["sent", "original"], ["complete", "ack"], ["cancel"], ["release", "original result"]]);
    expect((await replacement.dispose()).errors).toEqual([]);
    });
  });

  it("retains the original rejection and all cleanup failures, awaiting each disposer result once", async () => {
    const primary = new Error("original wire"), first = new Error("first cleanup"), second = new Error("second cleanup");
    const calls = [];
    let hold;
    let thenReads = 0, thenCalls = 0;
    const owner = create({ async dispatch(value) { if (value === "pending") { await hold(); throw primary; } return value; },
      cancel() { calls.push("cancel"); throw second; },
      release(value) {
        calls.push(value);
        return { get then() { thenReads++; return function (yes, no) { thenCalls++; no(first); }; } };
      } });
    const acquired = owner.operation(); await owner.dispatch(acquired, "resource");
    await heldOperation({ label: "failed original wire", owner: () => owner.identity, progress: { kind: "controlled", clock: "external" } },
      boundary => { hold = boundary; return owner.dispatch(owner.operation(), "pending"); }, async original => {
    await original.reached();
    const settlement = owner.settle();
    const close = owner.dispose();
    await expect(original.result()).rejects.toBe(primary);
    const outcomes = await settlement;
    expect(outcomes).toEqual([{ status: "rejected", reason: primary }]);
    expect(outcomes[0].reason).toBe(primary);
    const report = await close;
    expect(report.errors).toEqual([first, second]);
    expect(report.errors[0]).toBe(first); expect(report.errors[1]).toBe(second);
    expect([calls, thenReads, thenCalls]).toEqual([["cancel", "resource"], 1, 1]);
    const aggregate = (() => { try { report.throwIfFailed(primary); } catch (error) { return error; } })();
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.cause).toBe(primary);
    expect(aggregate.errors).toEqual([primary, first, second]);
    });
  });

  it("does not inspect thenable data twice and fences reentrant completion before its callback", async () => {
    const events = [], value = { then() { throw new Error("data then"); } };
    let owner, reads = 0;
    owner = create({ completion: {
      prepare: data => ({ get then() { reads++; return undefined; }, value: data }),
      deliver(data) { events.push(data); expect(owner.complete(operation, "recursive")).toBe(false); },
    } });
    const operation = owner.operation("outcome"); await owner.dispatch(operation, "wire");
    owner.revoke(); expect(owner.complete(operation, value)).toBe(true);
    expect(events).toEqual([value]); expect(events[0]).toBe(value); expect(reads).toBe(1);
    expect((await owner.dispose()).errors).toEqual([]);
  });

  it("owns rollback when transport synchronously releases its own operation", async () => {
    const events = [];
    let owner, released;
    owner = create({ dispatch(value, context) { events.push(["dispatch", value]); released = owner.release(context.operation); return "resource"; },
      release: value => events.push(["release", value]) });
    await expect(owner.dispatch(owner.operation(), "intent")).rejects.toEqual(new OwnershipError("Owner is retired"));
    await released;
    expect(events).toEqual([["dispatch", "intent"], ["release", "resource"]]);
    expect((await owner.dispose()).errors).toEqual([]);
  });

  it("accounts the original join before synchronous transport observation", async () => {
    let owner, observed, pending;
    owner = create({ dispatch(value) { pending = owner.hasWork(); observed = owner.settle(); return value; } });
    const result = await owner.dispatch(owner.operation(), "original");
    expect(pending).toBe(true);
    const outcomes = await observed;
    expect(outcomes).toEqual([{ status: "fulfilled", value: result }]);
    expect(outcomes[0].value).toBe(result);
    expect(result.value).toBe("original");
    expect((await owner.dispose()).errors).toEqual([]);
  });

  it("attempts every resource in reverse order and caches disposal before reentrant cleanup", async () => {
    const events = [], errors = [new Error("first"), new Error("second"), new Error("third")];
    let owner, reentrant;
    owner = create({ release(value) { events.push(value); reentrant = owner.dispose(); throw errors[value]; } });
    for (const value of [0, 1, 2]) await owner.dispatch(owner.operation(), value);
    const close = owner.dispose();
    const report = await close;
    expect(reentrant).toBe(close); expect(owner.dispose()).toBe(close);
    expect(events).toEqual([2, 1, 0]);
    expect(report.errors).toEqual([errors[2], errors[1], errors[0]]);
    report.errors.forEach((error, index) => expect(error).toBe(errors[2 - index]));
  });

  it("preserves exact synchronous delivery errors and rejects invalid/reused operations once", async () => {
    const original = new Error("consumer failure");
    const owner = create({ channels: { event: { deliver() { throw original; } } } });
    const operation = owner.operation(); await owner.dispatch(operation, "wire");
    let failure;
    try { owner.deliver(operation, "event", "value"); } catch (error) { failure = error; }
    expect(failure).toBe(original);
    await expect(owner.dispatch(operation, "duplicate")).rejects.toEqual(new OwnershipError("Operation has already been dispatched or released"));
    await expect(owner.release({ ...operation })).rejects.toEqual(new OwnershipError("Operation was not issued to this owner"));
    expect((await owner.dispose()).errors).toEqual([]);
  });

  it("recovery outlives a released stream but not replacement of the credential attempt", async () => {
    const events = [];
    const owner = create({ release: value => events.push(["release", value]),
      channels: { event: { deliver: value => events.push(["event", value]) } },
      completion: { deliver: value => events.push(["recovery", value]) } });
    const stream = owner.operation(), recovery = owner.operation("recovery"), replaced = owner.operation("recovery");
    await owner.dispatch(stream, "stream"); await owner.dispatch(recovery, "recovery"); await owner.dispatch(replaced, "replacement-fenced");
    expect(owner.deliver(stream, "event", "current")).toBe(true);
    await owner.release(stream);
    expect(owner.deliver(stream, "event", "stale")).toBe(false);
    expect(owner.complete(recovery, "original completion")).toBe(true);
    expect((await owner.dispose()).errors).toEqual([]);
    expect(owner.complete(replaced, "late replacement")).toBe(false);
    expect(events).toEqual([["event", "current"], ["release", "stream"], ["recovery", "original completion"],
      ["release", "replacement-fenced"], ["release", "recovery"]]);
  });
});
