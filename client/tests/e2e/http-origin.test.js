import { describe, expect, it } from "vitest";
import { assertHttpTestUrl, bindAddress, httpOrigin, testOrigin } from "./http-origin.mjs";

const HOST = "feature-globnotes.test";
// `host` may be explicitly undefined (an unset variable), so it takes no destructuring default.
const fake = (options = {}) => fakeDeps({ host: HOST, ...options });
const fakeDeps = ({ host, resolved = ["192.168.122.7"], local = ["127.0.0.1", "192.168.122.7"] }) => ({
  env: name => (name === "GLOBNOTES_TEST_HOST" ? host : undefined),
  resolve: () => resolved,
  addresses: () => local,
});

describe("application test origin", () => {
  it("resolves the named local domain to this machine's address", () => {
    expect(testOrigin(fake())).toEqual({ host: HOST, address: "192.168.122.7" });
    expect(bindAddress(fake())).toBe("192.168.122.7");
    expect(httpOrigin(8080, fake())).toBe(`http://${HOST}:8080`);
    expect(assertHttpTestUrl(`http://${HOST}:8080/_/new?path=A`, fake()).pathname).toBe("/_/new");
  });
  it("fails when the variable is unset", () => {
    expect(() => httpOrigin(8080, fake({ host: undefined }))).toThrow("GLOBNOTES_TEST_HOST naming a regular local HTTP domain: the variable is unset");
  });
  it.each(["localhost", "app.localhost", "127.0.0.1", "192.168.122.7", "single"])("rejects %s as the test host", host => {
    expect(() => testOrigin(fake({ host }))).toThrow("GLOBNOTES_TEST_HOST");
  });
  it("rejects a name resolving to loopback", () => {
    expect(() => testOrigin(fake({ resolved: ["127.0.0.1"] }))).toThrow("loopback");
  });
  it("rejects a name resolving to a foreign address", () => {
    expect(() => testOrigin(fake({ resolved: ["192.168.122.99"] }))).toThrow("not an address of this machine");
  });
  it("rejects unresolved or ambiguous names", () => {
    expect(() => testOrigin(fake({ resolved: [] }))).toThrow("exactly one IPv4 address (got none)");
    expect(() => testOrigin(fake({ resolved: ["192.168.122.7", "10.0.0.2"] }))).toThrow("exactly one IPv4 address");
  });
  it.each([
    "http://localhost:8080/",
    "http://127.0.0.1:8080/",
    `https://${HOST}:8080/`,
    `http://user:secret@${HOST}:8080/`,
    "http://other-globnotes.test:8080/",
    "about:blank",
  ])("rejects application URL %s", url => {
    expect(() => assertHttpTestUrl(url, fake())).toThrow("GLOBNOTES_TEST_HOST");
  });
  it.each([0, -1, 65536, "invalid"])("rejects invalid fixture port %s", port => {
    expect(() => httpOrigin(port, fake())).toThrow("valid fixture port");
  });
});
