// SPDX-License-Identifier: LGPL-3.0-only

/** HTTP consumers observe the same host work as in-process fixtures. The existing
 * invalidation stream is a wake-up, never a receipt or a second work deadline. */
import type { ServiceWorkSummary } from "../../server/plugins/host.ts";
import { fixtureSignIn } from "./fixture_sign_in.ts";
import type { IdentityFixturePayload } from "./identity_fixture.ts";
import { done, failed, pending, waitUntil } from "./wait.ts";

type CatalogLogs = { stdout?: string; stderr?: string };

export interface CatalogPlugin {
  id: string;
  status: string;
  enabled?: boolean;
  runtime?: { server: boolean };
  work: ServiceWorkSummary | null;
  deliveryFailures: number;
  [key: string]: unknown;
}
export interface CatalogServer {
  baseUrl: string;
  prefix?: string;
  fixtureIdentity?: IdentityFixturePayload | null;
  pid?: number;
  status?(): { code: number; signal?: string | null } | null;
  logs?: CatalogLogs | (() => CatalogLogs);
  exited?: Promise<{ code: number }>;
}
export interface CatalogOptions {
  prefix?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Sign in independently of the browser actor. Don't spend a temporary
 * password or an authenticator code belonging to a case under test. */
export async function nativeFixtureAdmin(
  server: Pick<CatalogServer, "baseUrl" | "prefix" | "fixtureIdentity">,
  { prefix = server.prefix ?? "", signal }: Pick<
    CatalogOptions,
    "prefix" | "signal"
  > = {},
) {
  const identity = server.fixtureIdentity;
  const admin = identity?.people.find((person) =>
    identity.grants[person.login] === "admin" && !person.totpKey &&
    !person.temporary
  );
  if (!admin) {
    throw Error("Fixture has no password-only Admin for test setup/readiness");
  }
  const token = await fixtureSignIn(server.baseUrl, admin, prefix, signal);
  return { token, headers: { authorization: `Bearer ${token}` } };
}

export async function catalogRequestHeaders(
  server: CatalogServer,
  options: CatalogOptions = {},
) {
  const headers = new Headers(options.headers);
  // Bare observer ports are also used by protocol controls. An account fixture
  // instead always observes the Admin projection, never a browser credential.
  if (server.fixtureIdentity !== undefined) {
    const admin = await nativeFixtureAdmin(server, options);
    headers.set("authorization", admin.headers.authorization);
  }
  return headers;
}

type Lane = "ordinary" | "versioning" | "guard";
const lanes: readonly Lane[] = ["ordinary", "versioning", "guard"];
export interface WorkFence {
  generation: string;
  deliveryFailures: number;
  lanes: Partial<Record<Lane, { admitted: number; failures: number }>>;
}

/** Capture before the action for failure baselines; capture again afterward for
 * its admitted fence. Never infer a clean baseline from evictable diagnostics. */
export function captureWork(
  plugin: CatalogPlugin,
  selected: readonly Lane[] = lanes,
): WorkFence {
  if (!plugin.work) throw Error(`plugin '${plugin.id}' work owner unavailable`);
  return {
    generation: plugin.work.generation,
    deliveryFailures: plugin.deliveryFailures,
    lanes: Object.fromEntries(selected.map((lane) => [lane, {
      admitted: plugin.work![lane].admitted,
      failures: plugin.work![lane].failures,
    }])),
  };
}

/** A new baseline may not absorb work admitted after the captured fence. */
export function captureSettledWork(
  plugin: CatalogPlugin,
  selected: readonly Lane[] = lanes,
): WorkFence {
  const baseline = captureWork(plugin, selected);
  for (const lane of selected) {
    const { pending, admitted, settled } = plugin.work![lane];
    if (pending !== 0 || settled !== admitted) {
      throw Error(
        `plugin '${plugin.id}' ${lane} work still pending at baseline`,
      );
    }
  }
  return baseline;
}

export class CatalogWorkFailure extends Error {
  constructor(readonly plugin: CatalogPlugin, readonly fence: WorkFence) {
    super(`plugin '${plugin.id}' work failed: ${JSON.stringify(plugin)}`);
    this.name = "CatalogWorkFailure";
  }
}

/** Conservative success: any unexpected failure rejects, including later work.
 * A negative control may project exact expected failures from a settled
 * baseline; it must verify the failure's identity separately. */
export function workFenceSettled(
  plugin: CatalogPlugin | undefined,
  fence: WorkFence,
  baseline: WorkFence = fence,
): boolean {
  if (
    !plugin?.work || plugin.work.generation !== fence.generation ||
    baseline.generation !== fence.generation
  ) throw Error("plugin work owner replaced or retired before settlement");
  if (plugin.status === "failed" || plugin.work.startup.state === "failed") {
    throw Error(`plugin '${plugin.id}' failed: ${JSON.stringify(plugin)}`);
  }
  // Failure counts are a terminal cohort verdict, not a wake-up to inspect a
  // different snapshot while another selected lane is still running.
  if (
    !lanes.every((lane) => {
      const position = fence.lanes[lane];
      return !position || plugin.work![lane].settled >= position.admitted;
    })
  ) return false;
  const failure = lanes.find((lane) => {
    const before = baseline.lanes[lane];
    return before && plugin.work![lane].failures !== before.failures;
  });
  if (failure || plugin.deliveryFailures !== baseline.deliveryFailures) {
    throw new CatalogWorkFailure(plugin, fence);
  }
  return true;
}

/** Subscribe before the first read. Capture changed before each read so an event
 * arriving during that read cannot be lost. Closed streams fail, not reconnect. */
export async function observeCatalog(
  server: CatalogServer,
  options: CatalogOptions = {},
) {
  const abort = new AbortController();
  let changed = Promise.withResolvers<void>();
  let failure: Error | undefined;
  const wake = () => {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };
  server.exited?.then((status) => {
    failure = Error(`catalog server exited: ${status.code}`);
    abort.abort(failure);
    wake();
  }, (error) => {
    failure = error;
    abort.abort(error);
    wake();
  });
  const signal = options.signal
    ? AbortSignal.any([abort.signal, options.signal])
    : abort.signal;
  const headers = await catalogRequestHeaders(server, { ...options, signal });
  const url = `${server.baseUrl}${
    options.prefix ?? server.prefix ?? ""
  }/_/api/plugin-host`;
  const response = await fetch(`${url}/events`, {
    headers,
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error(`catalog events rejected: ${response.status}`);
  }
  const pumping = (async () => {
    let buffer = "";
    try {
      for await (
        const text of response.body!.pipeThrough(new TextDecoderStream())
      ) {
        buffer += text;
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^event: (hello|invalidate)$/m.test(frame)) wake();
          if (/^event: close$/m.test(frame)) {
            throw Error(`catalog event stream closed: ${frame}`);
          }
        }
      }
      if (!abort.signal.aborted) throw Error("catalog event stream ended");
    } catch (error) {
      if (!abort.signal.aborted) {
        failure = error instanceof Error ? error : Error(String(error));
        wake();
      }
    }
  })();
  return {
    get changed() {
      return changed.promise;
    },
    async read(signal?: AbortSignal): Promise<CatalogPlugin[]> {
      if (failure) throw failure;
      if (server.status?.()) throw Error("catalog server exited");
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.any([
          abort.signal,
          ...options.signal ? [options.signal] : [],
          ...signal ? [signal] : [],
        ]),
      });
      if (!response.ok) {
        throw Error(
          `catalog rejected: ${response.status}; ${await response.text()}`,
        );
      }
      return (await response.json()).plugins;
    },
    async close() {
      abort.abort();
      await pumping;
    },
  };
}

export async function catalogWorkSettled(
  server: CatalogServer,
  id: string,
  options: CatalogOptions & {
    lanes?: readonly Lane[];
    baseline?: WorkFence;
  } = {},
): Promise<CatalogPlugin> {
  const observer = await observeCatalog(server, options);
  try {
    let changed = observer.changed;
    let plugin = (await observer.read()).find((item) => item.id === id);
    if (!plugin) throw Error(`plugin '${id}' absent`);
    const fence = captureWork(plugin, options.lanes);
    while (!workFenceSettled(plugin, fence, options.baseline)) {
      await changed;
      changed = observer.changed;
      plugin = (await observer.read()).find((item) => item.id === id);
    }
    return plugin!;
  } finally {
    await observer.close();
  }
}

/** Only admission and final publication without a bounded startup owner retain
 * readiness. Once captured, initialization follows that exact owner's deadline. */
export async function catalogPluginReady(
  server: CatalogServer,
  id: string,
  options: CatalogOptions & { allowFailed?: boolean; label?: string } = {},
): Promise<CatalogPlugin> {
  let observer: Awaited<ReturnType<typeof observeCatalog>> | undefined;
  const logs = server.logs;
  const children = server.pid && server.status
    ? [{
      pid: server.pid,
      status: server.status,
      logs: typeof logs === "function" ? logs : () => logs ?? {},
    }]
    : [];
  try {
    const read = async (signal?: AbortSignal) =>
      (await observer!.read(signal)).find((item) => item.id === id);
    const admitted = await waitUntil(async (signal) => {
      observer ??= await observeCatalog(server, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
      });
      const plugin = await read(signal);
      if (plugin?.status === "failed" && !options.allowFailed) {
        return failed(`plugin '${id}' failed`, plugin);
      }
      if (
        plugin?.status === "ready" || plugin?.status === "failed" ||
        plugin?.work
      ) {
        return done(plugin);
      }
      return pending(plugin ?? { id, status: "absent" });
    }, {
      label: options.label ?? `plugin '${id}' catalogue admission`,
      children,
    });
    const generation = admitted.work?.generation;
    let plugin: CatalogPlugin | undefined = admitted;
    while (plugin?.work?.startup.state === "pending") {
      const changed = observer!.changed;
      plugin = await read();
      if (plugin?.status === "failed") break;
      if (!plugin?.work || plugin.work.generation !== generation) {
        throw Error(`plugin '${id}' startup owner replaced or retired`);
      }
      if (plugin.work.startup.state === "pending") await changed;
    }
    return await waitUntil(async (signal) => {
      const plugin = await read(signal);
      if (plugin?.status === "failed") {
        return options.allowFailed
          ? done(plugin)
          : failed(`plugin '${id}' failed`, plugin);
      }
      if (generation && plugin?.work?.generation !== generation) {
        return failed(
          `plugin '${id}' startup owner replaced or retired`,
          plugin,
        );
      }
      return plugin?.status === "ready" ? done(plugin) : pending(plugin);
    }, {
      label: options.label ?? `plugin '${id}' catalogue publication`,
      children,
    });
  } finally {
    await observer?.close();
  }
}
