// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin worker entry point — runs INSIDE a permission-narrowed Deno
 * Worker. Protocol (structured-clone postMessage):
 *
 *   host → worker:
 *     { type: "init", pluginUrl }
 *     { type: "call", id, fn, args }          — getSelectors / parseNode / onSync
 *     { type: "rpcResponse", id, ok, value }  — answers to ctx RPCs
 *
 *   worker → host:
 *     { type: "ready" }                        — plugin loaded
 *     { type: "heartbeat", ts }
 *     { type: "result", id, ok, value }        — answers to "call"
 *     { type: "rpc", id, method, args }        — ctx back-channel
 *
 * The plugin itself never sees this file; it receives a plain `ctx`
 * object whose methods are async RPC stubs.
 */

interface PluginModule {
  getSelectors?: () => unknown;
  parseNode?: (node: unknown, ctx: PluginCtx) => unknown;
  onSync?: (ctx: PluginCtx) => unknown;
}

export interface PluginCtx {
  search(term: string): Promise<unknown>;
  readNote(title: string): Promise<unknown>;
  listTitles(): Promise<unknown>;
  readFile(path: string): Promise<unknown>;
}

let plugin: PluginModule | null = null;
const pendingRpc = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let rpcSeq = 0;

function rpc(method: string, args: unknown[]): Promise<unknown> {
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    self.postMessage({ type: "rpc", id, method, args });
  });
}

const ctx: PluginCtx = {
  search: (term) => rpc("search", [term]),
  readNote: (title) => rpc("readNote", [title]),
  listTitles: () => rpc("listTitles", []),
  readFile: (path) => rpc("readFile", [path]),
};

// Heartbeat: the host treats silence as a hang.
const HEARTBEAT_MS = 250;
setInterval(() => {
  self.postMessage({ type: "heartbeat", ts: Date.now() });
}, HEARTBEAT_MS);

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      plugin = (await import(msg.pluginUrl)) as PluginModule;
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({
        type: "result",
        id: -1,
        ok: false,
        value: String(e),
      });
    }
    return;
  }
  if (msg.type === "rpcResponse") {
    const p = pendingRpc.get(msg.id);
    if (p) {
      pendingRpc.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(String(msg.value)));
    }
    return;
  }
  if (msg.type === "call") {
    const { id, fn, args } = msg;
    try {
      if (!plugin) throw new Error("plugin not initialised");
      const target = plugin[fn as keyof PluginModule];
      if (typeof target !== "function") {
        throw new Error(`plugin has no export '${fn}'`);
      }
      let value: unknown;
      if (fn === "getSelectors") {
        value = (target as () => unknown).call(plugin);
      } else if (fn === "parseNode") {
        value = await (target as PluginModule["parseNode"])!(
          args[0],
          ctx,
        );
      } else if (fn === "onSync") {
        value = await (target as PluginModule["onSync"])!(ctx);
      } else {
        throw new Error(`unknown call '${fn}'`);
      }
      self.postMessage({ type: "result", id, ok: true, value });
    } catch (e) {
      self.postMessage({
        type: "result",
        id,
        ok: false,
        value: e instanceof Error ? e.message : String(e),
      });
    }
  }
};
