// Stable owned browser origin across backend restarts; existing launcher unchanged.
export function createSettingsRestartFixture({ initialServer, launch, directory }) {
  let backend = initialServer;
  let launches = 1;
  let restarting = null;
  let closed = false;
  const shutdown = new AbortController();
  const proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {}, signal: shutdown.signal }, async (request, info) => {
    const current = backend;
    if (!current) return new Response(JSON.stringify({ detail: "Owned restart in progress" }), { status: 503, headers: { "content-type": "application/json" } });
    const url = new URL(request.url);
    const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 5000);
    // Deno 2.9.6's request.signal also aborts on successful delivery. Observe
    // the documented delivery promise instead, without changing runner flags.
    info.completed.catch(() => deadline.abort());
    try {
      const response = await fetch(`${current.baseUrl}${url.pathname}${url.search}`, {
        method: request.method, headers, body, redirect: "manual", signal: AbortSignal.any([shutdown.signal, deadline.signal]),
      });
      // Only admission/headers have a deadline. Do not manufacture an SSE close
      // five seconds later while the actual authenticated stream is still valid.
      clearTimeout(timer);
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      return new Response(JSON.stringify({ detail: "Owned backend transport unavailable", cause: error.name }), { status: 503, headers: { "content-type": "application/json" } });
    } finally { clearTimeout(timer); }
  });
  return {
    baseUrl: `http://127.0.0.1:${proxy.addr.port}`,
    get pid() { return backend?.pid; },
    async restart() {
      if (closed) throw Error("Owned restart fixture is closed");
      if (restarting) return restarting;
      restarting = (async () => {
        const old = backend; backend = null;
        await old.close();
        const next = await launch(++launches);
        backend = next;
        await Deno.writeTextFile(`${directory}/backend-restart-${launches}.json`, JSON.stringify({ oldPid: old.pid, newPid: next.pid, backendUrl: next.baseUrl, browserOrigin: this.baseUrl }, null, 2), { createNew: true });
        return { oldPid: old.pid, newPid: next.pid, browserOrigin: this.baseUrl };
      })().finally(() => { restarting = null; });
      return restarting;
    },
    async close() {
      if (closed) return;
      closed = true;
      shutdown.abort();
      let timer;
      try { await Promise.race([proxy.finished, new Promise((_, reject) => { timer=setTimeout(()=>reject(Error("Owned restart proxy closure deadline")),5000); })]); }
      finally { clearTimeout(timer); }
      await backend?.close();
    },
  };
}
