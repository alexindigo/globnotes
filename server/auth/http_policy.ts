// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { createOwnershipScope } from "../../shared/ownership.js";
import { logger } from "../logger.ts";
import type {
  AuthorityVault,
  InstanceAuthorityLease,
  VaultAuthorityLease,
} from "./authority.ts";
import type { createInstanceAuth } from "./middleware.ts";

export const HTTP_OPERATIONS = [
  "public",
  "session",
  "manageOwnAccount",
  "createVault",
  "readVault",
  "editNotes",
  "manageVault",
  "shellOrFile",
  "mcp",
] as const;
export type HttpOperation = typeof HTTP_OPERATIONS[number];
export type InstanceAuth = ReturnType<typeof createInstanceAuth>;
export type HttpLease = InstanceAuthorityLease | VaultAuthorityLease;
type VaultReadOperation = "readVault" | "manageVault";
type ReadLeases =
  & { session: InstanceAuthorityLease }
  & {
    [K in VaultReadOperation]: VaultAuthorityLease;
  };

declare module "@pathfinder/pathfinder" {
  interface State {
    identityLease?: HttpLease;
  }
}

/** Select a disclosure at the delivery boundary, not at admission. */
export function discloseAtDelivery<T>(
  lease: Pick<HttpLease, "assertCurrent">,
  value: T,
  withheld: () => T,
): T {
  try {
    lease.assertCurrent();
  } catch {
    return withheld();
  }
  return value;
}

/** JSON whose wire body is decided in the consumer pull, not on construction. */
export function deliveryJson(
  value: () => unknown,
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value())));
        controller.close();
      },
    }, { highWaterMark: 0 }),
    { ...init, headers },
  );
}

// Mark only the exact response produced by an outcome owner; no metadata,
// HTTP status or client header can opt a whole route out of disclosure.
const outcomeResponses = new WeakSet<Response>();
export function ownOutcomeResponse(response: Response): Response {
  outcomeResponses.add(response);
  return response;
}

export function ownsOutcomeResponse(response: Response): boolean {
  return outcomeResponses.has(response);
}

export function committedJson(receipt: unknown, init?: ResponseInit): Response {
  return ownOutcomeResponse(Response.json(receipt, init));
}

export function committedWithPrivateJson<T, R>(
  lease: HttpLease | undefined,
  value: T,
  receipt: R,
  init?: ResponseInit,
): Response {
  if (!lease) return Response.json(value, init);
  return ownOutcomeResponse(
    deliveryJson(
      () => discloseAtDelivery<T | R>(lease, value, () => receipt),
      init,
    ),
  );
}

/** Instance operations never consult the selected vault. */
export function singleIdentityVault(vault: AuthorityVault) {
  return (request: Request): AuthorityVault => {
    const targets = new URL(request.url).searchParams.getAll("vault");
    if (
      targets.length > 1 || targets.length === 1 && targets[0] !== "globnotes"
    ) {
      throw new HttpError(400, "Unsupported vault target.");
    }
    return vault;
  };
}

/** Status/headers and each actual body delivery share the admitted lease. */
export function protectVaultResponse(
  lease: HttpLease,
  response: Response,
): Response {
  const body = response.body;
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
  lease.assertCurrent();
  return new Response(body ? lease.stream(body) : null, init);
}

/** Pathfinder forbids touching the original body during its post phase. P02
 * retains it until the refusal is consumed/cancelled. Cancellation is started,
 * not awaited: an uncooperative private source must not hold the refusal open. */
function privateSourceCustody(original: Response) {
  const scope = createOwnershipScope();
  const source = original.body;
  scope.defer(() => {
    if (source) {
      source.cancel().catch((error) =>
        logger.warning("Private response cleanup failed:", error)
      );
    }
  });
  return scope;
}
/** Direct adapters may release a refused source immediately; post-functions use
 * replacePrivateResponse instead so Pathfinder sees an untouched original. */
export async function protectPrivateResponse(
  lease: HttpLease,
  response: Response,
): Promise<Response> {
  try {
    return protectVaultResponse(lease, response);
  } catch (error) {
    const released = await privateSourceCustody(response).releaseAll();
    released.throwIfFailed(error);
    throw error;
  }
}
export async function replacePrivateResponse(
  original: Response,
  refusal: Response,
): Promise<Response> {
  const scope = privateSourceCustody(original);
  const payload = new Uint8Array(await refusal.arrayBuffer());
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const released = await scope.releaseAll();
        released.throwIfFailed();
        controller.enqueue(payload);
        controller.close();
      },
      async cancel() {
        const released = await scope.releaseAll();
        released.throwIfFailed();
      },
    }, { highWaterMark: 0 }),
    {
      status: refusal.status,
      statusText: refusal.statusText,
      headers: refusal.headers,
    },
  );
}

/** Discovered metadata, not a path or HTTP-method switchboard. Mixed surfaces
 * bind their own operation-qualified lease in catch-all/MCP consumers. */
export function createHttpPolicy(auth: InstanceAuth) {
  const readLease: {
    [K in keyof ReadLeases]: (request: Request) => Promise<ReadLeases[K]>;
  } = {
    session: (request) => auth.instanceLease(request, "readInstance"),
    readVault: (request) => auth.lease(request, "readVault"),
    manageVault: (request) => auth.lease(request, "manageVault"),
  };
  return Object.freeze({
    async admit(
      request: Request,
      operation: unknown,
    ): Promise<HttpLease | null> {
      if (
        typeof operation !== "string" ||
        !HTTP_OPERATIONS.includes(operation as HttpOperation)
      ) {
        throw new HttpError(403, "Endpoint access requirement is missing.");
      }
      if (
        operation === "public" || operation === "shellOrFile" ||
        operation === "mcp"
      ) return null;
      if (operation === "session") {
        return await auth.instanceLease(request, "readInstance");
      }
      if (operation === "manageOwnAccount" || operation === "createVault") {
        return await auth.instanceLease(request, operation);
      }
      return await auth.lease(
        request,
        operation as "readVault" | "editNotes" | "manageVault",
      );
    },
    async read(
      request: Request,
      operation: VaultReadOperation,
      prepare: (lease: VaultAuthorityLease) => Promise<Response>,
    ): Promise<Response> {
      const lease = await auth.lease(request, operation);
      lease.assertCurrent();
      return protectPrivateResponse(lease, await prepare(lease));
    },
    async json<T, K extends keyof ReadLeases>(
      request: Request,
      operation: K,
      prepare: (lease: ReadLeases[K]) => Promise<T>,
    ): Promise<Response> {
      const lease = await readLease[operation](request);
      const handle = await lease.read(() => prepare(lease));
      return new Response(lease.body(handle), {
        headers: { "content-type": "application/json" },
      });
    },
  });
}
