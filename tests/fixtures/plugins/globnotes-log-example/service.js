// SPDX-License-Identifier: LGPL-3.0-only
// Test-only current-state consumer. This is not an historical byte archive.
export async function activate(ctx) {
  let stored = await ctx.data.load();
  let state = stored.values;
  let revision = stored.revision;
  const persist = async (next) => {
    stored = await ctx.data.save(next, revision);
    revision = stored.revision;
    state = stored.values;
  };
  const observe = async (entry, version) => {
    if (!entry.path) return { seq: entry.seq, status: "anonymous" };
    try {
      const file = await ctx.files.read(entry.path);
      if (file.version !== version) {
        return { seq: entry.seq, status: "superseded" };
      }
      return {
        seq: entry.seq,
        path: entry.path,
        version,
        body: new TextDecoder().decode(file.body),
        status: "current",
      };
    } catch (error) {
      // Unknown is not deletion. Only a recorded delete removes a keyed row.
      return {
        seq: entry.seq,
        status: "unavailable",
        code: error.code ?? "read_failed",
      };
    }
  };
  ctx.changes.subscribe(async (packet) => {
    if (
      !Object.isFrozen(packet) ||
      (packet.entries && !Object.isFrozen(packet.entries))
    ) {
      throw new Error("feed values must be immutable");
    }
    const next = structuredClone(state);
    if (packet.type === "gap") {
      if (next.resetId === packet.resetId) return { ack: packet.token };
      Object.assign(next, {
        logId: packet.logId,
        resetId: packet.resetId,
        caughtUp: false,
        rows: {},
        snapshot: {},
        staged: {},
        seen: [],
        facts: [],
        cursor: null,
        resets: (next.resets ?? 0) + 1,
        reason: packet.reason,
      });
    } else if (packet.type === "snapshot") {
      if (next.resetId !== packet.resetId) throw new Error("unknown reset");
      const page = {};
      for (const entry of packet.entries) {
        page[entry.pathKey] = await observe(entry, entry.hash);
      }
      next.snapshot[packet.page] = page;
      next.page = packet.page;
      if (packet.complete) {
        next.rows = Object.assign({}, ...Object.values(next.snapshot));
        next.snapshot = {};
        next.cursor = packet.watermark;
        next.caughtUp = true;
      }
    } else {
      if (packet.logId !== next.logId) throw new Error("unknown log");
      const apply = async (entry) => {
        const identity = `${packet.logId}:${entry.seq}`;
        if (next.seen.includes(identity)) return;
        if (entry.oldPathKey && next.rows[entry.oldPathKey]?.seq <= entry.seq) {
          delete next.rows[entry.oldPathKey];
        }
        if ((next.rows[entry.pathKey]?.seq ?? -1) <= entry.seq) {
          if (entry.kind === "deleted") delete next.rows[entry.pathKey];
          else next.rows[entry.pathKey] = await observe(entry, entry.afterHash);
        }
        next.seen.push(identity);
        // Facts deliberately retain no names or bodies, even for live entries.
        next.facts.push({
          seq: entry.seq,
          peer: entry.peer,
          origin: entry.origin,
          kind: entry.kind,
        });
      };
      for (const part of packet.batches) {
        const entries = packet.entries.filter((entry) =>
          entry.batch === part.batch
        );
        const stage = next.staged[part.batch] ?? { entries: [], next: 1 };
        // A replay after persistence may repeat the same part. Stable entry
        // offsets and seq dedup prevent a tail from becoming a complete group.
        if (part.part > stage.next) throw new Error("missing batch prefix");
        for (const entry of entries) {
          if (!stage.entries.some((old) => old.seq === entry.seq)) {
            stage.entries.push(entry);
          }
        }
        stage.next = Math.max(stage.next, packet.to - part.batch + 2);
        if (part.complete) {
          for (const entry of stage.entries) await apply(entry);
          delete next.staged[part.batch];
        } else next.staged[part.batch] = stage;
      }
      next.cursor = packet.to;
    }
    await persist(next); // The plugin's state is durable before the host ack.
    return { ack: packet.token };
  });
  ctx.commands.register(
    { id: "write", label: "Write", target: "server" },
    ({ path, content, base }) =>
      ctx.files.requestWrite(path, new TextEncoder().encode(content), { base }),
  );
  ctx.commands.register(
    { id: "action", label: "Action", target: "server" },
    ({ action, args }) => ctx.actions.request(action, args),
  );
}
