// SPDX-License-Identifier: LGPL-3.0-only
import { readPathPrefix } from "./pathPrefix.js";

export const conflictsTarget = () => ({ name: "conflicts" });
export const conflictTarget = id => ({ name: "conflict", params: { id } });
export const reviewConflictTarget = (inbox, path) => {
  const record = inbox?.lookupByMember(`${path}.md`, "copyPath");
  return record ? conflictTarget(record.id) : conflictsTarget();
};
// Ordinary authenticated file links use the token owner's scoped cookie.
export const conflictFileHref = (path, prefix = readPathPrefix()) =>
  `${prefix}/_/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;

export const sameConflictPair = (a, b) => a?.state === "open" && b?.state === "open" &&
  a.id === b.id && a.revision === b.revision && ["original", "copy"].every(side =>
    a[side].path === b[side].path && a[side].version === b[side].version);
