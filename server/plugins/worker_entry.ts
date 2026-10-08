/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
// SPDX-License-Identifier: LGPL-3.0-only

/** Handler functions never leave their owning Worker. The host binds authority. */
import {
  type CommandDefinition,
  type HandlerRegistration,
  HOOK_NAMES,
  type HookName,
  type HostMessage,
  HTTP_METHODS,
  type JsonValues,
  jsonValues,
  type WorkerMessage,
} from "./contracts.ts";
import {
  currentWorkerContext,
  revokeWorkerContext,
  runBackground,
  runInvocation,
  setBackgroundContext,
} from "./worker_context.ts";
import type {
  AccessAdmission,
  PermissionPublicationOptions,
  PermissionView,
  Source,
} from "./network_contracts.ts";

type Handler = (...args: unknown[]) => unknown;
type Disposer = () => unknown;
interface PluginModule {
  getSelectors?: () => unknown;
  parseNode?: (node: unknown, ctx: PluginCtx) => unknown;
  onSync?: (ctx: PluginCtx) => unknown;
  activate?: (ctx: PluginCtx) => unknown;
  deactivate?: (ctx: PluginCtx) => unknown;
}
export interface PluginCtx {
  search(term: string): Promise<unknown>;
  readNote(path: string): Promise<unknown>;
  listPaths(): Promise<unknown>;
  readFile(path: string): Promise<unknown>;
  pathPrefix(): Promise<string>;
  resolvePath(target: string): Promise<string>;
  hooks: { on(name: HookName, handler: Handler): Disposer };
  commands: {
    register(definition: CommandDefinition, handler: Handler): Disposer;
  };
  settings: { read(): Promise<unknown>; subscribe(handler: Handler): Disposer };
  permissions: {
    declare(
      input: unknown,
      options?: PermissionPublicationOptions,
    ): Promise<PermissionView>;
    requestAccess(
      input: unknown,
      options?: PermissionPublicationOptions,
    ): Promise<AccessAdmission>;
    status(): Promise<PermissionView>;
  };
  data: {
    load(): Promise<unknown>;
    save(values: JsonValues, revision: number): Promise<unknown>;
  };
  actions: {
    request(action: string, args: unknown): Promise<unknown>;
    onResult(handler: Handler): Disposer;
    result(requestId: string): Promise<unknown>;
  };
  files: {
    read(path: string): Promise<unknown>;
    requestWrite(path: string, bytes: Uint8Array): Promise<unknown>;
  };
  snapshot: JsonValues;
  register(disposer: Disposer): Disposer;
  timers: {
    setTimeout(handler: Disposer, ms: number): Disposer;
    setInterval(handler: Disposer, ms: number): Disposer;
  };
}

let generation = "";
let role: "render" | "service" = "render";
let plugin: PluginModule | null = null;
let stopping = false;
let sequence = 0;
let declaredHooks = new Set<HookName>();
let permissionsSource: Source | undefined;
const handlers = new Map<string, Handler>();
const handlerKinds = new Map<string, HandlerRegistration["kind"]>();
const resources = new Set<Disposer>();
const pendingRpc = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
function send(message: WorkerMessage) {
  self.postMessage(message);
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message : "plugin handler failed";
}
function rpc(method: string, args: unknown[]): Promise<unknown> {
  if (stopping) {
    return Promise.reject(new Error("plugin generation is stopping"));
  }
  let context;
  try {
    context = currentWorkerContext();
  } catch (error) {
    return Promise.reject(error);
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    send({
      type: "rpc",
      generation,
      id,
      method,
      args,
      pre: context.pre,
      contextId: context.id,
    });
  });
}
function own(disposer: Disposer): Disposer {
  if (stopping) throw new Error("plugin generation is stopping");
  if (typeof disposer !== "function") {
    throw new Error("disposer must be callable");
  }
  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    resources.delete(release);
    return disposer();
  };
  resources.add(release);
  return release;
}
function register(
  registration: HandlerRegistration,
  handler: Handler,
): Disposer {
  if (stopping) throw new Error("plugin generation is stopping");
  if (role !== "service") {
    throw new Error("application handlers require the server runtime entry");
  }
  if (typeof handler !== "function") {
    throw new Error("handler must be callable");
  }
  const handlerId = `handler-${++sequence}`;
  jsonValues(registration);
  handlers.set(handlerId, handler);
  handlerKinds.set(handlerId, registration.kind);
  send({ type: "register", generation, handlerId, registration });
  return own(() => {
    handlers.delete(handlerId);
    handlerKinds.delete(handlerId);
    send({ type: "unregister", generation, handlerId });
  });
}
function timer(
  callback: Disposer,
  milliseconds: number,
  interval: boolean,
): Disposer {
  if (stopping) throw new Error("plugin generation is stopping");
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("timer duration must be non-negative");
  }
  const run = () => {
    if (stopping) return;
    if (!interval) release();
    runBackground(() =>
      Promise.resolve().then(callback).catch(() => {
        rpc("diagnostic", ["managed_timer_failed"]).catch(() => undefined);
      })
    );
  };
  const id = interval
    ? setInterval(run, milliseconds)
    : setTimeout(run, milliseconds);
  const release = own(() => interval ? clearInterval(id) : clearTimeout(id));
  return release;
}
const ctx: PluginCtx = {
  search: (term) => rpc("search", [term]),
  readNote: (path) => rpc("readNote", [path]),
  listPaths: () => rpc("listPaths", []),
  readFile: (path) => rpc("readFile", [path]),
  pathPrefix: () => rpc("pathPrefix", []) as Promise<string>,
  resolvePath: (target) => rpc("resolvePath", [target]) as Promise<string>,
  hooks: {
    on: (name, handler) => {
      if (!HOOK_NAMES.includes(name) || !declaredHooks.has(name)) {
        throw new Error("hook must be supported and declared in the manifest");
      }
      return register({ kind: "hook", id: name }, handler);
    },
  },
  commands: {
    register: (definition, handler) =>
      register({ kind: "command", id: definition.id, definition }, handler),
  },
  settings: {
    read: () => rpc("settings.read", []),
    subscribe: (handler) =>
      register({ kind: "settings-change", id: "settings-change" }, handler),
  },
  permissions: {
    declare: (input, options) =>
      rpc("permissions.declare", [
        input,
        options ?? { source: permissionsSource },
      ]) as Promise<PermissionView>,
    requestAccess: (input, options) =>
      rpc("permissions.requestAccess", [
        input,
        options ?? { source: permissionsSource },
      ]) as Promise<AccessAdmission>,
    status: () => rpc("permissions.status", []) as Promise<PermissionView>,
  },
  data: {
    load: () => rpc("data.load", []),
    save: (values, revision) =>
      rpc("data.save", [jsonValues(values), revision]),
  },
  actions: {
    request: (action, args) => {
      // Synchronous rejection: a guard must never schedule mutations, and
      // a try/catch in the handler must see it (the host re-checks anyway).
      if (currentWorkerContext().pre) {
        throw new Error(
          "mutating action requests are forbidden during a pre-hook",
        );
      }
      return rpc("actions.request", [action, args]);
    },
    onResult: (handler) =>
      register({ kind: "action-result", id: "action-result" }, handler),
    result: (requestId) => rpc("actions.result", [requestId]),
  },
  files: {
    read: (path) => rpc("files.read", [path]),
    requestWrite: (path, bytes) => {
      if (currentWorkerContext().pre) {
        throw new Error(
          "mutating action requests are forbidden during a pre-hook",
        );
      }
      return rpc("files.requestWrite", [path, bytes]);
    },
  },
  snapshot: {},
  register: own,
  timers: {
    setTimeout: (handler, ms) => timer(handler, ms, false),
    setInterval: (handler, ms) => timer(handler, ms, true),
  },
};
const renderAdapters: Record<
  string,
  (module: PluginModule, args: unknown[]) => unknown
> = {
  getSelectors: (module) => module.getSelectors?.(),
  parseNode: (module, args) => module.parseNode?.(args[0], ctx),
  onSync: (module) => module.onSync?.(ctx),
};
async function cleanup(): Promise<string[]> {
  const errors: string[] = [];
  for (const release of [...resources].reverse()) {
    try {
      await release();
    } catch (error) {
      errors.push(reason(error));
    }
  }
  resources.clear();
  handlers.clear();
  handlerKinds.clear();
  for (const pending of pendingRpc.values()) {
    pending.reject(new Error("plugin generation disposed"));
  }
  pendingRpc.clear();
  return errors;
}

/** Only this permission-narrowed process imports plugin endpoint code. */
async function discoverEndpoints(root: string, relative = ""): Promise<void> {
  const encodePath = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  const directory = new URL(relative ? `${encodePath(relative)}/` : "./", root);
  const canonicalRoot = Deno.realPathSync(new URL(root));
  const canonical = Deno.realPathSync(directory);
  if (
    canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}/`)
  ) throw new Error("endpoint directory escapes its plugin root");
  for (const entry of Deno.readDirSync(directory)) {
    if (entry.name.startsWith(".")) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await discoverEndpoints(root, name);
      continue;
    }
    const match = /^(get|post|put|patch|delete|head|options)\.(js|mjs|ts)$/
      .exec(entry.name);
    if (!match) continue;
    const url = new URL(encodePath(name), root);
    const file = Deno.realPathSync(url);
    if (!file.startsWith(`${canonicalRoot}/`)) {
      throw new Error("endpoint module escapes its plugin root");
    }
    const module = await import(url.href);
    if (typeof module.default !== "function") {
      throw new Error("endpoint module requires a default handler");
    }
    const method = match[1].toUpperCase() as typeof HTTP_METHODS[number];
    const pattern = relative ? `/${relative}` : "/";
    register({
      kind: "endpoint",
      id: `${method} ${pattern}`,
      definition: { method, pattern },
    }, (request) => module.default(request, ctx));
  }
}

setInterval(() => send({ type: "heartbeat", generation }), 250);

// Fault isolation: a plugin's unhandled rejection is a diagnostic, never a
// worker crash that forfeits registrations and in-flight outcomes.
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  rpc("diagnostic", ["unhandled_rejection"]).catch(() => undefined);
});
function immutable(value: unknown): unknown {
  if (
    value && typeof value === "object" && !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer)
  ) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
self.onmessage = async (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    if (generation) return;
    generation = message.generation;
    setBackgroundContext(message.context);
    role = message.role;
    declaredHooks = new Set(message.hooks);
    permissionsSource = message.permissionsSource;
    ctx.snapshot = immutable(structuredClone(message.snapshot)) as JsonValues;
    try {
      await runBackground(async () => {
        plugin = message.pluginUrl ? await import(message.pluginUrl) : {};
        if (
          role === "service" && message.pluginUrl &&
          typeof plugin?.activate !== "function"
        ) throw new Error("server runtime entry requires activate(ctx)");
        if (role === "service") {
          await plugin?.activate?.(ctx);
          if (message.endpointsUrl) {
            await discoverEndpoints(message.endpointsUrl);
          }
        }
      });
      send({
        type: "ready",
        generation,
        exports: Object.keys(plugin ?? {}).filter((key) =>
          typeof plugin?.[key as keyof PluginModule] === "function"
        ),
      });
    } catch (error) {
      await cleanup();
      send({
        type: "initError",
        generation,
        value: role === "service"
          ? "server entry activation or endpoint initialization failed"
          : reason(error),
      });
    }
    return;
  }
  if (message.generation !== generation) return;
  if (message.type === "rpcResponse") {
    const pending = pendingRpc.get(message.id);
    if (pending) {
      pendingRpc.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else {
        const error = Object.assign(
          new Error(String(message.value)),
          message.error ?? {},
        );
        pending.reject(error);
      }
      if (message.receiptRequired) {
        send({ type: "rpcReceipt", generation, id: message.id });
      }
    }
    return;
  }
  if (message.type === "dispose") {
    stopping = true;
    revokeWorkerContext();
    const errors: string[] = [];
    try {
      await plugin?.deactivate?.(ctx);
    } catch (error) {
      errors.push(reason(error));
    }
    errors.push(...await cleanup());
    send({
      type: "result",
      generation,
      id: message.id,
      contextId: message.context.id,
      ok: true,
      value: { errors },
    });
    return;
  }
  if (stopping) return;
  try {
    const value = await runInvocation(message.context, async () => {
      let value: unknown;
      if (message.type === "invoke") {
        const handler = handlers.get(message.handlerId);
        if (!handler) throw new Error("handler registration is unavailable");
        if (
          ["hook", "settings-change", "action-result"].includes(
            handlerKinds.get(message.handlerId) ?? "",
          )
        ) message.args.forEach(immutable);
        value = await handler(...message.args);
      } else {
        if (
          !plugin ||
          typeof plugin[message.fn as keyof PluginModule] !== "function"
        ) throw new Error(`plugin has no export '${message.fn}'`);
        const adapter = renderAdapters[message.fn];
        if (!adapter) throw new Error("unsupported rendering adapter");
        value = await adapter(plugin, message.args);
      }
      return value;
    });
    send({
      type: "result",
      generation,
      id: message.id,
      contextId: message.context.id,
      ok: true,
      value,
    });
  } catch (error) {
    send({
      type: "result",
      generation,
      id: message.id,
      contextId: message.context.id,
      ok: false,
      value: role === "service" ? "plugin handler failed" : reason(error),
    });
  }
};
