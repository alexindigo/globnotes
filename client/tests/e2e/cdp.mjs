// Zero-dependency CDP driver: launches the Playwright image's headless
// Chromium in a container and talks raw Chrome DevTools Protocol over Node's
// built-in WebSocket. Follows the headless-browser-e2e skill's six rules:
// real click paths via Input.dispatchMouseEvent at computed coordinates,
// poll after input dispatch, never hardcode viewport coords, and
// Runtime.exceptionThrown surfaced as errors.
import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const BROWSER_IMAGE = "mcr.microsoft.com/playwright:v1.49.1-noble";
const SHELL =
  "/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell";

export async function launchBrowser({ port = 9333 } = {}) {
  const name = `cdp-browser-${port}`;
  try {
    execSync(`docker rm -f ${name} 2>/dev/null`);
  } catch {}
  spawn(
    "docker",
    [
      "run", "--rm", "-d", "--name", name, "--network", "host",
      "--entrypoint", SHELL, BROWSER_IMAGE,
      "--headless", "--no-sandbox", "--disable-gpu",
      `--remote-debugging-port=${port}`, "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        return name;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`browser on :${port} did not start`);
}

export async function stopBrowser(name) {
  try {
    execSync(`docker rm -f ${name} 2>/dev/null`);
  } catch {}
}

export async function connect({ port = 9333 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target found");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let seq = 0;
  const pending = new Map();
  const listeners = [];
  const pageErrors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(
          msg.params.exceptionDetails?.exception?.description ||
            msg.params.exceptionDetails?.text ||
            "unknown exception",
        );
      }
      listeners.forEach((fn) => fn(msg));
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ||
          r.exceptionDetails.text ||
          "evaluate failed",
      );
    }
    return r.result?.value;
  }

  async function poll(expression, { timeout = 6000, interval = 100 } = {}) {
    const start = Date.now();
    for (;;) {
      if (await evaluate(expression)) {
        return true;
      }
      if (Date.now() - start > timeout) {
        throw new Error(`poll timeout: ${expression.slice(0, 100)}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async function goto(url) {
    await send("Page.navigate", { url });
    await poll(`document.readyState === "complete"`);
  }

  async function addInitScript(source) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async function reload() {
    await send("Page.reload");
    await poll(`document.readyState === "complete"`);
  }

  // Real click path at the element's computed center (skill rules 2 + 5).
  async function click(selector) {
    const rect = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) {
      throw new Error(`click target not found: ${selector}`);
    }
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1,
    });
  }

  // Click an element by its visible text. Exact match preferred; otherwise
  // the shortest element containing the text (most specific node wins).
  async function clickText(text) {
    const found = await evaluate(`(() => {
      const els = [...document.querySelectorAll("button, a, [role=button], span, label, div")].filter(
        (e) => e.offsetParent !== null,
      );
      const exact = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)});
      let el = exact;
      if (!el) {
        const containing = els.filter((e) => e.textContent.includes(${JSON.stringify(text)}));
        containing.sort((a, b) => a.textContent.length - b.textContent.length);
        el = containing[0];
      }
      if (!el) return null;
      el.setAttribute("data-cdp-click-target", "1");
      return true;
    })()`);
    if (!found) {
      throw new Error(`clickText target not found: ${text}`);
    }
    await click("[data-cdp-click-target='1']");
    await evaluate(`document.querySelector("[data-cdp-click-target]")?.removeAttribute("data-cdp-click-target")`);
  }

  // Fill an input by selector: set value and fire the input event so
  // reactive frameworks see the change.
  async function fill(selector, value) {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("fill target not found: ${selector}");
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }

  async function grantClipboard(origin) {
    await send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
  }

  async function readClipboard() {
    return evaluate("navigator.clipboard.readText()");
  }

  async function screenshot(path) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data, "base64"));
  }

  const onEvent = (fn) => listeners.push(fn);

  function close() {
    try {
      ws.close();
    } catch {}
  }

  async function waitForTimeout(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  return {
    send, evaluate, poll, goto, reload, addInitScript,
    click, clickText, fill, grantClipboard, readClipboard,
    screenshot, onEvent, close, waitForTimeout,
    get pageErrors() { return pageErrors; },
  };
}

// CLI: `node cdp.mjs launch <port>` prints the browser container name.
if (process.argv[2] === "launch") {
  const port = Number(process.argv[3] || 9333);
  const name = await launchBrowser({ port });
  console.log(name);
}
