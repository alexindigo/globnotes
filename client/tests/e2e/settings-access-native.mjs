import { identityTokenScope } from "../../../shared/identity_token.ts";
import { done, failed, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { assert } from "./test-outcomes.mjs";
import { showSidebar } from "./sidebar-navigation-native.mjs";

export const tokenExpression = (prefix = "") => `sessionStorage.getItem(${JSON.stringify(identityTokenScope(prefix).key)})`;

export async function fillNativeInput(session, selector, value) {
  await session.click(selector, { editable: true });
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
  if (value) await session.type(value);
  else await session.key("Backspace", { code: "Backspace", windowsVirtualKeyCode: 8 });
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);
}

export async function signInNative(session, server, { login, password, totp }, { prefix = server.prefix ?? "", returnPath } = {}) {
  if (!await session.evaluate("!!document.querySelector('#identity-login-name')")) {
    await session.goto(`${server.baseUrl}${prefix}/_/login`);
  }
  await fillNativeInput(session, "#identity-login-name", login);
  await fillNativeInput(session, "#identity-login-password", password);
  await session.button("Continue");
  if (totp) {
    await session.poll("!!document.querySelector('#identity-login-code')");
    await fillNativeInput(session, "#identity-login-code", totp);
    await session.button("Sign in");
  }
  const token = await session.poll(tokenExpression(prefix));
  const response = await fetch(`${server.baseUrl}${prefix}/_/api/auth-check`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  const status = await response.json();
  assert(response.status === 200 && status.principal?.login === login, `Native sign-in did not admit ${login}: ${response.status}`);
  if (returnPath && await session.evaluate("location.pathname") !== prefix + returnPath) {
    await session.goto(`${server.baseUrl}${prefix}${returnPath}`);
  }
  return { token, status };
}

export async function openNativeSettings(session, id, page = id) {
  if (!await session.evaluate("!!document.querySelector('#settings-modal-title')")) {
    await showSidebar(session);
    await session.click('[aria-label="Settings"]');
  }
  await session.click(`[data-settings-nav-id="${id}"]`);
  await session.poll(`document.querySelector('[data-settings-content]')?.dataset.settingsCurrentPage===${JSON.stringify(page)}`);
  if (id === "core:access") await session.poll("!!document.querySelector('#access-everybody')");
  if (id === "core:account") await session.poll("!!document.querySelector('#account-current-password')");
}

export async function selectAccessLevel(session, selector, level) {
  const serialized = JSON.stringify(level);
  const values = await session.read(selector, `[...document.querySelector(${JSON.stringify(selector)}).options].map(option=>option.value)`);
  const index = values.indexOf(serialized);
  assert(index >= 0, `Missing access level ${level} at ${selector}`);
  await session.click(selector);
  await session.key("Home", { code: "Home", windowsVirtualKeyCode: 36 });
  for (let i = 0; i < index; i++) await session.key("ArrowDown", { code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await session.key("Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(serialized)}`);
}

// Dismissing a confirmation is not a receipt. Follow the exact native PUT
// through completion, verify the echoed update ID, and always release the observer.
export async function commitNativeAccess(session, url, action) {
  let request, response, finished = false, error;
  const stop = session.page.onEvent(({ method, params }) => {
    if (method === "Network.requestWillBeSent" && params.request.method === "PUT" && params.request.url === url) {
      if (request) { error = "Duplicate Access PUT"; return; }
      request = { id: params.requestId, updateId: JSON.parse(params.request.postData).updateId };
    }
    if (!request || params.requestId !== request.id) return;
    if (method === "Network.responseReceived") response = params.response;
    if (method === "Network.loadingFinished") finished = true;
    if (method === "Network.loadingFailed") error = params.errorText;
  });
  try {
    await action();
    await waitUntil(() => error ? failed(error) : finished && response ? done() : pending({ request, finished }), { label: "committed native Access PUT" });
    const { body, base64Encoded } = await session.send("Network.getResponseBody", { requestId: request.id });
    const receipt = JSON.parse(base64Encoded ? atob(body) : body);
    assert(response.status === 200 && receipt.committed === true && request.updateId && receipt.updateId === request.updateId,
      `Access PUT did not acknowledge its submitted ID: ${response.status} ${body}`);
    return receipt;
  } finally { stop(); }
}
