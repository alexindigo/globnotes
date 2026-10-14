// SPDX-License-Identifier: LGPL-3.0-only
export const LIMITS = Object.freeze({ recordBytes: 64 * 1024, slots: 10, jobs: 64, recent: 256, bodyBytes: 16 * 1024 * 1024 });
export class BackupError extends Error {
  constructor(code) { super(`Versioned backup failed (${code}). Recovery evidence is retained.`); this.code = code; }
}
export const fail = code => { throw new BackupError(code); };
export const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export const digestValid = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function pathValid(value) {
  return typeof value === "string" && value.length > 0 && !/[\0\\]/.test(value) && new TextDecoder().decode(new TextEncoder().encode(value)) === value && new TextEncoder().encode(value).length <= 4096;
}
export function originalPath(value) {
  if (!pathValid(value) || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) || value.split("/")[0] === "_") fail("backup_invalid_path");
  return value;
}
export const join = (root, relative) => `${root.replace(/\/$/, "")}/${relative}`;
export const parent = file => file.slice(0, file.lastIndexOf("/"));
export function bytesRecord(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
  if (bytes.length > LIMITS.recordBytes) fail("backup_record_too_large");
  return bytes;
}
/** Deterministic metadata paths may never be aliased onto another object. */
export async function readRecord(fs, file, options) {
  const stat = await fs.stat(file, options);
  if (!stat) return null;
  if (stat.kind !== "file" || stat.size > LIMITS.recordBytes) fail("backup_state_corrupt");
  if (await fs.realPath(file, { ...options, expect: { kind: "exact", token: stat.token } }) !== file) fail("backup_state_conflict");
  const bytes = await fs.readFile(file, { ...options, expect: { kind: "exact", token: stat.token } });
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("backup_state_corrupt"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("backup_state_corrupt");
  return { value, token: stat.token, hash: await hash(bytes) };
}
export async function writeRecord(fs, file, value, prior, options) {
  const bytes = bytesRecord(value);
  await fs.writeFile(file, bytes, { ...options, expect: prior ? { kind: "exact", token: prior.token } : { kind: "absent" } });
  const observed = await readRecord(fs, file, options);
  if (!observed || observed.hash !== await hash(bytes)) fail("backup_state_conflict");
  return observed;
}
