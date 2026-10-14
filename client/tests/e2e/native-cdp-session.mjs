// Feature-owned native CDP; all targets/contexts are explicitly owned.
export function connectSocket(url, { timeout = 15000, Socket = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(url);
    const pending = new Map();
    const listeners = new Set();
    let sequence = 0;
    let connected = false;
    let closed = false;
    const connectTimer = setTimeout(() => {
      fail(new Error("CDP connection deadline"));
      socket.close();
    }, timeout);
    function fail(error) {
      closed = true;
      clearTimeout(connectTimer);
      if (!connected) reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    }
    const connection = {
      send(method, params = {}) {
        if (closed) return Promise.reject(new Error("CDP disconnected"));
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error(`${method}: CDP request deadline`)), timeout);
          function finish(error, result) {
            clearTimeout(timer);
            pending.delete(id);
            error ? reject(error) : resolve(result);
          }
          pending.set(id, { reject: error => finish(error), resolve: result => finish(null, result) });
          try { socket.send(JSON.stringify({ id, method, params })); }
          catch (error) { finish(error); }
        });
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      close() { fail(new Error("CDP connection closed")); listeners.clear(); socket.close(); },
      get pendingCount() { return pending.size; },
    };
    socket.addEventListener("open", () => { connected = true; clearTimeout(connectTimer); resolve(connection); });
    socket.addEventListener("close", () => fail(new Error("CDP disconnected")));
    socket.addEventListener("error", () => fail(new Error("CDP socket error")));
    socket.addEventListener("message", ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { fail(new Error("Malformed CDP frame")); return; }
      const request = pending.get(message.id);
      if (request) message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      else for (const listener of listeners) listener(message);
    });
  });
}

export async function createOwnedTarget(browser, connectTarget) {
  const { browserContextId } = await browser.send("Target.createBrowserContext");
  let targetId;
  let page;
  try {
    ({ targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId }));
    page = await connectTarget(targetId);
  } catch (error) {
    if (targetId) await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    await browser.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    throw error;
  }
  let disposed = false;
  return { browserContextId, targetId, page, async dispose() {
    if (disposed) return;
    disposed = true;
    page.close();
    try { await browser.send("Target.closeTarget", { targetId }); }
    finally { await browser.send("Target.disposeBrowserContext", { browserContextId }); }
  } };
}

export async function nativeSession({ port = 9333, width = 1280, height = 900, dpr = 1 } = {}) {
  const discovery = async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`CDP discovery: ${response.status}`);
    return response.json();
  };
  const version = await discovery("/json/version");
  const browser = await connectSocket(version.webSocketDebuggerUrl);
  let owned;
  try {
    owned = await createOwnedTarget(browser, async id => {
      const target = (await discovery("/json/list")).find(target => target.id === id);
      if (!target) throw new Error("Owned target missing from discovery");
      return connectSocket(target.webSocketDebuggerUrl);
    });
  } catch (error) { browser.close(); throw error; }
  const page = owned.page;
  const errors = [];
  const events = [];
  page.onEvent(event => {
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails);
    if (event.method === "Runtime.consoleAPICalled") events.push({ type: event.params.type, text: event.params.args.map(arg => arg.value ?? arg.description).join(" ") });
    if (event.method === "Network.loadingFailed") events.push({ method: event.method, ...event.params });
  });
  try {
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  } catch (error) { await owned.dispose().catch(() => {}); browser.close(); throw error; }
  async function evaluate(expression) {
    const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async function poll(expression, { timeout = 15000 } = {}) {
    const end = Date.now() + timeout;
    do {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < end);
    throw new Error(`Consumer deadline: ${expression}`);
  }
  async function click(selector) {
    const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing control'); el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  return { ...owned, browser, errors, events, version, evaluate, poll, click, send: page.send,
    async goto(url) { await page.send("Page.navigate", { url }); await poll("document.readyState === 'complete'"); },
    async button(text, scope = "body") {
      await poll(`(() => { document.querySelector('[data-gps-click]')?.removeAttribute('data-gps-click'); const button = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(el => el.textContent.trim() === ${JSON.stringify(text)} && el.getBoundingClientRect().width); button?.setAttribute('data-gps-click','1'); return !!button; })()`);
      await click("[data-gps-click]");
    },
    type(text) { return page.send("Input.insertText", { text }); },
    async key(key, { modifiers = 0, code = key, windowsVirtualKeyCode } = {}) {
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode });
    },
    async close() { try { await owned.dispose(); } finally { browser.close(); } },
  };
}
