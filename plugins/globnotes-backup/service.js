// SPDX-License-Identifier: LGPL-3.0-only
import { BackupQueue } from "./backup.js";
import { bind, status } from "./state.js";
export function activate(ctx) {
  const queue = new BackupQueue(ctx);
  bind(queue);
  ctx.commands.register({ id: "status", label: "Inspect versioned backup status", target: "server" }, status);
  ctx.settings.subscribe(() => queue.configurationChanged());
  // The hub offers the previous bytes before a save, rename or delete replaces them.
  ctx.jobs.afterActivation({ id: "backup-recovery" }, () => queue.initialize());
  ctx.versioning.onOffer(offer => queue.capture(offer), { after: ["backup-recovery"] });
}
