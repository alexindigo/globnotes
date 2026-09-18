// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * @pathfinder/pathfinder owns routing: filesystem-routed endpoints
 * (server/api/endpoints/), an app-wide auth middleware (_/00-auth.ts),
 * a root crossing-rest catch-all for vault files and note pages, and a
 * package-owned /_status ops face. A thin wrapper re-homes the configured
 * path prefix onto each Request before the app sees it.
 */

import { pathfinder } from "@pathfinder/pathfinder";
import { AuthType } from "./config.ts";
import { getEnv, rewriteIndexHtml } from "./helpers.ts";
import { logger } from "./logger.ts";
import { initState } from "./state.ts";
import { runWithVault, setRegistry, tryCreateVault, type Vault, isNamespaced, registry } from "./vault.ts";
import {
  bootSpecs,
  childExcludePrefixes,
  VaultEnvError,
} from "./vault_env.ts";

let specs;
try {
  specs = bootSpecs({
    path: Deno.env.get("GLOBNOTES_PATH"),
    vaults: Deno.env.get("GLOBNOTES_VAULTS"),
  });
} catch (e) {
  if (e instanceof VaultEnvError) {
    logger.error(e.message);
    Deno.exit(1);
  }
  throw e;
}

const instancePrefix = (() => {
  const key = "GLOBNOTES_PATH_PREFIX";
  const value = getEnv(key);
  if (value && (!value.startsWith("/") || value.endsWith("/"))) {
    logger.error(
      `Invalid value '${value}' for ${key}. Must start with '/' and not end with '/'.`,
    );
    Deno.exit(1);
  }
  return value;
})();

const pathRoot = specs.find((s) => s.slug === "" || s.slug === "globnotes")
  ?.root;
const excludes = pathRoot ? childExcludePrefixes(pathRoot, specs) : [];

const vaults: Vault[] = [];
for (const spec of specs) {
  const ex = spec.slug === "" || spec.slug === "globnotes" ? excludes : [];
  const vault = tryCreateVault(spec, instancePrefix, ex);
  if (vault) vaults.push(vault);
}
if (vaults.length === 0) {
  logger.error("No vaults could be opened.");
  Deno.exit(1);
}
setRegistry(vaults);

const primary = vaults.find((v) => v.slug === "") ?? vaults[0];
initState(
  primary.config,
  primary.auth,
  primary.notes,
  primary.indexer,
  primary.files,
  primary.plugins,
);
for (const vault of vaults) vault.indexer.startBackgroundSync();

try {
  rewriteIndexHtml(
    "client/dist/index.html",
    primary.config.pathPrefix,
    primary.config.brandName,
    isNamespaced(),
  );
} catch {
  logger.debug("client/dist/index.html not present; skipping rewrite.");
}

function scrubWhoosh(root: string): void {
  const globDir = `${root}/.globnotes`;
  try {
    for (const entry of Deno.readDirSync(globDir)) {
      if (
        entry.isFile &&
        (entry.name.endsWith(".seg") || entry.name.endsWith(".toc") ||
          entry.name === "WRITELOCK")
      ) {
        Deno.removeSync(`${globDir}/${entry.name}`);
      }
    }
  } catch {
    // .globnotes doesn't exist yet — first boot
  }
}
for (const vault of vaults) scrubWhoosh(vault.root);

if (primary.config.setupRequired) {
  logger.info("First-run setup required. Open the web UI to complete setup.");
} else if (primary.config.authType === AuthType.NONE) {
  logger.warning(
    "globnotes is running with NO authentication. Anyone who can " +
      "reach this server can read and modify notes.",
  );
}
if (primary.auth?.isTotpEnabled) {
  await primary.auth.displayTotpEnrolment();
}

const hostname = getEnv("GLOBNOTES_HOST", { default: "0.0.0.0" });
const port = Number(getEnv("GLOBNOTES_PORT", { castInt: true, default: 8080 }));
const prefix = primary.config.pathPrefix;

const app = await pathfinder({
  roots: [new URL("./api/endpoints/", import.meta.url)],
});

function isInstancePath(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  return pathname === "/_" || pathname.startsWith("/_/");
}

function isBareInstanceApi(pathname: string): boolean {
  return pathname === "/_/api/health" || pathname === "/_/api/vaults";
}

Deno.serve({ hostname, port }, (req, info) => {
  const afterPrefix = (() => {
    if (!prefix) return req;
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) return null;
    const stripped = url.pathname.slice(prefix.length) || "/";
    return new Request(new URL(stripped + url.search, url.origin), req);
  })();
  if (afterPrefix === null) {
    return Response.json({ detail: "Not Found" }, { status: 404 });
  }
  const namespaced = isNamespaced();
  if (!namespaced) {
    return runWithVault(primary, () => app(afterPrefix, info));
  }
  const url = new URL(afterPrefix.url);
  if (isInstancePath(url.pathname)) {
    if (
      url.pathname.startsWith("/_/api/") && !isBareInstanceApi(url.pathname)
    ) {
      return Response.json({ detail: "Not Found" }, { status: 404 });
    }
    return app(afterPrefix, info);
  }
  const segs = url.pathname.split("/").filter(Boolean);
  const vault = registry.get(segs[0] ?? "");
  if (!vault) {
    return Response.json({ detail: "Not Found" }, { status: 404 });
  }
  const rest = "/" + segs.slice(1).join("/") || "/";
  const rewritten = new Request(
    new URL(rest + url.search, url.origin),
    afterPrefix,
  );
  return runWithVault(vault, () => app(rewritten, info));
});
logger.info(
  `globnotes listening on http://${hostname}:${port}${primary.config.pathPrefix}`,
);
