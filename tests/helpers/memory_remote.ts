// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DiscoveryPage,
  Entry,
  ExportItem,
} from "../../server/plugins/driver_contract.ts";

/** A real authenticated HTTP object store. Only tests hold the controls; the
 * driver sees ordinary provider requests, random native ETags and lost replies. */
export interface RemoteRequest {
  method: string;
  path: string;
  key?: string;
  cursor?: string;
  ifMatch: string | null;
  ifNoneMatch: string | null;
  authorized: boolean;
}
export interface RemoteFault {
  method?: string;
  path?: string;
  key?: string;
  cursor?: string;
  status?: number;
  message?: string;
  retryAfterMs?: number;
  empty?: boolean;
  dropAfterCommit?: boolean;
  before?: () => void | Promise<void>;
}
export function memoryRemote(options: {
  hostname?: string;
  token?: string;
  pageSize?: number;
} = {}) {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const requests: RemoteRequest[] = [], faults: RemoteFault[] = [];
  const token = options.token ?? "memory-token";
  const id = crypto.randomUUID();
  const changes = new Map<string, { seq: number; entry: Entry }>();
  const batches: ExportItem[][] = [];
  let sequence = 0;
  const native: {
    scope: string;
    groups: boolean;
    unknown?: string;
    override?: Record<string, unknown>;
    hang?: boolean;
  } = { scope: "all", groups: false };
  let epoch = crypto.randomUUID();
  let pageSize = options.pageSize ?? 1000;
  const put = (key: string, bytes: string | Uint8Array) => {
    const value = {
      bytes: typeof bytes === "string"
        ? new TextEncoder().encode(bytes)
        : bytes.slice(),
      etag: crypto.randomUUID(),
    };
    objects.set(key, value);
    changes.set(key, {
      seq: ++sequence,
      entry: {
        state: "known",
        path: key,
        revision: value.etag,
        size: value.bytes.length,
      },
    });
    return value.etag;
  };
  const remove = (key: string) => {
    const removed = objects.delete(key);
    if (removed) {
      changes.set(key, {
        seq: ++sequence,
        entry: { state: "absent", path: key, proof: "native-delete" },
      });
    }
    return removed;
  };
  const server = Deno.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: 0,
    onListen() {},
    onError: () => new Response("transport interrupted", { status: 500 }),
  }, async (request) => {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const event: RemoteRequest = {
      method: request.method,
      path: url.pathname,
      ...(key === undefined ? {} : { key }),
      ...(cursor === undefined ? {} : { cursor }),
      ifMatch: request.headers.get("if-match"),
      ifNoneMatch: request.headers.get("if-none-match"),
      authorized: request.headers.get("authorization") === `Bearer ${token}`,
    };
    requests.push(event); // Never retain authorization values in the request log.
    if (!event.authorized) {
      return new Response("Authentication required", { status: 401 });
    }
    const index = faults.findIndex((fault) =>
      (fault.method === undefined || fault.method === event.method) &&
      (fault.path === undefined || fault.path === event.path) &&
      (fault.key === undefined || fault.key === event.key) &&
      (fault.cursor === undefined || fault.cursor === event.cursor)
    );
    const fault = index < 0 ? undefined : faults.splice(index, 1)[0];
    await fault?.before?.();
    if (fault?.status) {
      return new Response(fault.message ?? "Injected provider failure", {
        status: fault.status,
        headers: fault.retryAfterMs === undefined
          ? {}
          : { "x-retry-after-ms": String(fault.retryAfterMs) },
      });
    }
    if (url.pathname === "/identity") return Response.json({ id, epoch });
    if (url.pathname === "/native/discover") {
      const mode = url.searchParams.get("mode") === "delta"
        ? "delta"
        : "snapshot";
      const offset = Number(cursor?.split(":")[1] ?? 0);
      const available = [...changes.values()].filter((change) =>
        mode === "snapshot"
          ? objects.has(change.entry.path!)
          : change.seq > offset
      )
        .sort((a, b) =>
          mode === "snapshot"
            ? a.entry.path!.localeCompare(b.entry.path!)
            : a.seq - b.seq
        );
      const selected = mode === "snapshot"
        ? available.slice(offset, offset + pageSize)
        : available.slice(0, pageSize);
      const more = mode === "snapshot"
        ? available.length > offset + pageSize
        : available.length > pageSize;
      const entries = selected.map(({ entry }) =>
        entry.path === native.unknown
          ? {
            state: "unknown" as const,
            path: entry.path,
            reason: "could_not_check",
          }
          : entry
      );
      const page: DiscoveryPage = {
        endpoint: { id, epoch },
        scope: native.scope,
        mode,
        entries,
        completion: more ? "more" : "complete",
        cursor: more
          ? `${mode === "snapshot" ? "s" : "d"}:${
            mode === "snapshot" ? offset + pageSize : selected.at(-1)!.seq
          }`
          : `d:${sequence}`,
        ...(native.groups && entries.length
          ? {
            groups: [{
              id: "native-group",
              members: entries.map((entry) => entry.path!),
            }],
          }
          : {}),
      };
      return Response.json({
        ...page,
        ...native.override,
        ...(native.hang ? { hang: true } : {}),
      });
    }
    if (url.pathname === "/native/apply" && request.method === "POST") {
      const items = (await request.json() as ExportItem[]).map((item) => ({
        ...item,
        ...(item.bytes ? { bytes: new Uint8Array(item.bytes) } : {}),
      }));
      batches.push(items);
      const conflict = items.some((item) =>
        "absent" in item.base
          ? objects.has(item.path)
          : objects.get(item.path)?.etag !== item.base.revision
      );
      if (conflict) {
        return Response.json(
          items.map(({ id }) => ({ id, state: "conflict" })),
        );
      }
      const receipts = items.map((item) => {
        if (item.op === "put") {
          return {
            id: item.id,
            state: "settled",
            revision: put(item.path, item.bytes!),
          };
        }
        remove(item.path);
        return { id: item.id, state: "settled" };
      });
      return Response.json(receipts);
    }
    if (url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = fault?.empty
        ? []
        : [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      if (!Number.isSafeInteger(start) || start < 0) {
        return new Response("Invalid cursor", { status: 400 });
      }
      const selected = keys.slice(start, start + pageSize);
      return Response.json({
        entries: selected.map((key) => ({
          key: key.slice(prefix.length),
          size: objects.get(key)!.bytes.length,
          etag: objects.get(key)!.etag,
        })),
        ...(start + pageSize < keys.length
          ? { next: String(start + pageSize) }
          : {}),
      });
    }
    if (url.pathname !== "/object" || key === undefined) {
      return new Response("Not found", { status: 404 });
    }
    const current = objects.get(key);
    if (request.method === "GET") {
      return current
        ? new Response(current.bytes.slice(), {
          headers: { etag: current.etag },
        })
        : new Response("Not found", { status: 404 });
    }
    if (
      event.ifNoneMatch === "*" && current ||
      event.ifMatch !== null && event.ifMatch !== current?.etag
    ) {
      return new Response("Version changed", { status: 412 });
    }
    let response: Response;
    if (request.method === "PUT") {
      const etag = put(key, new Uint8Array(await request.arrayBuffer()));
      response = Response.json({ etag });
    } else if (request.method === "DELETE") {
      if (!current) return new Response("Not found", { status: 404 });
      remove(key);
      response = new Response(null, { status: 204 });
    } else return new Response("Method not allowed", { status: 405 });
    if (fault?.dropAfterCommit) {
      // A response body error aborts native fetch body acquisition after commit.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Injected lost reply"));
          },
        }),
      );
    }
    return response;
  });
  const authority = `${options.hostname ?? "127.0.0.1"}:${
    (server.addr as Deno.NetAddr).port
  }`;
  return {
    baseUrl: `http://${authority}`,
    authority,
    token,
    objects,
    requests,
    faults,
    native,
    batches,
    put,
    delete: remove,
    clear: () => {
      for (const key of objects.keys()) remove(key);
    },
    resetEpoch: () => {
      epoch = crypto.randomUUID();
    },
    pageSize: (value: number) => {
      pageSize = value;
    },
    text: (key: string) => {
      const value = objects.get(key);
      return value ? new TextDecoder().decode(value.bytes) : null;
    },
    close: () => server.shutdown(),
  };
}
