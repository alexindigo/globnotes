// SPDX-License-Identifier: LGPL-3.0-only

/** Async guarded operation facade — the ONLY application mutation entry
 * point. FileSystemNotes keeps its synchronous low-level methods as
 * internal host storage APIs; endpoints and plugin action adapters await
 * this facade. Steps follow plan §3.3: authorize → prepare (no effects) →
 * ordered pre-hooks → short policy/commit gate with epoch + signature
 * revalidation → commit through storage → post-fact admission → result. */

import * as path from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { HttpError } from "@pathfinder/pathfinder";
import type { FileServing } from "../files/file_serving.ts";
import type { Indexer } from "../state.ts";
import type { VaultHub } from "../hub/hub.ts";
import { noteVersion, versionOf } from "../hub/merge.ts";
import {
  assertExpected,
  NoteChangedError,
  type NoteExpectation,
} from "./expectation.ts";
import { guessType } from "../files/mimetypes.ts";
import { FileSystemNotes, type StorageEffect } from "./file_system.ts";
import {
  type Base,
  checkBase,
  conflictCopyPath,
  type Displacement,
  HubGate,
  occupied,
  type OnStale,
} from "../hub/gate.ts";
import type { OfferOutcome } from "../hub/versioning.ts";
import {
  type Note,
  type NoteCreate,
  NoteNotFoundError,
  type NoteUpdate,
} from "./models.ts";
import { PLUGIN_LIMITS } from "../plugins/contracts.ts";
import type {
  HookName,
  JsonValues,
  NoteSnapshot,
  OperationAction,
  OperationFact,
} from "../plugins/contracts.ts";
import { baseRequired, baseStale, OperationError } from "../plugins/errors.ts";
import { processClock } from "../observed_time.ts";
import { AsyncLock } from "../plugins/lifecycle.ts";
import type { PluginLifecycle } from "../plugins/lifecycle.ts";
import { PluginGuardError, type PluginRuntime } from "../plugins/runtime.ts";
import type { GuardLease } from "../plugins/runtime.ts";
import type { WriteTarget } from "../plugins/lifecycle.ts";
import type { RequesterAuthority } from "../plugins/lifecycle.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";

type SaveResult = NonNullable<Note["saveResult"]>;

interface OperationCorrelation {
  causalParent?: string;
  causalPlugin?: string;
  causalDepth?: number;
}
export type OperationOrigin =
  & OperationCorrelation
  & (
    | { origin: "api"; lease: NoteMutationLease }
    | { origin: "plugin" | "external" }
  );

export interface OperationAdapters {
  notes: FileSystemNotes;
  files: FileServing;
  indexer: Indexer | null;
  hub?: VaultHub;
  /** The hub's write gate; defaults to one over `hub`. */
  gate?: HubGate;
  runtime(): PluginRuntime | null;
  lifecycle: PluginLifecycle;
  now?(): Date;
}

const MARKDOWN_EXT = ".md";

export class NoteOperations {
  /** Managed-note-operation serialization boundary: host operations are
   * serialized; outside processes are not (pre-commit conflict detection,
   * NOT filesystem CAS). */
  readonly #lock = new AsyncLock();

  readonly #gate: HubGate;
  constructor(private readonly adapters: OperationAdapters) {
    this.#gate = adapters.gate ?? new HubGate({ hub: adapters.hub });
  }

  get lifecycle(): PluginLifecycle {
    return this.adapters.lifecycle;
  }

  #admission(ctx?: OperationOrigin, operationId?: string): void {
    if (ctx?.origin === "api") {
      if (!ctx.lease) {
        throw new HttpError(401, "API mutation request authority is required.");
      }
      ctx.lease.assertCurrent(operationId);
    }
    const { lifecycle } = this.adapters;
    if (!lifecycle.operational()) {
      throw new HttpError(503, "setup_required");
    }
    if (!lifecycle.writable()) {
      throw new HttpError(403, "read-only mode");
    }
  }

  #fact(
    operationId: string,
    action: OperationFact["action"],
    ctx: OperationOrigin,
    extra: Partial<OperationFact> = {},
  ): OperationFact {
    return {
      operationId,
      action: action as OperationAction,
      origin: ctx.origin,
      timestamp: new Date().toISOString(),
      causalParent: ctx.causalParent,
      causalPlugin: ctx.causalPlugin,
      causalDepth: ctx.causalDepth,
      ...extra,
    };
  }

  async #guard(
    hook: HookName,
    fact: OperationFact,
    operationDeadline: number,
  ): Promise<GuardLease[]> {
    const runtime = this.adapters.runtime();
    if (!runtime) return [];
    try {
      return await runtime.guard(hook, fact, operationDeadline);
    } catch (e) {
      if (e instanceof PluginGuardError) {
        throw new OperationError(
          e.status,
          e.cancelled ? "plugin_cancelled" : "plugin_guard_failed",
          e.message,
          {
            pluginId: e.pluginId,
            action: fact.action,
            operationId: fact.operationId,
          },
        );
      }
      throw e;
    }
  }

  #assertGuards(
    guards: { hook: HookName; leases: GuardLease[] }[],
  ): void {
    const runtime = this.adapters.runtime();
    if (!runtime) return;
    for (const { hook, leases } of guards) {
      try {
        runtime.assertGuardAuthority(hook, leases);
      } catch (e) {
        if (e instanceof PluginGuardError) {
          throw new OperationError(503, "plugin_guard_failed", e.message, {
            pluginId: e.pluginId,
            action: hook.slice(4),
          });
        }
        throw e;
      }
    }
  }

  /** Short policy/commit gate: epoch + guard authority + signatures, then
   * the storage effect. */
  async #commitGate<T>(
    capturedEpoch: number,
    guards: { hook: HookName; leases: GuardLease[] }[],
    revalidate: () => void,
    effect: () => T,
    operationId: string,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    effects: readonly string[] = [],
  ): Promise<T> {
    const { lifecycle } = this.adapters;
    return await lifecycle.gate.run(() => {
      // Re-evaluate original HTTP authorization before stale-epoch mapping;
      // actual setup/read-only/credential/expiry outcomes take precedence.
      this.#admission(ctx, operationId);
      if (lifecycle.epoch !== capturedEpoch) {
        // Current authorization succeeded but this operation's policy epoch
        // is gone (approved clarification: 409 operation_conflict).
        throw new OperationError(
          409,
          "operation_conflict",
          "Access policy changed while this operation was pending; it was not applied.",
          { operationId },
        );
      }
      this.#assertGuards(guards);
      try {
        revalidate();
      } catch (e) {
        // A writer's own stale-write guard keeps its actionable error.
        if (e instanceof OperationError || e instanceof NoteChangedError) {
          throw e;
        }
        throw new OperationError(
          409,
          "operation_conflict",
          `The vault changed while this operation was pending: ${
            (e as Error).message
          }`,
          { operationId },
        );
      }
      requester?.authorize(effects, operationId);
      if (ctx.origin === "api") ctx.lease.assertCurrent(operationId);
      return effect();
    });
  }

  /** `onStale` decides an occupied path (a writer whose base was absent):
   * without it the create is refused as before (note_exists). */
  async createNote(
    data: NoteCreate,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = createUuid(),
    onStale?: OnStale,
  ): Promise<Note> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    return await this.#lock.run(async () => {
      const notePath = (data.path ?? "").trim();
      if (onStale && this.#exists(notePath)) {
        if (onStale === "refuse") {
          throw baseStale(
            notePath,
            noteVersion(this.adapters.notes.get(notePath)),
            operationId,
          );
        }
        return await this.#keepBoth(
          notePath,
          data.content ?? "",
          "stale-base",
          ctx,
          requester,
          operationId,
        );
      }
      return await this.#createNoteLocked(data, ctx, requester, operationId);
    });
  }

  /** Reused by stale saves without reacquiring the non-reentrant note lock. */
  async #createNoteLocked(
    data: NoteCreate,
    ctx: OperationOrigin,
    requester: RequesterAuthority | undefined,
    operationId: string,
  ): Promise<Note> {
    this.#admission(ctx, operationId);
    const capturedEpoch = ctx.origin === "api"
      ? ctx.lease.epoch
      : this.adapters.lifecycle.epoch;
    const notePath = (data.path ?? "").trim();
    const content = data.content ?? "";
    const prepared = this.adapters.notes.prepareCreate(data);
    const effects = prepared.requiredPaths;
    requester?.authorize(effects, operationId);
    // Prepare: existence signature. A pre-existing note is NOT a conflict —
    // commit surfaces the legacy NoteExistsError mapping; only a change
    // between prepare and commit is operation_conflict.
    const existedAtPrepare = this.#exists(notePath);
    const fact = this.#fact(operationId, "create", ctx, {
      path: notePath,
      proposed: { path: notePath, content, contentAvailable: true },
    });
    const deadline = processClock.now() +
      this.adapters.runtime()!.limits.preOperationMs;
    const leases = await this.#guard("pre-create", fact, deadline);
    const actualEffects: StorageEffect[] = [];
    const note = await this.#commitGate(
      capturedEpoch,
      [{ hook: "pre-create", leases }],
      () => {
        const current = this.adapters.notes.prepareCreate(data);
        requester?.authorize(current.requiredPaths, operationId);
        if (current.filename !== prepared.filename) {
          throw new Error("canonical destination changed");
        }
        if (!existedAtPrepare && this.#exists(notePath)) {
          throw new Error(
            `'${notePath}' appeared while the operation was pending`,
          );
        }
      },
      () =>
        this.#captureStorage(
          operationId,
          ctx,
          () => this.adapters.notes.commitCreate(prepared),
          actualEffects,
          prepared.requiredPaths,
          requester?.pluginId,
        ),
      operationId,
      ctx,
      requester,
      effects,
    );
    this.#recordManaged(note.path);
    this.adapters.lifecycle.observe(
      this.#fact(operationId, "create", ctx, {
        path: note.path,
        after: snapshot(note),
      }),
    );
    this.#syncEffects(operationId, ctx, actualEffects);
    return this.#saveResponse(note, { status: "saved" });
  }

  /** Keep both: the writer's text as a conflict copy next to the original,
   * through the guarded create path, and a conflict record. */
  async #keepBoth(
    notePath: string,
    content: string,
    reason: string,
    ctx: OperationOrigin,
    requester: RequesterAuthority | undefined,
    operationId: string,
  ): Promise<Note> {
    const copyFile = conflictCopyPath(
      notePath + MARKDOWN_EXT,
      "globnotes",
      this.adapters.now?.() ?? new Date(),
      // Count every occupied filesystem entry, not just readable notes.
      (candidate) =>
        occupied(
          this.adapters.notes.prepareCreate({
            path: candidate.slice(0, -MARKDOWN_EXT.length),
          }).filename,
        ),
    );
    const copy = await this.#createNoteLocked(
      { path: copyFile.slice(0, -MARKDOWN_EXT.length), content },
      ctx,
      requester,
      operationId,
    );
    this.adapters.hub?.recordConflict({
      id: createUuid(),
      path: notePath + MARKDOWN_EXT,
      copyPath: copy.path + MARKDOWN_EXT,
      peer: "globnotes",
      reason,
      state: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    return this.#saveResponse(copy, {
      status: "conflict",
      conflictCopyPath: copy.path,
    });
  }

  #saveResponse(note: Note, saveResult: NonNullable<Note["saveResult"]>): Note {
    return { ...note, version: noteVersion(note), saveResult };
  }

  async updateNote(
    notePath: string,
    data: NoteUpdate,
    fileRefs: string,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = createUuid(),
    expect?: NoteExpectation,
  ): Promise<Note> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    return await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
      // The writer's stale-write guard, under the lock and before any merge,
      // hook or effect (server/notes/expectation.ts).
      if (expect) {
        assertExpected(notePath, this.adapters.notes.get(notePath), expect);
      }
      let status: "saved" | "merged" = "saved";
      const base: Base | undefined = data.base ??
        (typeof data.baseContent === "string"
          ? { kind: "text", content: data.baseContent }
          : undefined);
      // Every write that replaces or moves a note states its base.
      if (!base && !expect) throw baseRequired(operationId);
      if (base) {
        // The hub gate's base check (server/hub/gate.ts), under the note lock.
        this.adapters.hub?.scanNow([notePath + MARKDOWN_EXT]);
        let current: Note | null = null;
        try {
          current = this.adapters.notes.get(notePath);
        } catch (error) {
          if (!(error instanceof NoteNotFoundError)) throw error;
        }
        const saving = typeof data.newContent === "string";
        const outcome = checkBase(
          base,
          current && {
            version: noteVersion(current),
            text: current.content ?? "",
          },
          saving ? data.newContent! : undefined,
        );
        if (outcome.status === "merged") {
          data = { ...data, newContent: outcome.content };
          status = "merged";
        } else if (outcome.status === "stale") {
          // A rename moves the whole file, so it never lands on a stale base.
          if (!saving || data.onStale === "refuse") {
            throw baseStale(notePath, outcome.currentVersion, operationId);
          }
          if (!current) {
            const recreated = await this.#createNoteLocked(
              { path: notePath, content: data.newContent! },
              ctx,
              requester,
              operationId,
            );
            return this.#saveResponse(recreated, {
              status: "saved",
              recreated: true,
            });
          }
          return await this.#keepBoth(
            notePath,
            data.newContent!,
            base.kind === "text" ? "overlapping-edits" : "stale-base",
            ctx,
            requester,
            operationId,
          );
        }
      }
      const capturedEpoch = ctx.origin === "api"
        ? ctx.lease.epoch
        : this.adapters.lifecycle.epoch;
      // Prepare: resolve the ACTUAL operation without any filesystem effect.
      const prepared = this.adapters.notes.prepareUpdate(
        notePath,
        data,
        fileRefs,
      );
      const before = prepared.before;
      const saving = prepared.saving;
      const resolvedNewPath = prepared.targetPath;
      const renameChanged = prepared.renaming;
      if (requester && prepared.attachments.some((file) => file.directory)) {
        throw new OperationError(
          403,
          "plugin_permission_denied",
          "Plugin attachment directory moves are not supported; no effect was started.",
          { operationId },
        );
      }
      requester?.authorize(prepared.requiredPaths, operationId);
      const contentChanged = saving && data.newContent !== before.content;
      const guards: { hook: HookName; leases: GuardLease[] }[] = [];
      const deadline = processClock.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      if (renameChanged) {
        const fact = this.#fact(operationId, "rename", ctx, {
          path: notePath,
          oldPath: notePath,
          newPath: resolvedNewPath,
          before: snapshot(before),
          proposed: {
            path: resolvedNewPath,
            content: prepared.content,
            contentAvailable: true,
          },
        });
        guards.push({
          hook: "pre-rename",
          leases: await this.#guard("pre-rename", fact, deadline),
        });
      }
      if (saving) {
        const fact = this.#fact(operationId, "save", ctx, {
          path: renameChanged ? resolvedNewPath : notePath,
          oldPath: renameChanged ? notePath : undefined,
          before: snapshot(before),
          proposed: {
            path: resolvedNewPath,
            content: prepared.content,
            contentAvailable: true,
          },
          contentChanged,
        });
        guards.push({
          hook: "pre-save",
          leases: await this.#guard("pre-save", fact, deadline),
        });
      }
      // Offer what leaves a path before the commit (docs/hub.md "Versioning");
      // the commit's revalidation keeps the offered bytes the displaced ones.
      const versioning = await this.#offer(
        [
          ...(saving || renameChanged
            ? [
              renameChanged
                ? {
                  kind: "move" as const,
                  file: prepared.sourceFile,
                  destination: prepared.targetFile,
                }
                : { kind: "replace" as const, file: prepared.sourceFile },
            ]
            : []),
          ...prepared.attachments.map((file) => ({
            kind: "move" as const,
            file: file.source,
            destination: file.destination,
          })),
        ],
        ctx,
        requester,
        operationId,
      );
      const actualEffects: StorageEffect[] = [];
      const note = await this.#commitGate(
        capturedEpoch,
        guards,
        () => {
          const fresh = this.adapters.notes.prepareUpdate(
            notePath,
            data,
            fileRefs,
          );
          requester?.authorize(fresh.requiredPaths, operationId);
          if (
            fresh.sourceFile !== prepared.sourceFile ||
            fresh.targetFile !== prepared.targetFile ||
            JSON.stringify(fresh.attachments) !==
              JSON.stringify(prepared.attachments)
          ) throw new Error("canonical effects changed");
          const current = this.adapters.notes.get(notePath);
          assertExpected(notePath, current, expect);
          if (current.content !== before.content) {
            throw new Error(`'${notePath}' changed on disk`);
          }
          if (renameChanged && this.#exists(resolvedNewPath)) {
            throw new Error(`rename target '${resolvedNewPath}' appeared`);
          }
        },
        () =>
          this.#captureStorage(
            operationId,
            ctx,
            () =>
              this.adapters.notes.commitUpdate(prepared, requester?.canPrune),
            actualEffects,
            prepared.requiredPaths,
            requester?.pluginId,
          ),
        operationId,
        ctx,
        requester,
        prepared.requiredPaths,
      );
      this.#recordManaged(note.path);
      if (renameChanged) {
        this.adapters.lifecycle.recordManagedDelete(notePath + MARKDOWN_EXT);
        this.adapters.lifecycle.observe(
          this.#fact(operationId, "rename", ctx, {
            path: note.path,
            oldPath: notePath,
            newPath: note.path,
            before: snapshot(before),
            after: snapshot(note),
            ...versioningMetadata(versioning),
          }),
        );
      }
      if (saving && (contentChanged || !renameChanged)) {
        this.adapters.lifecycle.observe(
          this.#fact(operationId, "save", ctx, {
            path: note.path,
            before: snapshot(before),
            after: snapshot(note),
            contentChanged,
            ...versioningMetadata(versioning),
          }),
        );
      }
      this.#syncEffects(operationId, ctx, actualEffects);
      return this.#saveResponse(note, { status });
    });
  }

  async deleteNote(
    notePath: string,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = createUuid(),
    expect?: NoteExpectation,
    base?: Base,
  ): Promise<void> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
      const capturedEpoch = ctx.origin === "api"
        ? ctx.lease.epoch
        : this.adapters.lifecycle.epoch;
      // Capture the final content BEFORE any removal.
      const before = this.adapters.notes.get(notePath);
      // The writer's stale-write guard (server/notes/expectation.ts).
      assertExpected(notePath, before, expect);
      if (!base && !expect) throw baseRequired(operationId);
      if (base) {
        // A stale delete is refused: the change made since wins.
        const outcome = checkBase(base, {
          version: noteVersion(before),
          text: before.content ?? "",
        });
        if (outcome.status !== "current") {
          throw baseStale(notePath, noteVersion(before), operationId);
        }
      }
      const effects = [
        path.join(this.adapters.notes.storagePath, notePath + MARKDOWN_EXT),
      ];
      requester?.authorize(effects, operationId);
      const fact = this.#fact(operationId, "delete", ctx, {
        path: notePath,
        before: snapshot(before),
      });
      const deadline = processClock.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const leases = await this.#guard("pre-delete", fact, deadline);
      const versioning = await this.#offer(
        [{ kind: "delete", file: effects[0] }],
        ctx,
        requester,
        operationId,
      );
      const actualEffects: StorageEffect[] = [];
      await this.#commitGate(
        capturedEpoch,
        [{ hook: "pre-delete", leases }],
        () => {
          const current = this.adapters.notes.get(notePath);
          assertExpected(notePath, current, expect);
          if (current.content !== before.content) {
            throw new Error(`'${notePath}' changed on disk`);
          }
        },
        () =>
          this.#captureStorage(
            operationId,
            ctx,
            () => this.adapters.notes.delete(notePath, requester?.canPrune),
            actualEffects,
            effects,
            requester?.pluginId,
          ),
        operationId,
        ctx,
        requester,
        effects,
      );
      this.adapters.lifecycle.recordManagedDelete(notePath + MARKDOWN_EXT);
      this.adapters.lifecycle.observe(
        this.#fact(operationId, "delete", ctx, {
          path: notePath,
          before: snapshot(before),
          after: null,
          ...versioningMetadata(versioning),
        }),
      );
      this.#syncEffects(operationId, ctx, actualEffects);
    });
  }

  async uploadFile(
    directory: string,
    rawFilename: string,
    body: Uint8Array,
    ctx: OperationOrigin,
  ): Promise<{ filename: string; url: string }> {
    const operationId = createUuid();
    this.#admission(ctx, operationId);
    return await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
      const capturedEpoch = ctx.origin === "api"
        ? ctx.lease.epoch
        : this.adapters.lifecycle.epoch;
      // Resolve the ACTUAL collision-adjusted name before hooks see it.
      const prepared = this.adapters.files.prepareCreate(
        directory,
        rawFilename,
      );
      const fact = this.#fact(operationId, "upload", ctx, {
        path: directory,
        metadata: { filename: prepared.filename, bytes: body.length },
      });
      const deadline = processClock.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const leases = await this.#guard("pre-upload", fact, deadline);
      const actualEffects: StorageEffect[] = [];
      const result = await this.#commitGate(
        capturedEpoch,
        [{ hook: "pre-upload", leases }],
        () => this.adapters.files.revalidateCreate(prepared),
        () =>
          this.#captureStorage(
            operationId,
            ctx,
            () => {
              const uploaded = this.adapters.files.commitCreate(prepared, body);
              if (uploaded.filename.endsWith(MARKDOWN_EXT)) {
                this.adapters.notes.reconcileEffects(actualEffects);
              }
              return uploaded;
            },
            actualEffects,
            [prepared.filepath],
          ),
        operationId,
        ctx,
      );
      this.adapters.lifecycle.observe(
        this.#fact(operationId, "upload", ctx, {
          path: directory,
          metadata: { filename: result.filename, bytes: body.length },
        }),
      );
      if (result.filename.endsWith(MARKDOWN_EXT)) {
        const notePath = (directory ? `${directory}/` : "") +
          result.filename.slice(0, -MARKDOWN_EXT.length);
        this.#recordManaged(notePath);
        this.adapters.lifecycle.observe(
          this.#fact(operationId, "create", ctx, {
            path: notePath,
            after: { path: notePath, contentAvailable: false },
            metadata: { upload: true },
          }),
        );
      }
      this.#syncEffects(operationId, ctx, actualEffects);
      return result;
    });
  }

  async rewriteRefs(
    oldPath: string,
    newPath: string,
    ctx: OperationOrigin,
  ): Promise<void> {
    const operationId = createUuid();
    this.#admission(ctx, operationId);
    await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
      const capturedEpoch = ctx.origin === "api"
        ? ctx.lease.epoch
        : this.adapters.lifecycle.epoch;
      // Complete changed-file set BEFORE writing.
      const changes = await this.adapters.notes.prepareRefsRewrite(
        oldPath,
        newPath,
      );
      this.#admission(ctx, operationId);
      if (changes.length === 0) return;
      const toNotePath = (absolute: string) => {
        const relative = this.#vaultRelative(absolute);
        if (relative === null) {
          throw new Error("Reference rewrite escaped the vault");
        }
        return relative.slice(0, -MARKDOWN_EXT.length);
      };
      const originals = new Map<string, string>();
      for (const change of changes) {
        originals.set(change.path, Deno.readTextFileSync(change.path));
      }
      const changedPaths = changes.map((c) => toNotePath(c.path));
      const deadline = processClock.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const guards: { hook: HookName; leases: GuardLease[] }[] = [];
      guards.push({
        hook: "pre-rewrite-refs",
        leases: await this.#guard(
          "pre-rewrite-refs",
          this.#fact(operationId, "rewrite-refs", ctx, {
            oldPath,
            newPath,
            changedPaths,
          }),
          deadline,
        ),
      });
      // Aggregate guard AND an affected save guard per changed file, all
      // before the first mutation.
      for (const change of changes) {
        const notePath = toNotePath(change.path);
        guards.push({
          hook: "pre-save",
          leases: await this.#guard(
            "pre-save",
            this.#fact(operationId, "save", ctx, {
              path: notePath,
              before: {
                path: notePath,
                content: originals.get(change.path),
                contentAvailable: true,
              },
              proposed: {
                path: notePath,
                content: change.content,
                contentAvailable: true,
              },
              contentChanged: true,
              metadata: { rewriteRefs: true },
            }),
            deadline,
          ),
        });
      }
      const versioning = await this.#offer(
        changes.map((change) => ({ kind: "replace", file: change.path })),
        ctx,
        undefined,
        operationId,
      );
      const actualEffects: StorageEffect[] = [];
      const applied = await this.#commitGate(
        capturedEpoch,
        guards,
        () => {
          for (const change of changes) {
            if (
              Deno.readTextFileSync(change.path) !== originals.get(change.path)
            ) {
              throw new Error(`'${toNotePath(change.path)}' changed on disk`);
            }
          }
        },
        () =>
          this.#captureStorage(
            operationId,
            ctx,
            () => this.adapters.notes.applyRefsRewrite(changes),
            actualEffects,
            changes.map((change) => change.path),
          ),
        operationId,
        ctx,
      );
      // A storage probe/error can follow a completed write before that path
      // enters applyRefsRewrite.written. Reconcile and sync the actual journal,
      // retaining the separate verified-completion/failed-path receipt contract.
      this.adapters.notes.reconcileEffects(actualEffects);
      for (const effect of actualEffects) {
        if (effect.kind === "write") {
          this.#recordManaged(toNotePath(effect.path));
        }
      }
      // Truthful accounting: publish only verified completed writes.
      for (const written of applied.written) {
        const notePath = toNotePath(written);
        this.#recordManaged(notePath);
        this.adapters.lifecycle.observe(
          this.#fact(operationId, "save", ctx, {
            path: notePath,
            before: {
              path: notePath,
              content: originals.get(written),
              contentAvailable: true,
            },
            after: {
              path: notePath,
              content: changes.find((c) => c.path === written)!.content,
              contentAvailable: true,
            },
            contentChanged: true,
            metadata: {
              rewriteRefs: true,
              ...versioningMetadata(versioning).metadata,
            },
          }),
        );
      }
      if (applied.failed) {
        const failedNote = toNotePath(applied.failed.path);
        this.adapters.lifecycle.observe(
          this.#fact(operationId, "operation-error", ctx, {
            path: failedNote,
            changedPaths: applied.written.map(toNotePath),
            metadata: { code: "operation_partial", failedPath: failedNote },
          }),
        );
        this.#syncEffects(operationId, ctx, actualEffects);
        throw new OperationError(
          500,
          "operation_partial",
          `Reference rewrite stopped at '${failedNote}'; earlier files were updated and the index was reconciled for them.`,
          {
            operationId,
            partial: {
              completedPaths: applied.written.map(toNotePath),
              failedPath: failedNote,
            },
          },
        );
      }
      this.adapters.lifecycle.observe(
        this.#fact(operationId, "rewrite-refs", ctx, {
          oldPath,
          newPath,
          changedPaths,
        }),
      );
      this.#syncEffects(operationId, ctx, actualEffects);
    });
  }

  /** Guarded non-note file write (plugin ctx.files.requestWrite / actions).
   * Vault markdown targets are classified by the caller into note
   * create/save before reaching this method. */
  async writeExternalFile(
    requested: WriteTarget & { kind: "file" },
    bytes: Uint8Array,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = createUuid(),
    base?: Base,
    onStale: OnStale = "copy",
  ): Promise<{ path: string; version: string; saveResult: SaveResult }> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    return await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
      const capturedEpoch = ctx.origin === "api"
        ? ctx.lease.epoch
        : this.adapters.lifecycle.epoch;
      let target = requested;
      requester?.authorize([target.absolutePath], operationId);
      let existed = this.#fileExists(target.absolutePath);
      let beforeBytes = existed
        ? await Deno.readFile(target.absolutePath)
        : null;
      this.#admission(ctx, operationId);
      if (!base) throw baseRequired(operationId);
      let conflictOf: string | null = null;
      if (base) {
        // Files other than notes are binary: compared by version, never merged.
        const outcome = checkBase(
          base,
          beforeBytes ? { version: versionOf(beforeBytes) } : null,
        );
        if (outcome.status !== "current") {
          const inVault = this.adapters.hub?.relativePath(target.absolutePath);
          if (onStale === "refuse" || !inVault) {
            throw baseStale(
              inVault ?? target.absolutePath,
              outcome.status === "stale" ? outcome.currentVersion : null,
              operationId,
            );
          }
          // Keep both: the writer's bytes next to the original.
          conflictOf = target.absolutePath;
          const copy = conflictCopyPath(
            target.absolutePath,
            "globnotes",
            this.adapters.now?.() ?? new Date(),
            occupied,
          );
          requester?.authorize([copy], operationId);
          target = { kind: "file", absolutePath: copy };
          existed = false;
          beforeBytes = null;
        }
      }
      const fact = this.#fact(operationId, "file-write", ctx, {
        path: target.absolutePath,
        metadata: { bytes: bytes.length, existed },
      });
      const deadline = processClock.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const leases = await this.#guard("pre-file-write", fact, deadline);
      const versioning = existed
        ? await this.#offer(
          [{ kind: "replace", file: target.absolutePath }],
          ctx,
          requester,
          operationId,
        )
        : [];
      const actualEffects: StorageEffect[] = [];
      await this.#commitGate(
        capturedEpoch,
        [{ hook: "pre-file-write", leases }],
        () => {
          if (requester && target.requestedPath) {
            requester.authorize([target.requestedPath], operationId);
            if (
              requester.resolve(target.requestedPath) !== target.absolutePath
            ) throw new Error("canonical file-write target changed");
          }
          const nowExists = this.#fileExists(target.absolutePath);
          if (nowExists !== existed) {
            throw new Error(
              "target existence changed while the write was pending",
            );
          }
          const displaced = beforeBytes;
          if (displaced) {
            const current = Deno.readFileSync(target.absolutePath);
            if (
              current.length !== displaced.length ||
              !current.every((b, i) => b === displaced[i])
            ) {
              throw new Error("target changed on disk");
            }
          }
        },
        () =>
          this.#captureStorage(
            operationId,
            ctx,
            () => {
              if (existed) {
                this.adapters.notes.effects.replace(target.absolutePath, bytes);
              } else {
                this.adapters.notes.effects.writeNew(
                  target.absolutePath,
                  bytes,
                );
              }
            },
            actualEffects,
            [target.absolutePath],
            requester?.pluginId,
          ),
        operationId,
        ctx,
        requester,
        [target.absolutePath],
      );
      this.adapters.lifecycle.observe(
        this.#fact(operationId, "file-write", ctx, {
          path: target.absolutePath,
          metadata: {
            bytes: bytes.length,
            existed,
            ...versioningMetadata(versioning).metadata,
          },
        }),
      );
      this.#syncEffects(operationId, ctx, [{
        kind: "write",
        path: target.absolutePath,
      }]);
      const hub = this.adapters.hub;
      const relative = hub?.relativePath(target.absolutePath) ?? null;
      if (conflictOf && hub && relative) {
        hub.recordConflict({
          id: createUuid(),
          path: hub.relativePath(conflictOf),
          copyPath: relative,
          peer: "globnotes",
          reason: "stale-base",
          state: "open",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
      }
      return {
        path: relative ?? target.absolutePath,
        version: versionOf(bytes),
        saveResult: conflictOf
          ? {
            status: "conflict",
            conflictCopyPath: relative ?? target.absolutePath,
          }
          : { status: "saved" },
      };
    });
  }

  /** The writer's origin as the hub records it. */
  #origin(ctx: OperationOrigin, requester?: RequesterAuthority): string {
    return ctx.origin === "plugin"
      ? `plugin:${requester?.pluginId ?? ctx.causalPlugin}`
      : ctx.origin;
  }

  /** Offer displaced bytes to versioners. Versioning has its own budget
   * (`versioningMs` per versioner), starting after the guards: time the
   * guards used never shortens a versioner's custody window. */
  async #offer(
    displacements: Displacement[],
    ctx: OperationOrigin,
    requester: RequesterAuthority | undefined,
    operationId: string,
  ): Promise<OfferOutcome[]> {
    if (!displacements.length) return [];
    const budget = this.adapters.runtime()?.limits.versioningMs ??
      PLUGIN_LIMITS.versioningMs;
    return await this.#gate.offer(
      displacements,
      this.#origin(ctx, requester),
      operationId,
      processClock.now() + budget,
    );
  }

  noteExists(notePath: string): boolean {
    return this.#exists(notePath);
  }
  #requesterRequired(
    ctx: OperationOrigin,
    requester: RequesterAuthority | undefined,
    operationId: string,
  ): void {
    if (ctx.origin === "plugin" && !requester) {
      throw new OperationError(
        403,
        "plugin_permission_denied",
        "Plugin mutation requester authority is required.",
        { operationId },
      );
    }
  }
  #captureStorage<T>(
    operationId: string,
    ctx: OperationOrigin,
    callback: () => T,
    effects: StorageEffect[] = [],
    expectedPaths: readonly string[] = [],
    pluginId = ctx.causalPlugin,
  ): T {
    try {
      return this.#gate.apply(
        expectedPaths,
        ctx.origin === "plugin" ? `plugin:${pluginId}` : ctx.origin,
        effects,
        callback,
      );
    } catch (error) {
      if (!effects.length) throw error;
      this.adapters.notes.reconcileEffects(effects);
      const noteEffects = new Set(
        effects.flatMap(
          (
            effect,
          ) => [effect.path, ...(effect.oldPath ? [effect.oldPath] : [])],
        ).filter((filename) => filename.endsWith(MARKDOWN_EXT)),
      );
      const completedPaths: string[] = [];
      for (const filename of noteEffects) {
        const relative = this.#vaultRelative(filename);
        if (relative === null) continue;
        const notePath = relative.slice(0, -MARKDOWN_EXT.length);
        completedPaths.push(notePath);
        try {
          const after = this.adapters.notes.get(notePath);
          this.#recordManaged(notePath);
          this.adapters.lifecycle.observe(
            this.#fact(operationId, "save", ctx, {
              path: notePath,
              after: snapshot(after),
              metadata: { partial: true },
            }),
          );
        } catch {
          this.adapters.lifecycle.recordManagedDelete(notePath + MARKDOWN_EXT);
        }
      }
      const metadata = {
        code: "operation_partial",
        effects: effects.map((effect) => ({ ...effect })),
      };
      this.adapters.lifecycle.observe(
        this.#fact(operationId, "operation-error", ctx, {
          changedPaths: completedPaths,
          metadata,
        }),
      );
      this.#syncEffects(operationId, ctx, effects);
      throw new OperationError(
        500,
        "operation_partial",
        "Storage effects were applied, but the operation could not be fully reconciled; inspect the actual effects before retrying.",
        { operationId, partial: { completedPaths } },
      );
    }
  }

  /** Admit one nonblocking boundary for actual operation-local effects only. */
  #syncEffects(
    operationId: string,
    ctx: OperationOrigin,
    effects: readonly StorageEffect[],
  ): void {
    if (!effects.length) return;
    const changedPaths = new Set<string>();
    for (const effect of effects) {
      if (effect.kind === "mkdir") continue;
      for (
        const filename of [
          effect.path,
          ...(effect.oldPath ? [effect.oldPath] : []),
        ]
      ) {
        const relative = this.#vaultRelative(filename);
        if (relative === null || !relative.endsWith(MARKDOWN_EXT)) continue;
        changedPaths.add(relative.slice(0, -MARKDOWN_EXT.length));
      }
    }
    this.adapters.lifecycle.syncCompleted(this.#fact(operationId, "sync", ctx, {
      initial: false,
      changedPaths: [...changedPaths],
      metadata: { effects: effects.map((effect) => ({ ...effect })) },
    }));
  }

  #vaultRelative(filename: string): string | null {
    if (this.adapters.hub) return this.adapters.hub.relativePath(filename);
    const relative = path.relative(this.adapters.notes.storagePath, filename)
      .replace(/\\/g, "/");
    return relative === ".." || relative.startsWith("../") ||
        path.isAbsolute(relative)
      ? null
      : relative;
  }

  #exists(notePath: string): boolean {
    try {
      this.adapters.notes.get(notePath);
      return true;
    } catch {
      return false;
    }
  }

  #fileExists(filePath: string): boolean {
    try {
      return Deno.statSync(filePath).isFile;
    } catch {
      return false;
    }
  }

  #recordManaged(notePath: string): void {
    const filename = notePath + MARKDOWN_EXT;
    try {
      const filePath = path.join(
        this.adapters.notes.storagePath,
        filename,
      );
      const mtime = (Deno.statSync(filePath).mtime?.getTime() ?? 0) / 1000;
      this.adapters.lifecycle.recordManaged(filename, mtime);
    } catch {
      // File vanished immediately after commit; the scan reports the truth.
    }
  }
}

/** Versioning outcomes for the operation's facts (empty when none). */
function versioningMetadata(
  outcomes: OfferOutcome[],
): { metadata?: { versioning: JsonValues[] } } {
  return outcomes.length
    ? {
      metadata: {
        versioning: outcomes.map((o) => ({
          pluginId: o.versioner,
          path: o.path,
          status: o.status,
        })),
      },
    }
    : {};
}

function snapshot(note: Note): NoteSnapshot {
  return {
    path: note.path,
    content: note.content ?? undefined,
    lastModified: note.lastModified,
    contentAvailable: note.content !== null,
  };
}

/** Mediated plugin read: media type + bytes, used by ctx.files.read and the
 * legacy ctx.readFile RPC. */
export function readManagedFile(absolutePath: string): {
  mediaType: string;
  body: Uint8Array;
  version: string;
} {
  const body = Deno.readFileSync(absolutePath);
  return {
    mediaType: guessType(absolutePath) ?? "application/octet-stream",
    body,
    version: versionOf(body),
  };
}
