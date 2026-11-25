// SPDX-License-Identifier: LGPL-3.0-only
import type { VaultAuthorityLease } from "../auth/authority.ts";
import {
  deliveryJson,
  discloseAtDelivery,
  protectPrivateResponse,
} from "../auth/http_policy.ts";

/** Internal SDK result metadata, stripped before transport delivery. Only the
 * successful tool outcome owner produces it; no request or plugin value is
 * accepted in this field. */
export const COMMITTED_REPLY = "globnotes/committed-reply";

interface Reply {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown> & {
    _meta?: Record<string, unknown>;
  };
}

export async function protectMcpResponse(
  lease: VaultAuthorityLease,
  response: Response,
): Promise<Response> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return protectPrivateResponse(lease, response);
  }
  const payload: Reply | Reply[] = await response.json();
  const parts = (Array.isArray(payload) ? payload : [payload]).map((reply) => {
    const meta = reply.result?._meta;
    const receipt = meta?.[COMMITTED_REPLY];
    if (meta && receipt) {
      delete meta[COMMITTED_REPLY];
      if (Object.keys(meta).length === 0) delete reply.result!._meta;
    }
    const envelope = { jsonrpc: "2.0", id: reply.id ?? null };
    return {
      reply,
      withheld: receipt
        ? {
          ...envelope,
          result: {
            content: [{
              type: "text",
              text: `Write committed.\n${JSON.stringify(receipt)}`,
            }],
            structuredContent: receipt,
          },
        }
        : {
          ...envelope,
          error: {
            code: -32000,
            message: "Access ended before reply delivery.",
          },
        },
    };
  });
  return deliveryJson(() => {
    const current = discloseAtDelivery(lease, true, () => false);
    const projected = parts.map(({ reply, withheld }) =>
      current ? reply : withheld
    );
    return Array.isArray(payload) ? projected : projected[0];
  }, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
