// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type {
  AccountPrincipal,
  InstanceSessions,
  IssuedSession,
} from "../../server/auth/sessions.ts";
import type { LoginProof } from "../../server/auth/account_credentials.ts";

/** Test consumer, not a production unsealing API: observe actual body delivery. */
export async function receiveSession(issued: IssuedSession): Promise<{
  access_token: string;
  token_type: "bearer";
  principal: AccountPrincipal;
}> {
  const result = await new Response(issued.body).json();
  assertEquals(typeof result.access_token, "string");
  assertEquals(result.token_type, "bearer");
  assertEquals(result.principal, issued.principal);
  return { ...result, principal: issued.principal };
}
export async function signIn(
  sessions: InstanceSessions,
  input: unknown,
  signal?: AbortSignal,
) {
  return await receiveSession(await sessions.login(input, signal));
}
export async function issueSession(
  sessions: InstanceSessions,
  proof: LoginProof,
) {
  return await receiveSession(await sessions.issue(proof));
}
