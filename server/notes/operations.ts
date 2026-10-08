// SPDX-License-Identifier: LGPL-3.0-only

/** Async guarded operation facade — the ONLY application mutation entry
 * point. FileSystemNotes keeps its synchronous low-level methods as
 * internal host storage APIs; endpoints and plugin action adapters await
 * this facade. Steps follow plan §3.3: authorize → prepare (no effects) →
 * ordered pre-hooks → short policy/commit gate with epoch + signature
 * revalidation → commit through storage → post-fact admission → result. */

import * as path from "@std/path";
import { HttpError } from "@pathfinder/pathfinder";
import type { FileServing } from "../files/file_serving.ts";
import type { Indexer } from "../state.ts";
import { guessType } from "../files/mimetypes.ts";
import { FileSystemNotes, type StorageEffect } from "./file_system.ts";
import type { Note, NoteCreate, NoteUpdate } from "./models.ts";
import type {
  HookName,
  NoteSnapshot,
  OperationAction,
  OperationFact,
} from "../plugins/contracts.ts";
import { OperationError } from "../plugins/errors.ts";
import { AsyncLock } from "../plugins/lifecycle.ts";
import type { PluginLifecycle } from "../plugins/lifecycle.ts";
import { PluginGuardError, type PluginRuntime } from "../plugins/runtime.ts";
import type { GuardLease } from "../plugins/runtime.ts";
import type { WriteTarget } from "../plugins/lifecycle.ts";
import type { RequesterAuthority } from "../plugins/lifecycle.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";

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
  runtime(): PluginRuntime | null;
  lifecycle: PluginLifecycle;
}

const MARKDOWN_EXT = ".md";

export class NoteOperations {
  /** Managed-note-operation serialization boundary: host operations are
   * serialized; outside processes are not (pre-commit conflict detection,
   * NOT filesystem CAS). */
  readonly #lock = new AsyncLock();

  constructor(private readonly adapters: OperationAdapters) {}

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
        if (e instanceof OperationError) throw e;
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

  async createNote(
    data: NoteCreate,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = crypto.randomUUID(),
  ): Promise<Note> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    return await this.#lock.run(async () => {
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
      const deadline = Date.now() +
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
      return note;
    });
  }

  async updateNote(
    notePath: string,
    data: NoteUpdate,
    fileRefs: string,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = crypto.randomUUID(),
  ): Promise<Note> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    return await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
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
      const deadline = Date.now() +
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
          }),
        );
      }
      this.#syncEffects(operationId, ctx, actualEffects);
      return note;
    });
  }

  async deleteNote(
    notePath: string,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = crypto.randomUUID(),
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
      const effects = [
        path.join(this.adapters.notes.storagePath, notePath + MARKDOWN_EXT),
      ];
      requester?.authorize(effects, operationId);
      const fact = this.#fact(operationId, "delete", ctx, {
        path: notePath,
        before: snapshot(before),
      });
      const deadline = Date.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const leases = await this.#guard("pre-delete", fact, deadline);
      const actualEffects: StorageEffect[] = [];
      await this.#commitGate(
        capturedEpoch,
        [{ hook: "pre-delete", leases }],
        () => {
          const current = this.adapters.notes.get(notePath);
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
    const operationId = crypto.randomUUID();
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
      const deadline = Date.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const leases = await this.#guard("pre-upload", fact, deadline);
      const actualEffects: StorageEffect[] = [];
      const result = await this.#commitGate(
        capturedEpoch,
        [{ hook: "pre-upload", leases }],
        () => this.adapters.files.revalidateCreate(prepared),
        () =>
          this.#captureStorage(operationId, ctx, () => {
            const uploaded = this.adapters.files.commitCreate(prepared, body);
            actualEffects.push({ kind: "write", path: prepared.filepath });
            if (uploaded.filename.endsWith(MARKDOWN_EXT)) {
              this.adapters.notes.reconcileEffects(actualEffects);
            }
            return uploaded;
          }, actualEffects),
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
    const operationId = crypto.randomUUID();
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
      const vaultRoot = this.adapters.notes.storagePath;
      const toNotePath = (absolute: string) =>
        path.relative(vaultRoot, absolute).replace(/\\/g, "/").slice(
          0,
          -MARKDOWN_EXT.length,
        );
      const originals = new Map<string, string>();
      for (const change of changes) {
        originals.set(change.path, Deno.readTextFileSync(change.path));
      }
      const changedPaths = changes.map((c) => toNotePath(c.path));
      const deadline = Date.now() +
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
        this.adapters.indexer?.reindexNote(notePath);
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
            metadata: { rewriteRefs: true },
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
    target: WriteTarget & { kind: "file" },
    bytes: Uint8Array,
    ctx: OperationOrigin,
    requester?: RequesterAuthority,
    operationId = crypto.randomUUID(),
  ): Promise<void> {
    this.#admission(ctx, operationId);
    this.#requesterRequired(ctx, requester, operationId);
    await this.#lock.run(async () => {
      this.#admission(ctx, operationId);
      const capturedEpoch = ctx.origin === "api"
        ? ctx.lease.epoch
        : this.adapters.lifecycle.epoch;
      requester?.authorize([target.absolutePath], operationId);
      const existed = this.#fileExists(target.absolutePath);
      const beforeBytes = existed
        ? await Deno.readFile(target.absolutePath)
        : null;
      this.#admission(ctx, operationId);
      const fact = this.#fact(operationId, "file-write", ctx, {
        path: target.absolutePath,
        metadata: { bytes: bytes.length, existed },
      });
      const deadline = Date.now() +
        this.adapters.runtime()!.limits.preOperationMs;
      const leases = await this.#guard("pre-file-write", fact, deadline);
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
          if (beforeBytes) {
            const current = Deno.readFileSync(target.absolutePath);
            if (
              current.length !== beforeBytes.length ||
              !current.every((b, i) => b === beforeBytes[i])
            ) {
              throw new Error("target changed on disk");
            }
          }
        },
        () => Deno.writeFileSync(target.absolutePath, bytes),
        operationId,
        ctx,
        requester,
        [target.absolutePath],
      );
      this.adapters.lifecycle.observe(
        this.#fact(operationId, "file-write", ctx, {
          path: target.absolutePath,
          metadata: { bytes: bytes.length, existed },
        }),
      );
      this.#syncEffects(operationId, ctx, [{
        kind: "write",
        path: target.absolutePath,
      }]);
    });
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
  ): T {
    try {
      return this.adapters.notes.captureEffects(effects, callback);
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
        const notePath = path.relative(
          this.adapters.notes.storagePath,
          filename,
        ).replace(/\\/g, "/").slice(0, -MARKDOWN_EXT.length);
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
        "Storage effects were partially applied; recorded paths and index reflect the actual outcome.",
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
    const root = this.adapters.notes.storagePath;
    const changedPaths = new Set<string>();
    for (const effect of effects) {
      if (effect.kind === "mkdir") continue;
      for (
        const filename of [
          effect.path,
          ...(effect.oldPath ? [effect.oldPath] : []),
        ]
      ) {
        const relative = path.relative(root, filename).replace(/\\/g, "/");
        if (
          !relative.endsWith(MARKDOWN_EXT) || relative.startsWith("../") ||
          path.isAbsolute(relative)
        ) continue;
        changedPaths.add(relative.slice(0, -MARKDOWN_EXT.length));
      }
    }
    this.adapters.lifecycle.syncCompleted(this.#fact(operationId, "sync", ctx, {
      initial: false,
      changedPaths: [...changedPaths],
      metadata: { effects: effects.map((effect) => ({ ...effect })) },
    }));
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
} {
  return {
    mediaType: guessType(absolutePath) ?? "application/octet-stream",
    body: Deno.readFileSync(absolutePath),
  };
}
