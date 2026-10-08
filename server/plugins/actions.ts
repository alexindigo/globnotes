// SPDX-License-Identifier: LGPL-3.0-only

/** Deferred plugin action requests (ctx.actions.request /
 * ctx.files.requestWrite). Acceptance-only: request() resolves with a
 * receipt ID, never with completion. Execution is scheduled outside the
 * currently executing handler, outcomes are correlated receipts, and the
 * causal chain is bounded to stop accidental infinite loops. */

import { type ActionReceipt, PLUGIN_LIMITS } from "./contracts.ts";
import {
  classifyWriteTarget,
  projectActionReceipt,
  requesterAuthority,
} from "./lifecycle.ts";
import type { PluginManifest } from "./manifest.ts";
import type { NoteOperations } from "../notes/operations.ts";
import type { PluginRuntime } from "./runtime.ts";
import type { ReleaseOutcome } from "./execution_context.ts";

export interface ActionAdapters {
  operations: NoteOperations;
  runtime(): PluginRuntime | null;
  vaultPath: string;
  statePath: string;
  limits?: { receipts?: number; causalDepth?: number };
}

interface ActionContext {
  pluginId: string;
  generation: string;
  causalParent?: string;
  causalDepth: number;
  current(): boolean;
  release: Promise<ReleaseOutcome>;
  generationRetired: Promise<void>;
}

interface ReceiptRing {
  generation: string;
  receipts: ActionReceipt[];
  manifest: PluginManifest;
  current(): boolean;
  retired: boolean;
}

export class PluginActions {
  readonly #rings = new Map<string, ReceiptRing>();
  readonly #adapters: ActionAdapters;
  readonly #receiptLimit: number;
  readonly #causalLimit: number;
  readonly #pendingLimit: number;

  constructor(adapters: ActionAdapters) {
    this.#adapters = adapters;
    this.#receiptLimit = adapters.limits?.receipts ??
      PLUGIN_LIMITS.completedReceipts;
    this.#causalLimit = adapters.limits?.causalDepth ??
      PLUGIN_LIMITS.causalDepth;
    this.#pendingLimit = PLUGIN_LIMITS.queuedJobs;
  }

  /** Host-only aggregate observability; no receipt bodies or SDK surface. */
  retentionCounts(): { rings: number; receipts: number; unfinished: number } {
    const receipts = [...this.#rings.values()].flatMap((ring) => ring.receipts);
    return {
      rings: this.#rings.size,
      receipts: receipts.length,
      unfinished:
        receipts.filter((receipt) =>
          ["accepted", "running"].includes(receipt.status)
        ).length,
    };
  }

  /** Acceptance-only admission. Throws synchronously for invalid actions or
   * an exceeded causal chain (visible to the requesting handler). */
  request(
    manifest: PluginManifest,
    action: string,
    args: unknown,
    ctx: ActionContext,
  ): { requestId: string } {
    if (
      !["create", "save", "rename", "delete", "file-write"].includes(action)
    ) {
      throw new Error(`unsupported action '${action}'`);
    }
    if (ctx.causalDepth + 1 > this.#causalLimit) {
      throw new Error(
        `plugin action causal chain exceeded ${this.#causalLimit} host-managed operations`,
      );
    }
    if (!ctx.current()) {
      throw new Error("plugin generation authority revoked");
    }
    const authority = requesterAuthority(
      manifest,
      this.#adapters.vaultPath,
      this.#adapters.statePath,
      ctx.generation,
      ctx.current,
    );
    const input = (args ?? {}) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("plugin action arguments must be an object");
    }
    for (const key of ["content", "newContent", "newPath", "fileRefs"]) {
      if (input[key] !== undefined && typeof input[key] !== "string") {
        throw new Error(`invalid plugin action ${key}`);
      }
    }
    if (
      input.fileRefs !== undefined &&
      !["move", "relink", "none"].includes(input.fileRefs as string)
    ) throw new Error("invalid attachment strategy");
    if (action === "file-write") {
      classifyWriteTarget(
        manifest,
        this.#adapters.vaultPath,
        this.#adapters.statePath,
        input.path as string,
      );
    } else {
      if (typeof input.path !== "string") {
        throw new Error("Note mutation requires a path");
      }
      const paths = [input.path.trim() + ".md"];
      if (typeof input.newPath === "string") {
        paths.push(input.newPath.trim() + ".md");
      }
      authority.authorize(paths);
    }
    const requestId = crypto.randomUUID();
    const capturedArgs = structuredClone(args);
    if (action === "file-write") {
      const fileArgs = capturedArgs as Record<string, unknown>;
      const bytes = fileArgs.bytes instanceof Uint8Array
        ? fileArgs.bytes
        : new Uint8Array(fileArgs.bytes as ArrayBuffer);
      // Structured clone retains shared backing memory. The admitted write
      // needs its own bytes before the acceptance can reach the Worker.
      fileArgs.bytes = new Uint8Array(bytes);
    }
    const key = this.#key(manifest.id, ctx.generation);
    let ring = this.#rings.get(key);
    if (!ring) {
      ring = {
        generation: ctx.generation,
        receipts: [],
        manifest: structuredClone(manifest),
        current: ctx.current,
        retired: false,
      };
      this.#rings.set(key, ring);
      const owned = ring;
      ctx.generationRetired.then(() => {
        owned.retired = true;
        this.#retireRing(key, owned);
      });
    }
    if (
      ring.receipts.filter((receipt) =>
        ["accepted", "running"].includes(receipt.status)
      ).length >= this.#pendingLimit
    ) throw new Error("plugin action admission capacity exhausted");
    this.#record(manifest.id, ctx.generation, {
      requestId,
      status: "accepted",
    });
    // Schedule AFTER the currently executing handler finishes — a hook can
    // never synchronously await its own downstream hooks.
    Promise.resolve().then(async () => {
      const release = await ctx.release;
      if (release.status !== "settled" || !ctx.current()) {
        this.#finish(manifest, ctx, {
          requestId,
          status: "failed",
          error: {
            code: "plugin_generation_revoked",
            detail: "requester ended before execution; no effect was started",
          },
        });
        return;
      }
      this.#execute(ring.manifest, action, capturedArgs, ctx, requestId).catch(
        () => {
          // #execute records its own receipts.
        },
      );
    });
    return { requestId };
  }

  async #execute(
    manifest: PluginManifest,
    action: string,
    args: unknown,
    ctx: ActionContext,
    requestId: string,
  ): Promise<void> {
    const finish = (receipt: Omit<ActionReceipt, "requestId">) => {
      const full: ActionReceipt = { requestId, ...receipt };
      this.#finish(manifest, ctx, full);
    };
    if (!ctx.current()) {
      finish({
        status: "failed",
        error: {
          code: "plugin_generation_revoked",
          detail:
            "owner was disabled or replaced before execution; no effect was started",
        },
      });
      return;
    }
    this.#record(manifest.id, ctx.generation, { requestId, status: "running" });
    const origin = {
      origin: "plugin" as const,
      causalParent: ctx.causalParent ?? requestId,
      causalPlugin: manifest.id,
      causalDepth: ctx.causalDepth + 1,
    };
    try {
      const a = (args ?? {}) as Record<string, unknown>;
      let result: unknown = null;
      const operationId = crypto.randomUUID();
      const requester = requesterAuthority(
        manifest,
        this.#adapters.vaultPath,
        this.#adapters.statePath,
        ctx.generation,
        ctx.current,
      );
      if (action === "create") {
        const note = await this.#adapters.operations.createNote(
          { path: a.path as string, content: a.content as string | undefined },
          origin,
          requester,
          operationId,
        );
        result = note;
      } else if (action === "save" || action === "rename") {
        const note = await this.#adapters.operations.updateNote(
          a.path as string,
          {
            newPath: a.newPath as string | undefined,
            newContent: a.newContent as string | undefined,
          },
          (a.fileRefs as string | undefined) ?? "none",
          origin,
          requester,
          operationId,
        );
        result = note;
      } else if (action === "delete") {
        await this.#adapters.operations.deleteNote(
          a.path as string,
          origin,
          requester,
          operationId,
        );
      } else if (action === "file-write") {
        const target = classifyWriteTarget(
          manifest,
          this.#adapters.vaultPath,
          this.#adapters.statePath,
          a.path as string,
        );
        const bytes = a.bytes instanceof Uint8Array
          ? a.bytes
          : new Uint8Array(a.bytes as ArrayBuffer);
        if (target.kind === "note") {
          const exists = this.#noteExists(target.notePath);
          const note = exists
            ? await this.#adapters.operations.updateNote(
              target.notePath,
              { newContent: new TextDecoder().decode(bytes) },
              "none",
              origin,
              requester,
              operationId,
            )
            : await this.#adapters.operations.createNote(
              {
                path: target.notePath,
                content: new TextDecoder().decode(bytes),
              },
              origin,
              requester,
              operationId,
            );
          result = note;
        } else {
          await this.#adapters.operations.writeExternalFile(
            target,
            bytes,
            origin,
            requester,
            operationId,
          );
        }
      }
      finish({ status: "completed", operationId, result });
    } catch (e) {
      const error = e as {
        code?: string;
        message?: string;
        operationId?: string;
      };
      finish({
        status: error.code === "operation_partial" ? "partial" : "failed",
        operationId: error.operationId,
        error: {
          code: error.code ?? "plugin_action_failed",
          detail: error.message ?? "plugin action failed",
        },
      });
    }
  }

  #noteExists(notePath: string): boolean {
    return this.#adapters.operations.noteExists(notePath);
  }

  #record(pluginId: string, generation: string, receipt: ActionReceipt): void {
    const ring = this.#rings.get(this.#key(pluginId, generation));
    if (!ring) return; // Retired generation storage is never recreated.
    const existing = ring.receipts.findIndex((r) =>
      r.requestId === receipt.requestId
    );
    if (existing >= 0) ring.receipts.splice(existing, 1);
    ring.receipts.push(receipt);
    const completed = ring.receipts.filter((value) =>
      !["accepted", "running"].includes(value.status)
    );
    for (
      const expired of completed.slice(
        0,
        Math.max(0, completed.length - this.#receiptLimit),
      )
    ) ring.receipts.splice(ring.receipts.indexOf(expired), 1);
    this.#retireRing(this.#key(pluginId, generation), ring);
  }
  #retireRing(key: string, ring: ReceiptRing): void {
    if (
      this.#rings.get(key) === ring && (ring.retired || !ring.current()) &&
      !ring.receipts.some((value) =>
        ["accepted", "running"].includes(value.status)
      )
    ) this.#rings.delete(key);
  }
  #key(pluginId: string, generation: string): string {
    return JSON.stringify([pluginId, generation]);
  }
  #finish(
    manifest: PluginManifest,
    ctx: ActionContext,
    receipt: ActionReceipt,
  ): void {
    this.#record(manifest.id, ctx.generation, receipt);
    if (!ctx.current()) return;
    const disclosed = projectActionReceipt(
      manifest,
      this.#adapters.vaultPath,
      this.#adapters.statePath,
      receipt,
    );
    try {
      this.#adapters.runtime()?.actionResult(
        manifest.id,
        ctx.generation,
        disclosed,
        {
          parentId: receipt.operationId ?? receipt.requestId,
          depth: ctx.causalDepth + 1,
        },
      );
    } catch { /* receipt remains queryable */ }
  }

  /** Generation-scoped receipt query: expired/old-generation receipts
   * return an explicit unavailable result, never a stale success. */
  result(
    pluginId: string,
    generation: string,
    requestId: string,
  ): ActionReceipt {
    const ring = this.#rings.get(this.#key(pluginId, generation));
    if (!ring || ring.retired || !ring.current()) {
      return {
        requestId,
        status: "unavailable",
        error: {
          code: "receipt_unavailable",
          detail: "receipt belongs to an expired generation or was evicted",
        },
      };
    }
    const receipt = ring.receipts.find((r) => r.requestId === requestId);
    if (receipt) {
      return projectActionReceipt(
        ring.manifest,
        this.#adapters.vaultPath,
        this.#adapters.statePath,
        receipt,
      );
    }
    return {
      requestId,
      status: "unavailable",
      error: {
        code: "receipt_unavailable",
        detail: "receipt belongs to an expired generation or was evicted",
      },
    };
  }
}
