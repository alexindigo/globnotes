// Own real browser response barriers without forwarding or timing the RPC again.
import { finalizeNativeCase } from "./native-case-finalization.mjs";
export async function createNoteResponseGate(session, { methods = ["POST", "PATCH", "DELETE"], onDeadline } = {}) {
  const records = [], responses = [], reads = [], requests = new Map(), paused = new Map(), active = new Set(), jobs = new Set();
  let closed = false, peak = 0, failure;
  const matches = request => methods.includes(request.method) && /^\/_\/api\/notes(?:\/|$)/.test(new URL(request.url).pathname);
  const remember = error => { if (!closed) failure ??= error; };
  function admitted(id, request) {
    if (requests.has(id)) return requests.get(id);
    let settle;
    const released = new Promise(resolve => { settle = resolve; });
    const record = { id: records.length + 1, requestId: id, method: request.method, path: new URL(request.url).pathname,
      body: request.postData ? JSON.parse(request.postData) : null, fault: false, released };
    record.release = () => {
      const owner = paused.get(record);
      if (!owner) throw Error("Response is not owned by this gate");
      return owner.releasing ??= (async () => {
        clearTimeout(owner.timer);
        // The held response ceases to be active at release dispatch, not when
        // CDP later reports loadingFinished or replies to the continuation.
        // The browser can consume A and send B before either notification.
        active.delete(record.requestId);
        if (record.fault) await session.send("Fetch.fulfillRequest", { requestId: owner.id, responseCode: 502,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: btoa(JSON.stringify({ detail: "Controlled lost acknowledgement after the real server result" })) });
        else await session.send("Fetch.continueRequest", { requestId: owner.id });
        owner.released = true; settle();
      })();
    };
    requests.set(id, record); records.push(record); active.add(id); peak = Math.max(peak, active.size);
    return record;
  }
  async function response(event) {
    const value = event.params;
    if (!matches(value.request)) { await session.send("Fetch.continueRequest", { requestId: value.requestId }); return; }
    const record = admitted(value.networkId ?? value.requestId, value.request), owner = { id: value.requestId };
    paused.set(record, owner);
    if (value.responseErrorReason) throw Error(`Native response transport failed: ${value.responseErrorReason}`);
    const body = await session.send("Fetch.getResponseBody", { requestId: value.requestId });
    if (closed) return;
    const text = body.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body.body), ch => ch.charCodeAt(0))) : body.body;
    record.backendResult = text ? JSON.parse(text) : null;
    record.backendStatus = value.responseStatusCode; responses.push(record);
    owner.timer = setTimeout(() => {
      const job = (async () => {
        if (onDeadline) await onDeadline(record);
        else { record.error = "Owned response gate deadline"; record.fault = true; await record.release(); }
      })();
      jobs.add(job); job.catch(remember).finally(() => jobs.delete(job));
    }, 30000);
  }
  const stop = session.page.onEvent(event => {
    try {
      const value = event.params;
      if (event.method === "Network.requestWillBeSent") {
        if (value.request.method === "GET" && /^\/_\/api\/notes\//.test(new URL(value.request.url).pathname)) reads.push(new URL(value.request.url).pathname);
        if (matches(value.request)) admitted(value.requestId, value.request);
      }
      if (["Network.loadingFinished", "Network.loadingFailed"].includes(event.method)) active.delete(value.requestId);
      if (event.method === "Fetch.requestPaused") {
        const job = response(event); jobs.add(job); job.catch(remember).finally(() => jobs.delete(job));
      }
    } catch (error) { remember(error); }
  });
  async function close() {
    if (closed) return;
    closed = true;
    await finalizeNativeCase({ cleanup: [
      stop,
      ...[...paused.values()].map(owner => () => clearTimeout(owner.timer)),
      ...[...paused.values()].filter(owner => !owner.released).map(owner => () =>
        session.send("Fetch.failRequest", { requestId: owner.id, errorReason: "Aborted" })),
      () => session.send("Fetch.disable"),
      // Snapshot after disable: every in-flight observer/deadline job settles
      // even if an earlier abort or the disable itself failed.
      () => finalizeNativeCase({ cleanup: [...jobs].map(job => () => job) }),
    ] });
  }
  try { await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/notes*", requestStage: "Response" }] }); }
  catch (error) { stop(); throw error; }
  return { records, responses, reads, close, maxActive: () => peak, get error() { return failure; } };
}
