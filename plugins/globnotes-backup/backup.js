// SPDX-License-Identifier: LGPL-3.0-only
import { BackupError, LIMITS, bytesRecord, digestValid, fail, hash, join, originalPath, parent, pathValid, readRecord, writeRecord } from "./journal.js";

export class BackupQueue {
  #tail = Promise.resolve();
  #pending = 0;
  #recent = new Set();
  #status = { completed: 0, skipped: 0, failed: 0, pendingRecovery: false, ringCommitted: false, lastError: null, lastOperation: null, configuration: null };
  constructor(ctx) { this.ctx = ctx; }
  status() { return structuredClone({ ...this.#status, pendingJobs: this.#pending }); }
  #error(error, operation) {
    this.#status.failed++;
    const code = error instanceof BackupError || /^fs_[a-z_]+$/.test(error?.code ?? "") ? error.code : "backup_processing_failed";
    this.#status.lastError = { code, ...(error?.effect ? { effect: error.effect } : {}) };
    this.#status.lastOperation = operation ? { operationId: operation.operationId, path: operation.path } : this.#status.lastOperation;
  }
  #admit(task, operation) {
    if (this.#pending >= LIMITS.jobs) { const error = new BackupError("backup_queue_full"); this.#error(error, operation); return Promise.reject(error); }
    this.#pending++;
    const result = this.#tail.then(task).catch(error => { this.#error(error, operation); throw error; }).finally(() => { this.#pending--; });
    this.#tail = result.catch(() => undefined);
    return result;
  }
  async #configuration() {
    const snapshot = await this.ctx.settings.read(), values = snapshot.values?.backup;
    if (!values || !Number.isInteger(values.retention) || values.retention < 1 || values.retention > LIMITS.slots || typeof values.basePath !== "string" || (values.basePath !== "" && !pathValid(values.basePath)) || typeof snapshot.sourceKey !== "string") fail("invalid_backup_configuration");
    this.#status.configuration = { retention: values.retention, basePath: values.basePath, fields: snapshot.fields?.backup ?? {} };
    return { count: values.retention, base: values.basePath, sourceKey: snapshot.sourceKey };
  }
  configurationChanged() { return this.#admit(() => this.#configuration()); }
  initialize() {
    return this.#admit(async () => {
      const config = await this.#configuration();
      const workspace = await this.#workspace(config, false);
      if (workspace) await this.#recover(workspace, config);
    }).catch(() => { /* Keep status available; subsequent genuine capture failures reach host diagnostics. */ });
  }
  capture(fact) {
    const before = fact?.before;
    if (!before || before.contentAvailable !== true || typeof before.content !== "string" || fact.origin === "external" || !["save", "rename", "delete"].includes(fact.action)) {
      this.#status.skipped++;
      return Promise.resolve({ skipped: true, reason: "preimage_unavailable" });
    }
    const captured = { operationId: fact.operationId, path: before.path, content: before.content };
    return this.#admit(async () => {
      const config = await this.#configuration();
      const name = originalPath(captured.path);
      if (typeof captured.operationId !== "string" || !captured.operationId || captured.operationId.length > 128) fail("backup_invalid_operation");
      const key = await hash(new TextEncoder().encode(JSON.stringify([captured.operationId, name])));
      const workspace = await this.#workspace(config, true);
      await this.#recover(workspace, config);
      if (this.#recent.has(key)) { this.#status.skipped++; return { skipped: true, reason: "duplicate_fact" }; }
      if (captured.content.length > LIMITS.bodyBytes) fail("fs_too_large");
      const bytes = new TextEncoder().encode(captured.content);
      if (bytes.length > LIMITS.bodyBytes) fail("fs_too_large");
      this.#status.ringCommitted = false;
      return await this.#begin(workspace, config, captured, key, bytes);
    }, captured);
  }
  #options(config) { return { sourceKey: config.sourceKey }; }
  async #workspace(config, create) {
    const options = this.#options(config), fs = this.ctx.fs;
    const vaultStat = await fs.stat(".", options);
    if (vaultStat?.kind !== "directory") fail("backup_workspace_conflict");
    const vault = await fs.realPath(".", { ...options, expect: { kind: "exact", token: vaultStat.token } });
    const location = join(vault, ".globnotes-backup"), marker = join(location, "owner.json");
    let stat = await fs.stat(location, options);
    if (!stat) {
      if (!create) return null;
      stat = await fs.mkdir(location, { ...options, expect: { kind: "absent" } });
      const owner = { schema: 1, kind: "globnotes-backup-workspace", vault, location, nonce: crypto.randomUUID() };
      await writeRecord(fs, marker, owner, null, options);
    }
    if (stat.kind !== "directory" || await fs.realPath(location, options) !== location) fail("backup_workspace_conflict");
    const owned = await readRecord(fs, marker, options), owner = owned?.value;
    if (!owner || owner.schema !== 1 || owner.kind !== "globnotes-backup-workspace" || owner.vault !== vault || owner.location !== location || typeof owner.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(owner.nonce)) fail("backup_workspace_conflict");
    return { vault, location, nonce: owner.nonce, active: join(location, "active.json") };
  }
  #validateJournal(workspace, journal) {
    const token = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
    const keys = values => Array.isArray(values) && values.length <= LIMITS.recent && values.every(digestValid) && new Set(values).size === values.length;
    if (journal.schema !== 1 || journal.owner !== workspace.nonce || !/^[a-f0-9-]{36}$/.test(journal.transaction ?? "") || typeof journal.operationId !== "string" || !journal.operationId || journal.operationId.length > 128 || !digestValid(journal.operationKey) || !pathValid(journal.path) || !originalPath(journal.path) || !Number.isInteger(journal.count) || journal.count < 1 || journal.count > LIMITS.slots || typeof journal.base !== "string" || journal.base !== "" && !pathValid(journal.base) || !token(journal.sourceKey) || !["preparing-root", "staging-intent", "prepared", "ring-committed"].includes(journal.phase)) fail("backup_journal_corrupt");
    if (journal.phase === "preparing-root") {
      if (journal.absenceVerified !== true || journal.createdToken !== null && !token(journal.createdToken)) fail("backup_journal_corrupt");
      return;
    }
    if (journal.recoverySourceKey !== undefined && !token(journal.recoverySourceKey)) fail("backup_journal_corrupt");
    if (!pathValid(journal.root) || !journal.root.startsWith("/") || !digestValid(journal.familyKey) || !Array.isArray(journal.old) || journal.old.length > LIMITS.slots || !Array.isArray(journal.stages) || journal.stages.length !== journal.old.length + 1 || !Array.isArray(journal.planned) || journal.planned.length !== Math.min(journal.count, journal.old.length + 1)) fail("backup_journal_corrupt");
    if (!token(journal.rootToken) || !keys(journal.recent) || journal.oldMetadataHash !== null && !digestValid(journal.oldMetadataHash) || journal.old.length && journal.oldMetadataHash === null || !Number.isInteger(journal.staged) || journal.staged < 0 || journal.staged > journal.stages.length || !Number.isInteger(journal.published) || journal.published < 0 || journal.published > journal.planned.length || journal.pruned !== undefined && (!Number.isInteger(journal.pruned) || journal.pruned < journal.planned.length || journal.pruned > journal.old.length) || journal.phase !== "staging-intent" && journal.staged !== journal.stages.length || !Array.isArray(journal.attempted) || journal.attempted.length !== journal.planned.length || journal.attempted.some(value => typeof value !== "boolean") || !Array.isArray(journal.initial) || journal.initial.length !== journal.planned.length) fail("backup_journal_corrupt");
    for (const [index, expected] of journal.initial.entries()) {
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) fail("backup_journal_corrupt");
      if (expected.kind === "absent") { if (Object.keys(expected).length !== 1 || journal.old[index]) fail("backup_journal_corrupt"); }
      else if (expected.kind !== "exact" || !token(expected.token) || Object.keys(expected).length !== 2 || !journal.old[index]) fail("backup_journal_corrupt");
    }
    for (const [index, stage] of journal.stages.entries()) if (!stage || stage.file !== join(workspace.location, `stage-${journal.transaction}-${index}.bin`) || !digestValid(stage.hash)) fail("backup_journal_corrupt");
    for (const [index, slot] of journal.old.entries()) if (!slot || slot.path !== this.#slot(journal.root, journal.path, index) || !digestValid(slot.hash) || !token(slot.token)) fail("backup_journal_corrupt");
    for (const [index, slot] of journal.planned.entries()) if (!slot || slot.path !== this.#slot(journal.root, journal.path, index) || slot.hash !== journal.stages[index].hash) fail("backup_journal_corrupt");
  }
  #validateFamily(workspace, record, root, path, familyKey) {
    if (!record || record.schema !== 1 || record.owner !== workspace.nonce || record.familyKey !== familyKey || record.root !== root || record.path !== path || !digestValid(record.operationKey) || !Array.isArray(record.slots) || !record.slots.length || record.slots.length > LIMITS.slots || !Array.isArray(record.recent) || record.recent.length > LIMITS.recent || !record.recent.every(digestValid) || new Set(record.recent).size !== record.recent.length || !record.recent.includes(record.operationKey) || record.slots.some((slot, index) => !slot || !digestValid(slot.hash) || slot.path !== this.#slot(root, path, index) || typeof slot.token !== "string" || !slot.token || slot.token.length > 4096)) fail("backup_family_corrupt");
  }
  #slot(root, path, index) { return join(root, `${path}.md.${index}.bak`); }
  async #verifiedFile(file, expectedHash, config) {
    const fs = this.ctx.fs, options = this.#options(config), stat = await fs.stat(file, options);
    if (!stat || stat.kind !== "file") fail("backup_owned_slot_conflict");
    if (await fs.realPath(file, { ...options, expect: { kind: "exact", token: stat.token } }) !== file) fail("backup_owned_slot_conflict");
    const bytes = await fs.readFile(file, { ...options, expect: { kind: "exact", token: stat.token } });
    if (await hash(bytes) !== expectedHash) fail("backup_owned_slot_conflict");
    return { bytes, token: stat.token };
  }
  async #active(workspace, config) {
    this.#status.pendingRecovery = !!await this.ctx.fs.stat(workspace.active, this.#options(config));
    const record = await readRecord(this.ctx.fs, workspace.active, this.#options(config));
    this.#status.pendingRecovery = !!record;
    if (record) this.#validateJournal(workspace, record.value);
    return record;
  }
  async #saveJournal(workspace, record, config) {
    bytesRecord(record.value);
    this.#status.pendingRecovery = true;
    let saved;
    try { saved = await writeRecord(this.ctx.fs, workspace.active, record.value, record.token ? record : null, this.#options(config)); }
    catch (error) {
      if (error?.effect === "none") {
        try { this.#status.pendingRecovery = !!await this.ctx.fs.stat(workspace.active, this.#options(config)); }
        catch (inspectionError) { error.cause = inspectionError; }
      }
      throw error;
    }
    this.#status.pendingRecovery = true;
    return saved;
  }
  async #begin(workspace, config, captured, operationKey, bytes) {
    const fs = this.ctx.fs, options = this.#options(config), transaction = crypto.randomUUID();
    let root;
    if (config.base === "") root = workspace.vault;
    else {
      let stat = await fs.stat(config.base, options);
      if (!stat) {
        let setup = { value: { schema: 1, owner: workspace.nonce, transaction, operationId: captured.operationId, operationKey, path: captured.path, count: config.count, base: config.base, sourceKey: config.sourceKey, phase: "preparing-root", createdToken: null, absenceVerified: true } };
        setup = await this.#saveJournal(workspace, setup, config);
        stat = await fs.mkdir(config.base, { ...options, recursive: true, expect: { kind: "absent" } });
        setup.value.createdToken = stat.token;
        setup = await this.#saveJournal(workspace, setup, config);
        root = await fs.realPath(config.base, { ...options, expect: { kind: "exact", token: stat.token } });
      } else {
        if (stat.kind !== "directory") fail("invalid_backup_configuration");
        root = await fs.realPath(config.base, { ...options, expect: { kind: "exact", token: stat.token } });
      }
    }
    const canonical = await fs.stat(root, options);
    if (canonical?.kind !== "directory") fail("backup_root_conflict");
    const familyKey = await hash(new TextEncoder().encode(JSON.stringify([root, captured.path])));
    const metadataPath = join(workspace.location, `family-${familyKey}.json`), metadata = await readRecord(fs, metadataPath, options);
    const old = metadata?.value;
    if (old) this.#validateFamily(workspace, old, root, captured.path, familyKey);
    if (old?.recent.includes(operationKey)) {
      this.#remember(operationKey); this.#status.skipped++;
      // An existing preparing-root intent cannot have a prior committed family here.
      return { skipped: true, reason: "duplicate_fact" };
    }
    const slots = old?.slots ?? [];
    const initial = [];
    for (let index = 0; index < LIMITS.slots; index++) {
      const file = this.#slot(root, captured.path, index), stat = await fs.stat(file, options);
      if (!slots[index] && stat) fail("backup_alien_slot");
      if (slots[index]) { const verified = await this.#verifiedFile(file, slots[index].hash, config); initial.push({ kind: "exact", token: verified.token }); }
      else initial.push({ kind: "absent" });
    }
    const stages = [{ file: join(workspace.location, `stage-${transaction}-0.bin`), hash: await hash(bytes) }, ...slots.map((slot, index) => ({ file: join(workspace.location, `stage-${transaction}-${index + 1}.bin`), hash: slot.hash }))];
    const planned = stages.slice(0, config.count).map((stage, index) => ({ path: this.#slot(root, captured.path, index), hash: stage.hash }));
    const existing = await this.#active(workspace, config);
    let journal = await this.#saveJournal(workspace, { ...(existing ? { token: existing.token } : {}), value: { schema: 1, owner: workspace.nonce, transaction, operationId: captured.operationId, operationKey, path: captured.path, count: config.count, base: config.base, sourceKey: config.sourceKey, phase: "staging-intent", root, rootToken: canonical.token, familyKey, old: slots, oldMetadataHash: metadata?.hash ?? null, recent: old?.recent ?? [], stages, planned, initial: initial.slice(0, planned.length), attempted: planned.map(() => false), staged: 0, published: 0 } }, config);
    await fs.writeFile(stages[0].file, bytes, { ...options, expect: { kind: "absent" } });
    await this.#verifiedFile(stages[0].file, stages[0].hash, config);
    journal.value.staged = 1;
    journal = await this.#saveJournal(workspace, journal, config);
    return await this.#finish(workspace, journal, config);
  }
  #remember(key) {
    this.#recent.add(key);
    if (this.#recent.size > LIMITS.recent) this.#recent.delete(this.#recent.values().next().value);
  }
  async #recover(workspace, config) {
    const record = await this.#active(workspace, config);
    if (!record) return;
    if (record.value.phase === "preparing-root") {
      // Token-backed canonical observation does not reconstruct a lost preimage.
      if (!record.value.createdToken) fail("backup_root_setup_unknown");
      await this.ctx.fs.realPath(record.value.base, { ...this.#options(config), expect: { kind: "exact", token: record.value.createdToken } });
      fail("backup_incomplete_capture");
    }
    await this.#finish(workspace, record, config, true);
  }
  async #finish(workspace, journal, config, recovering = false) {
    const fs = this.ctx.fs, options = this.#options(config);
    let state = journal.value;
    this.#validateJournal(workspace, state);
    const key = await hash(new TextEncoder().encode(JSON.stringify([state.root, state.path])));
    if (key !== state.familyKey) fail("backup_journal_corrupt");
    const root = await fs.stat(state.root, options);
    if (root?.kind !== "directory" || await fs.realPath(state.root, options) !== state.root) fail("backup_root_conflict");
    if (!recovering && root.token !== state.rootToken) fail("backup_root_conflict");
    const metadataPath = join(workspace.location, `family-${state.familyKey}.json`);
    let metadata = await readRecord(fs, metadataPath, options);
    if (metadata) this.#validateFamily(workspace, metadata.value, state.root, state.path, state.familyKey);
    if (metadata?.value.operationKey === state.operationKey) {
      if (metadata.value.owner !== workspace.nonce || metadata.value.root !== state.root || metadata.value.path !== state.path || JSON.stringify(metadata.value.slots.map(slot => ({ path: slot.path, hash: slot.hash }))) !== JSON.stringify(state.planned)) fail("backup_family_corrupt");
      state.phase = "ring-committed";
    } else if (state.phase === "ring-committed") fail("backup_family_corrupt");
    if (state.phase !== "ring-committed") {
      if (!metadata && state.oldMetadataHash !== null || metadata && metadata.hash !== state.oldMetadataHash) fail("backup_family_conflict");
      if (recovering) {
        for (let index = 0; index < state.planned.length; index++) {
          if (state.attempted[index]) continue;
          const slot = state.planned[index];
          if (state.initial[index].kind === "absent") {
            if (await fs.stat(slot.path, options)) fail("backup_alien_slot");
          } else {
            const verified = await this.#verifiedFile(slot.path, state.old[index].hash, config);
            state.initial[index] = { kind: "exact", token: verified.token };
          }
        }
        state.recoverySourceKey = config.sourceKey;
        journal = await this.#saveJournal(workspace, journal, config);
        state = journal.value;
      }
      // Staging intent is discoverable even when new bytes never arrived.
      const newStat = await fs.stat(state.stages[0].file, options);
      if (!newStat) fail("backup_incomplete_capture");
      for (let index = 0; index < state.stages.length; index++) {
        const stage = state.stages[index];
        if (!await fs.stat(stage.file, options)) {
          if (state.phase !== "staging-intent" || index === 0) fail("backup_incomplete_capture");
          const old = await this.#verifiedFile(state.old[index - 1].path, stage.hash, config);
          await fs.writeFile(stage.file, old.bytes, { ...options, expect: { kind: "absent" } });
        }
        await this.#verifiedFile(stage.file, stage.hash, config);
        state.staged = index + 1;
        if (state.phase === "staging-intent") { journal = await this.#saveJournal(workspace, journal, config); state = journal.value; }
      }
      state.phase = "prepared";
      journal = await this.#saveJournal(workspace, journal, config);
      state = journal.value;
      const completed = [];
      for (let index = 0; index < state.planned.length; index++) {
        const slot = state.planned[index];
        await fs.mkdir(parent(slot.path), { ...options, recursive: true });
        const current = await fs.stat(slot.path, options);
        let already = false;
        if (current) {
          if (current.kind !== "file" || await fs.realPath(slot.path, options) !== slot.path) fail("backup_alien_slot");
          const actual = await hash(await fs.readFile(slot.path, { ...options, expect: { kind: "exact", token: current.token } }));
          already = actual === slot.hash;
          if (!already && actual !== state.old[index]?.hash) fail("backup_alien_slot");
        } else if (state.old[index]) fail("backup_owned_slot_conflict");
        const stage = already ? null : await this.#verifiedFile(state.stages[index].file, slot.hash, config);
        if (!state.attempted[index]) {
          const expected = state.initial[index];
          if (expected.kind === "absent" ? !!current : current?.token !== expected.token) fail(expected.kind === "absent" ? "backup_alien_slot" : "backup_owned_slot_conflict");
          state.attempted[index] = true;
          journal = await this.#saveJournal(workspace, journal, config);
          state = journal.value;
        }
        if (!already) {
          try { await fs.writeFile(slot.path, stage.bytes, { ...options, expect: current ? { kind: "exact", token: current.token } : { kind: "absent" } }); }
          catch (error) {
            if (error?.effect === "none") { state.attempted[index] = false; journal = await this.#saveJournal(workspace, journal, config); state = journal.value; }
            throw error;
          }
        }
        const verified = await this.#verifiedFile(slot.path, slot.hash, config);
        completed.push({ ...slot, token: verified.token });
        state.published = index + 1;
        journal = await this.#saveJournal(workspace, journal, config);
        state = journal.value;
      }
      const next = { schema: 1, owner: workspace.nonce, familyKey: state.familyKey, root: state.root, path: state.path, operationKey: state.operationKey, slots: completed, recent: [...state.recent.filter(key => key !== state.operationKey), state.operationKey].slice(-LIMITS.recent) };
      metadata = await writeRecord(fs, metadataPath, next, metadata, options);
      state.phase = "ring-committed";
      journal = await this.#saveJournal(workspace, journal, config);
      state = journal.value;
    }
    this.#remember(state.operationKey);
    for (const slot of state.planned) await this.#verifiedFile(slot.path, slot.hash, config);
    this.#status.ringCommitted = true;
    for (let index = state.planned.length; index < state.old.length; index++) {
      const slot = state.old[index], stat = await fs.stat(slot.path, options);
      if (stat) {
        const verified = await this.#verifiedFile(slot.path, slot.hash, config);
        await fs.remove(slot.path, { ...options, token: verified.token });
      }
      if (await fs.stat(slot.path, options)) fail("backup_prune_conflict");
      state.pruned = index + 1;
      journal = await this.#saveJournal(workspace, journal, config);
      state = journal.value;
    }
    for (const stage of state.stages) {
      if (await fs.stat(stage.file, options)) {
        const verified = await this.#verifiedFile(stage.file, stage.hash, config);
        await fs.remove(stage.file, { ...options, token: verified.token });
      }
      if (await fs.stat(stage.file, options)) fail("backup_cleanup_conflict");
    }
    await fs.remove(workspace.active, { ...options, token: journal.token });
    if (await fs.stat(workspace.active, options)) fail("backup_cleanup_conflict");
    this.#status.completed++;
    this.#status.pendingRecovery = false;
    this.#status.lastError = null;
    this.#status.lastOperation = { operationId: state.operationId, path: state.path };
    return { completed: true };
  }
}
