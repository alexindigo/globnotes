// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityLoginFlow, loginError } from "../loginFlow.js";
import { apiErrorHandler } from "../api.js";

vi.mock("../api.js", () => ({ apiErrorHandler: vi.fn() }));
const getToken = vi.fn(), storeToken = vi.fn();

function setup(overrides = {}) {
  const fields = { username: "user", password: "secret", totp: "123456", rememberMe: false };
  const clearCredentials = vi.fn(() => Object.assign(fields, { username: "", password: "", totp: "" }));
  const { requestToken = getToken, persistToken = storeToken, ...rest } = overrides;
  const session = { transport: { getToken: requestToken }, acceptToken: persistToken, beforeSignIn: async () => true,
    snapshot: () => ({ capabilities: { canRead: true } }),
    capture: () => () => true, signIn: async () => ({ principal: { kind: "account" }, current: () => true }) };
  const adapters = { session, credentials: () => fields, clearCredentials, clearAccepted() {}, redirect: () => undefined, navigate: vi.fn(), toast: { add: vi.fn() }, ...rest };
  return { flow: createIdentityLoginFlow(adapters), fields, ...adapters };
}

describe("login flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the token before the default home navigation", async () => {
    const order = [];
    getToken.mockResolvedValueOnce("access");
    const s = setup({ persistToken: (...args) => order.push(["store", ...args]), navigate: target => order.push(["navigate", target]) });
    await s.flow.logIn();
    expect(getToken).toHaveBeenCalledExactlyOnceWith("user", "secret", "123456");
    expect(order).toEqual([["store", "access", false], ["navigate", { name: "home" }]]);
    expect(s.clearCredentials).not.toHaveBeenCalled();
  });
  it("in-place login persists once and acknowledges its controller without navigating", async () => {
    const order = [], request = Promise.withResolvers();
    const s = setup({ requestToken: () => request.promise, persistToken: () => order.push("store"), authenticated: () => order.push("authenticated") });
    const first = s.flow.logIn(), duplicate = s.flow.logIn();
    expect(duplicate).toBe(first);
    request.resolve("token"); await first;
    expect(order).toEqual(["store", "authenticated"]); expect(s.navigate).not.toHaveBeenCalled();
  });
  it("keeps credentials private when notifying an ordinary dialog of sign-in", async () => {
    const authenticated = vi.fn(), s = setup({ requestToken: async () => "token", persistToken() {}, authenticated });
    await s.flow.logIn();
    expect(authenticated.mock.calls).toEqual([[]]);
    await s.flow.dispose();
  });

  it("uses the current Remember Me and redirect values on acknowledgement, not submission", async () => {
    let resolve;
    let target = "/old";
    getToken.mockReturnValueOnce(new Promise(ok => { resolve = ok; }));
    const s = setup({ redirect: () => target });
    const pending = s.flow.logIn();
    s.fields.rememberMe = true;
    target = "/folder/note#edit";
    resolve("access");
    await pending;
    expect(storeToken).toHaveBeenCalledExactlyOnceWith("access", true);
    expect(s.navigate).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("clears credential fields but retains Remember Me on a 401, showing the credential message", async () => {
    getToken.mockRejectedValueOnce({ response: { status: 401 } });
    const s = setup(); s.fields.rememberMe = true;
    await s.flow.logIn();
    expect(s.fields).toEqual({ username: "", password: "", totp: "", rememberMe: true });
    expect(s.toast.add).toHaveBeenCalledExactlyOnceWith({ summary: "Login Failed", detail: "Please check your credentials and try again.", severity: "error", life: 5000, closable: false });
    expect(apiErrorHandler).not.toHaveBeenCalled();
    expect(storeToken).not.toHaveBeenCalled();
    expect(s.navigate).not.toHaveBeenCalled();
  });

  it.each([new Error("network"), { response: { status: 500 } }])("delegates non-credential errors after clearing the form (%j)", async error => {
    getToken.mockRejectedValueOnce(error);
    const s = setup();
    await s.flow.logIn();
    expect(s.clearCredentials).toHaveBeenCalledOnce();
    expect(apiErrorHandler).toHaveBeenCalledExactlyOnceWith(error, s.toast);
    expect(s.toast.add).not.toHaveBeenCalled();
    expect(s.navigate).not.toHaveBeenCalled();
  });

  it("classifies only numeric 401 as a credential error", () => {
    expect(loginError({ response: { status: "401" } })).toBeNull();
    expect(loginError(new Error("offline"))).toBeNull();
  });

  it("handles persistence failure through the same form/error path without navigation", async () => {
    const error = new Error("storage");
    getToken.mockResolvedValueOnce("access");
    const s = setup({ persistToken: () => { throw error; } });
    await s.flow.logIn();
    expect(s.clearCredentials).toHaveBeenCalledOnce();
    expect(apiErrorHandler).toHaveBeenCalledWith(error, s.toast);
    expect(s.navigate).not.toHaveBeenCalled();
  });
});
