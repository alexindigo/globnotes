// SPDX-License-Identifier: LGPL-3.0-only
import {
  boundedRecord,
  METADATA_LIMITS,
  metadataBytes,
  type MetadataPage,
  type MetadataQuery,
  type MetadataRecord,
} from "./contracts.ts";
import type { MetadataProjection } from "./projection.ts";

/** Eligibility precedes all filters, counts and pagination. No ungranted values escape. */
export function queryMetadata(
  projection: MetadataProjection,
  q: MetadataQuery,
  eligible: (path: string) => boolean,
  revision = projection.revision,
): MetadataPage {
  const candidates = projection.records().filter((r) => eligible(r.path))
    .filter((r) =>
      (!q.prefix || r.path.normalize("NFC") === q.prefix.normalize("NFC") ||
        r.path.normalize("NFC").startsWith(q.prefix.normalize("NFC") + "/")) &&
      (r.status !== "ready" ||
        ((!q.property || r.properties.some((p) =>
          p.key === q.property!.key &&
          (p.value.kind === "scalar"
            ? p.value.text === q.property!.equals
            : p.value.kind === "list" &&
              p.value.items.includes(q.property!.equals))
        )) &&
          (!q.task || r.tasks.some((t) => t.checked === q.task!.checked))))
    ).sort((a, b) =>
      a.path.normalize("NFC") < b.path.normalize("NFC")
        ? -1
        : a.path.normalize("NFC") > b.path.normalize("NFC")
        ? 1
        : 0
    );
  const page: MetadataPage = {
    revision,
    cursor: projection.cursor,
    catchingUp: projection.catchingUp,
    total: candidates.length,
    rows: [],
    unavailable: [],
  };
  let offset = q.offset;
  while (offset < candidates.length && offset - q.offset < q.limit) {
    const record = boundedRecord(candidates[offset]);
    const target = record.status === "ready" ? page.rows : page.unavailable;
    target.push(record);
    // Reserve the pagination envelope too, including an arbitrary safe offset.
    if (
      metadataBytes({ ...page, nextOffset: offset + 1 }) > METADATA_LIMITS.bytes
    ) {
      target.pop();
      break;
    }
    offset++;
  }
  if (offset < candidates.length) page.nextOffset = offset;
  return page;
}
export function getMetadata(
  projection: MetadataProjection,
  path: string,
): MetadataRecord | null {
  return projection.records().find((r) =>
    r.path.normalize("NFC") === path.normalize("NFC")
  ) ?? null;
}
