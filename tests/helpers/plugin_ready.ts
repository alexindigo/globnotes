// SPDX-License-Identifier: LGPL-3.0-only

/** Readiness of a plugin in an in-process PluginRuntime, through the shared
 * readiness wait (tests/helpers/wait.ts). */

import { done, failed, pending, waitUntil } from "./wait.ts";

interface StatusSource<S extends { status: string }> {
  status(id: string): S | null | undefined;
}

/** Wait until plugin `id` is no longer "starting" and return its status.
 * With `expect`, settling in any other state fails at once with the full
 * status (diagnostics included). */
export function pluginSettled<S extends { status: string }>(
  runtime: StatusSource<S>,
  id: string,
  expect?: "ready" | "failed",
): Promise<S | null | undefined> {
  return waitUntil(() => {
    const status = runtime.status(id);
    if (status?.status === "starting") return pending(status);
    if (expect && status?.status !== expect) {
      return failed(
        `plugin '${id}' is ${status?.status ?? "absent"}, expected ${expect}`,
        status,
      );
    }
    return done(status);
  }, { label: `plugin '${id}' settled${expect ? ` (${expect})` : ""}` });
}

/** The parts of a test server (tests/helpers/boot.ts) a catalog wait uses. */
interface CatalogServer {
  baseUrl: string;
  pid: number;
  status(): { code: number; signal?: string | null } | null;
  logs?(): { stdout?: string; stderr?: string };
}

/** Wait until plugin `id` is ready in the server's plugin catalog and return
 * its catalog entry. A failed plugin, a rejected catalog request or an
 * exited server fails the wait at once with the full entry. */
export function catalogPluginReady(
  server: CatalogServer,
  id: string,
  options: { prefix?: string; headers?: HeadersInit } = {},
): Promise<{ id: string; status: string; [key: string]: unknown }> {
  return waitUntil(async (signal) => {
    const response = await fetch(
      `${server.baseUrl}${options.prefix ?? ""}/_/api/plugin-host`,
      { headers: options.headers, signal },
    );
    if (!response.ok) {
      return failed(`catalog rejected: ${response.status}`, {
        status: response.status,
        body: await response.text(),
      });
    }
    const catalog = await response.json();
    const plugin = catalog.plugins.find((entry: { id: string }) =>
      entry.id === id
    );
    if (plugin?.status === "ready") return done(plugin);
    if (plugin?.status === "failed") {
      return failed(`plugin '${id}' failed`, plugin);
    }
    return pending(plugin ?? { id, status: "absent" });
  }, {
    label: `plugin '${id}' ready in the catalog`,
    children: [server],
  });
}
