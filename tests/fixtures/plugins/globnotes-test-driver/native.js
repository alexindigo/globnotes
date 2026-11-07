// SPDX-License-Identifier: LGPL-3.0-only
// Native test protocol adds deltas and atomic receipts to the storage fixture.
// It is test infrastructure, not a production protocol or an SDK group promise.
import { createProvider } from "./driver.js";
export function activate(ctx) {
  const provider = createProvider(ctx);
  const storage = ctx.driver.storage(provider);
  let endpoint;
  async function native(route, method = "GET", body) {
    const response = await fetch(
      new URL(route, ctx.instance.settings.baseUrl),
      {
        method,
        headers: { authorization: `Bearer ${await ctx.secrets.get("token")}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error("Native endpoint unavailable");
    return await response.json();
  }
  ctx.driver.serve({
    async open() {
      const opened = await storage.open();
      if (opened.state !== "ready") return opened;
      endpoint = opened.endpoint;
      const page = await native("/native/discover?mode=snapshot");
      return { state: "ready", endpoint, scope: page.scope };
    },
    async discover(request) {
      const page = await native(
        `/native/discover?mode=${request.mode}${
          request.cursor ? `&cursor=${encodeURIComponent(request.cursor)}` : ""
        }`,
      );
      if (page.hang) {
        while (true) {
          /* Deliberate Worker heartbeat fault. */
        }
      }
      return page;
    },
    read: (request) => storage.read(request),
    apply: (items) =>
      ctx.instance.settings.atomicGroups
        ? native(
          "/native/apply",
          "POST",
          items.map((item) => ({
            ...item,
            ...(item.bytes ? { bytes: [...item.bytes] } : {}),
          })),
        )
        : storage.apply(items),
    close: () => storage.close(),
  });
}
