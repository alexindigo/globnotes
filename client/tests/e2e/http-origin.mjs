// Application browser tests open globnotes only through an ordinary, locally
// resolved HTTP hostname (AXIOMS §1: plain HTTP on a local domain, never
// loopback). GLOBNOTES_TEST_HOST names it; it must resolve to exactly one
// non-loopback IPv4 address that belongs to this machine. There is no fallback.
export const TEST_HOST_VARIABLE = "GLOBNOTES_TEST_HOST";

function systemResolve(host) {
  const output = new Deno.Command("getent", { args: ["ahostsv4", host], stdout: "piped", stderr: "null" }).outputSync();
  if (!output.success) return [];
  return new TextDecoder().decode(output.stdout).split("\n").filter(Boolean).map(line => line.split(/\s+/)[0]);
}
function systemAddresses() {
  return Deno.networkInterfaces().filter(entry => entry.family === "IPv4").map(entry => entry.address);
}
const defaults = { env: name => Deno.env.get(name), resolve: systemResolve, addresses: systemAddresses };

function originError(detail) {
  return Error(`Application browser tests require ${TEST_HOST_VARIABLE} naming a regular local HTTP domain: ${detail}`);
}

let cached;
/** The test domain and the local address it resolves to (memoized per name). */
export function testOrigin(dependencies) {
  if (dependencies) return resolveOrigin({ ...defaults, ...dependencies });
  const host = defaults.env(TEST_HOST_VARIABLE);
  if (cached?.key !== host || !host) cached = { key: host, origin: resolveOrigin(defaults) };
  return cached.origin;
}

function resolveOrigin(deps) {
  const host = deps.env(TEST_HOST_VARIABLE);
  if (!host) throw originError("the variable is unset");
  const name = host.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) || /^[0-9.]+$/.test(name)) {
    throw originError(`${JSON.stringify(host)} is not a dotted host name`);
  }
  if (name === "localhost" || name.endsWith(".localhost")) throw originError(`${host} is a loopback name`);
  const resolved = [...new Set(deps.resolve(name))];
  if (resolved.length !== 1) throw originError(`${host} must resolve to exactly one IPv4 address (got ${resolved.length ? resolved.join(", ") : "none"})`);
  const [address] = resolved;
  if (address.startsWith("127.") || address === "0.0.0.0") throw originError(`${host} resolves to loopback/unspecified ${address}`);
  if (!deps.addresses().includes(address)) throw originError(`${host} resolves to ${address}, which is not an address of this machine`);
  return { host: name, address };
}

/** Local address that test servers and proxies bind to. */
export const bindAddress = dependencies => testOrigin(dependencies).address;

/** Browser-facing origin for a test server port. */
export function httpOrigin(port, dependencies) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error("A valid fixture port is required");
  return `http://${testOrigin(dependencies).host}:${value}`;
}

/** Rejects any application URL other than plain HTTP on the test domain. */
export function assertHttpTestUrl(value, dependencies) {
  const { host } = testOrigin(dependencies);
  let url;
  try { url = new URL(value); } catch { throw originError(`${JSON.stringify(value)} is not a URL`); }
  if (url.protocol !== "http:") throw originError(`${url.protocol} is not plain HTTP`);
  if (url.username || url.password) throw originError("URL credentials are not allowed");
  if (url.hostname !== host) throw originError(`${url.hostname} is not ${host}`);
  return url;
}

/** Options for tests/helpers/boot.ts when a browser opens the server. */
export const applicationServer = () => ({ host: bindAddress(), origin: port => httpOrigin(port) });
