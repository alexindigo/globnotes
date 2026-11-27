// SPDX-License-Identifier: LGPL-3.0-only
import { expect, it, vi } from "vitest";
import { getIdentityAccessOutcome, getIdentityAccountOutcome } from "../api.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("axios", async importOriginal => {
  const { default: axios } = await importOriginal();
  return { default: { create: options => axios.create({ ...options, adapter }) } };
});

it("reads only the submitted ACL ID with the captured token and refuses legacy status as a receipt", async () => {
  const receipt = { matched: true, capabilities: { canManageVault: false } };
  adapter.mockReset().mockResolvedValueOnce({ data: "OK", status: 200 }).mockResolvedValueOnce({ data: receipt, status: 200 });
  await expect(getIdentityAccessOutcome("submitted", { token: "original" })).rejects.toThrow("Missing access outcome.");
  await expect(getIdentityAccessOutcome("submitted", { token: "original" })).resolves.toEqual(receipt);
  expect(adapter.mock.calls.map(([c]) => [c.method, c.url, c.params, c.headers.get("Authorization")])).toEqual([
    ["get", "auth-check", { accessUpdateId: "submitted" }, "Bearer original"],
    ["get", "auth-check", { accessUpdateId: "submitted" }, "Bearer original"],
  ]);
});

it("only the server's settlement header qualifies a negative creation receipt", async () => {
  const absence = { operationId: "submitted", committed: false };
  adapter.mockReset().mockResolvedValueOnce({ data: { ...absence, settled: true }, status: 200 })
    .mockResolvedValueOnce({ data: absence, status: 200, headers: { "globnotes-creation-settled": "true" } });
  await expect(getIdentityAccountOutcome("submitted", { token: "original" })).resolves.toEqual({ ...absence, settled: false });
  await expect(getIdentityAccountOutcome("submitted", { token: "original" })).resolves.toEqual({ ...absence, settled: true });
  expect(adapter.mock.calls.map(([c]) => [c.method, c.url, c.params, c.headers.get("Authorization")])).toEqual([
    ["get", "accounts", { operationId: "submitted" }, "Bearer original"],
    ["get", "accounts", { operationId: "submitted" }, "Bearer original"],
  ]);
});
