// SPDX-License-Identifier: LGPL-3.0-only

import { state } from "@server/state.ts";

export default function (): { path: string; title: string; aliases: string[] }[] {
  const paths = state.notes.getPaths();
  const meta = state.indexer?.noteMetaFor(paths) ?? {};
  return paths.map((path) => ({
    path,
    title: meta[path]?.title ?? path.split("/").pop() ?? path,
    aliases: meta[path]?.aliases ?? [],
  }));
}
