import { afterEach, expect, it, vi } from "vitest";
import { apiErrorHandler } from "../api.js";
import router from "../router.js";
import { requestReauthentication } from "../reauthentication.js";
import { registerSessionParticipant } from "../sessionActions.js";

vi.mock("../router.js", () => ({ default: { currentRoute: { value: { fullPath: "/P#source:L2" } }, push: vi.fn() } }));
vi.mock("../reauthentication.js", () => ({ requestReauthentication: vi.fn() }));
vi.mock("../pluginRuntime.js", () => ({ stopPluginRuntime: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it("a 401 with unsaved work requests in-place authentication without router departure", () => {
  const requestDecision = vi.fn(), dispose = registerSessionParticipant("api-auth", { hasUnsavedChanges: () => true, requestDecision });
  try {
    apiErrorHandler({ response: { status: 401 } }); apiErrorHandler({ response: { status: 401 } });
    expect(requestReauthentication).toHaveBeenCalledTimes(2); // Coordinator owns deduplication.
    expect(router.push).not.toHaveBeenCalled(); expect(requestDecision).not.toHaveBeenCalled();
  } finally { dispose(); }
});
it("a clean 401 retains the existing login-route redirect", () => {
  apiErrorHandler({ response: { status: 401 } });
  expect(requestReauthentication).not.toHaveBeenCalled();
  expect(router.push).toHaveBeenCalledExactlyOnceWith({ name: "login", query: { redirect: "/P#source:L2" } });
});
