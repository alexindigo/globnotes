// SPDX-License-Identifier: LGPL-3.0-only

/** The vault change stream's timing contract, shared by the server that
 * emits it (server/api/endpoints/_/api/changes/get.ts) and the browser
 * transport that watches it (client/api.js, openVaultChanges). */

/** The server writes a heartbeat comment at least this often on an open
 * change stream, so a healthy stream never goes quiet for longer. */
export const CHANGE_STREAM_HEARTBEAT_MS = 25_000;

/** A change request (stream or poll) that receives no bytes for this long
 * has stalled (a half-open TCP connection, a buffering proxy): the client
 * aborts it and reconnects through its backoff rule. Three heartbeats, so a
 * briefly unscheduled server is not mistaken for a dead connection. */
export const CHANGE_STREAM_STALL_MS = 3 * CHANGE_STREAM_HEARTBEAT_MS;
