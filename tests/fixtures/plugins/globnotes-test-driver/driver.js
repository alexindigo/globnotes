// SPDX-License-Identifier: LGPL-3.0-only
// Test-only reference provider. Never shipped in plugins/.
export function createProvider(ctx) {
  const { baseUrl, prefix, exclude, forbiddenCharacters } =
    ctx.instance.settings;
  const ignored = exclude.split(",").map((value) => value.trim()).filter(
    Boolean,
  );
  const { StorageError } = ctx.driver;
  async function request(route, method = "GET", key, body, condition = {}) {
    const url = new URL(route, baseUrl);
    if (key !== undefined) url.searchParams.set("key", prefix + key);
    if (url.pathname === "/list") url.searchParams.set("prefix", prefix);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${await ctx.secrets.get("token")}`,
          ...(condition.ifMatch ? { "if-match": condition.ifMatch } : {}),
          ...(condition.ifNoneMatch
            ? { "if-none-match": condition.ifNoneMatch }
            : {}),
        },
        body,
      });
    } catch (error) {
      if (["NotCapable", "PermissionDenied"].includes(error.name)) throw error;
      throw new StorageError("network", {
        effect: method === "GET" ? "none" : "unknown",
      });
    }
    if (!response.ok) {
      const code = {
        400: "invalid",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        412: "precondition_failed",
        429: "rate_limited",
      }[response.status] ?? "unavailable";
      throw new StorageError(code, {
        effect: response.status >= 500 && method !== "GET" ? "unknown" : "none",
        retryAfterMs: Number(response.headers.get("x-retry-after-ms")) ||
          undefined,
        message: await response.text(),
      });
    }
    return response;
  }
  return {
    conditions: { create: true, update: true, delete: true },
    identity: async () => await (await request("/identity")).json(),
    list: async (cursor) => {
      const route = cursor === undefined
        ? "/list"
        : `/list?cursor=${encodeURIComponent(cursor)}`;
      const response = await request(route);
      return await response.json();
    },
    get: async (key) => {
      const response = await request("/object", "GET", key);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        etag: response.headers.get("etag"),
      };
    },
    put: async (key, bytes, condition) =>
      await (await request("/object", "PUT", key, bytes, condition)).json(),
    delete: async (key, condition) => {
      await request("/object", "DELETE", key, undefined, condition);
    },
    exclude: (key) => ignored.some((value) => key.startsWith(value)),
    scope: () => JSON.stringify({ prefix, ignored, forbiddenCharacters }),
    name: (path) =>
      [...forbiddenCharacters].some((character) => path.includes(character))
        ? { ok: false, reason: "name_not_storable" }
        : { ok: true, key: path },
  };
}
export function activate(ctx) {
  ctx.driver.serve(
    ctx.driver.storage(createProvider(ctx), { name: "Memory remote" }),
  );
}
