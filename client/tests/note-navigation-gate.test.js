import { describe, expect, it } from "vitest";
import { decideNavigation, noteResourceIdentity } from "../noteNavigationGate.js";

const line = { from: 2, to: 4 };
const allow = { type: "allow" };
const exit = { type: "exit-edit" };
const prompt = { type: "prompt" };
const settle = { type: "settle" };
const block = { type: "block" };
const enterSource = { type: "enter-edit", mode: "markdown", line };
const syncSource = { type: "sync-editor", mode: "markdown", line };
const enterWys = { type: "enter-edit", mode: "wysiwyg", line: null };
const syncWys = { type: "sync-editor", mode: "wysiwyg", line: null };
const view = { type: "view-line", line };

function state(overrides = {}) {
  return {
    ownerId: "owner", sessionId: "session", activeSubmissionId: 3,
    resourceIdentity: noteResourceIdentity("Folder/Note", {}),
    editMode: false, editorMode: "markdown", canModify: true, dirty: false,
    queue: { unresolved: false, status: "idle", canDiscard: true },
    acknowledgementTransition: null,
    ...overrides,
  };
}

function destination(name, path, hash = "", query = {}) {
  return { name, params: { path }, hash, query, fullPath: `/${path ?? "_"}${hash}` };
}

// Explicit route/owner decision table. Columns are viewing, clean editing,
// dirty idle, preparing, sending, paused discardable, paused unknown.
const rows = [
  ["same note source", "Folder/Note", destination("note", "Folder/Note", "#source:L2-4"), [enterSource, syncSource, syncSource, syncSource, syncSource, syncSource, syncSource]],
  ["same note edit", "Folder/Note", destination("note", "Folder/Note", "#edit"), [enterWys, syncWys, syncWys, syncWys, syncWys, syncWys, syncWys]],
  ["same note view", "Folder/Note", destination("note", "Folder/Note", "#view:L2-4"), [view, exit, prompt, settle, settle, prompt, block]],
  ["same note no fragment", "Folder/Note", destination("note", "Folder/Note"), [allow, exit, prompt, settle, settle, prompt, block]],
  ["same note unknown fragment", "Folder/Note", destination("note", "Folder/Note", "#other"), [allow, exit, prompt, settle, settle, prompt, block]],
  ["same note query-only source", "Folder/Note", destination("note", "Folder/Note", "#source:L2-4", { path: "ignored", folder: "ignored" }), [enterSource, syncSource, syncSource, syncSource, syncSource, syncSource, syncSource]],
  ["different note source", "Folder/Note", destination("note", "Other", "#source:L2-4"), [allow, exit, prompt, settle, settle, prompt, block]],
  ["different note view", "Folder/Note", destination("note", "Other", "#view:L2-4"), [view, exit, prompt, settle, settle, prompt, block]],
  ["other route", "Folder/Note", destination("home", undefined), [allow, exit, prompt, settle, settle, prompt, block]],
  ["other route view", "Folder/Note", destination("home", undefined, "#view:L2-4"), [view, exit, prompt, settle, settle, prompt, block]],
  ["note to new", "Folder/Note", destination("new", undefined, "#source:L2-4"), [allow, exit, prompt, settle, settle, prompt, block]],
  ["same blank new note", null, destination("new", undefined), [allow, allow, allow, allow, allow, allow, allow]],
  ["same new note view fragment", null, destination("new", undefined, "#view:L2-4"), [view, allow, allow, allow, allow, allow, allow]],
  ["changed new title", null, destination("new", undefined, "", { path: "Second" }), [allow, exit, prompt, settle, settle, prompt, block]],
  ["changed new folder", null, destination("new", undefined, "#source", { folder: "target" }), [allow, exit, prompt, settle, settle, prompt, block]],
  ["new to note", null, destination("note", "Folder/Note", "#edit"), [allow, exit, prompt, settle, settle, prompt, block]],
];
const contexts = [
  ["viewing", {}],
  ["clean edit", { editMode: true }],
  ["dirty idle", { editMode: true, dirty: true }],
  ["preparing", { editMode: true, dirty: true, queue: { unresolved: true, status: "preparing", canDiscard: false } }],
  ["sending", { editMode: true, dirty: true, queue: { unresolved: true, status: "sending", canDiscard: false } }],
  ["paused known", { editMode: true, dirty: true, queue: { unresolved: true, status: "paused", canDiscard: true } }],
  ["paused unknown", { editMode: true, dirty: true, queue: { unresolved: true, status: "paused", canDiscard: false } }],
];

describe("navigation decision table", () => {
  for (const [label, path, to, actions] of rows) {
    it.each(contexts.map(([context, values], i) => [context, values, actions[i]]))(`${label} while %s`, (_, values, expected) => {
      const current = state({ resourceIdentity: noteResourceIdentity(path, {}), ...values });
      const before = JSON.stringify({ current, to });
      expect(decideNavigation(current, to)).toEqual(expected);
      expect(JSON.stringify({ current, to })).toBe(before);
    });
  }

  it.each(["markdown", "wysiwyg", "preview"])("source URLs align a %s editor without losing preview", editorMode => {
    expect(decideNavigation(state({ editMode: true, dirty: true, editorMode }), destination("note", "Folder/Note", "#source:L2-4")))
      .toEqual({ type: "sync-editor", mode: editorMode === "preview" ? "preview" : "markdown", line });
    expect(decideNavigation(state({ editMode: true, editorMode }), destination("note", "Folder/Note", "#edit"))).toEqual(syncWys);
  });

  it.each(["#source:L2-4", "#edit", "#view:L2-4", "#view", ""])("read-only viewing handles %s without edit entry", hash => {
    expect(decideNavigation(state({ canModify: false }), destination("note", "Folder/Note", hash)))
      .toEqual(hash.startsWith("#view") ? { type: "view-line", line: hash === "#view" ? null : line } : allow);
  });

  it("read-only policy does not alter an existing edit-state URL transition", () => {
    expect(decideNavigation(state({ editMode: true, canModify: false }), destination("note", "Folder/Note", "#edit"))).toEqual(syncWys);
  });

  it.each(["preparing", "sending", "paused"])("unresolved %s work is protected even outside edit mode", status => {
    const current = state({ dirty: true, queue: { unresolved: true, status, canDiscard: false } });
    expect(decideNavigation(current, destination("note", "Other"))).toEqual(status === "paused" ? block : settle);
    expect(decideNavigation(current, destination("note", "Folder/Note", "#edit"))).toEqual(syncWys);
  });

  it.each([true, false])("in-flight saves settle before a dirty exit regardless of discardability=%s", canDiscard => {
    for (const status of ["preparing", "sending"]) {
      expect(decideNavigation(state({ editMode: true, dirty: true, queue: { status, canDiscard, unresolved: true } }), destination("home"))).toEqual(settle);
    }
  });

  it("same explicit new-note identity ignores unrelated queries and fragments", () => {
    const current = state({ editMode: true, dirty: true, resourceIdentity: noteResourceIdentity(null, { path: "First", folder: "target" }) });
    expect(decideNavigation(current, destination("new", undefined, "#edit", { path: "First", folder: "target", ignored: "yes" }))).toEqual(allow);
    expect(decideNavigation(current, destination("new", undefined, "#edit", { path: "First", folder: "different" }))).toEqual(prompt);
  });
});

describe("acknowledgement navigation authority", () => {
  const to = destination("note", "Canonical", "#source:L2-4");
  const transition = { ownerId: "owner", sessionId: "session", submissionId: 3, fullPath: to.fullPath, path: "Canonical", guardConsumed: false, nonce: "nonce" };

  it("the exact active submission bypasses the dirty different-resource gate without consuming state", () => {
    const current = state({ editMode: true, dirty: true, acknowledgementTransition: Object.freeze({ ...transition }) });
    expect(decideNavigation(current, to)).toEqual({ type: "acknowledge" });
    expect(current.acknowledgementTransition.guardConsumed).toBe(false);
  });

  it.each([
    ["already consumed", { guardConsumed: true }],
    ["different owner", { ownerId: "other" }],
    ["different session", { sessionId: "other" }],
    ["different submission", { submissionId: 4 }],
    ["different full URL", { fullPath: "/Canonical#edit" }],
  ])("%s token cannot bypass the dirty gate", (_, override) => {
    expect(decideNavigation(state({ editMode: true, dirty: true, acknowledgementTransition: { ...transition, ...override } }), to)).toEqual(prompt);
  });

  it("missing save ownership cannot borrow an acknowledgement", () => {
    expect(decideNavigation(state({ editMode: true, dirty: true, sessionId: undefined, activeSubmissionId: undefined, acknowledgementTransition: transition }), to)).toEqual(prompt);
  });
});

describe("logical note resources", () => {
  it("existing paths ignore query intent, but preserve literal path identity", () => {
    expect(noteResourceIdentity("A/B", { path: "other", folder: "other" })).toBe(noteResourceIdentity("A/B", {}));
    expect(noteResourceIdentity("A/B", {})).not.toBe(noteResourceIdentity("A%2FB", {}));
  });
  it("new resources normalize absent intent, distinguish folders/titles and remain separate from existing notes", () => {
    expect(noteResourceIdentity(null, {})).toBe(noteResourceIdentity(undefined, { path: "", folder: "" }));
    expect(noteResourceIdentity(null, { path: "A", folder: "B" })).not.toBe(noteResourceIdentity(null, { path: "B", folder: "A" }));
    expect(noteResourceIdentity(null, { path: "A" })).not.toBe(noteResourceIdentity("A", {}));
  });
});
