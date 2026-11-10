// SPDX-License-Identifier: LGPL-3.0-only
// Loaded only by the sync-status native case with deno --import. No product
// switch or HTTP endpoint exists. Real driver transitions still invalidate the
// normal vault stream; the fixture supplies old wall time and held activity.
import { DriverPeers } from "../../server/hub/drivers/peers.ts";
import { DriverSession } from "../../server/hub/drivers/session.ts";

interface Seam {
  failureSince?: Record<string, number>;
  activities?: Record<string, "receiving" | "sending" | null>;
}
function seam(): Seam {
  try {
    return JSON.parse(Deno.readTextFileSync(
      `${Deno.env.get("GLOBNOTES_PATH")}/.globnotes/sync-status-test.json`,
    ));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}
const observe = DriverPeers.prototype.observeStatus;
DriverPeers.prototype.observeStatus = function (peer, status, enabled) {
  observe.call(this, peer, status, enabled);
  const at = seam().failureSince?.[peer];
  if (enabled && ["failed", "locked"].includes(status) && at !== undefined) {
    this.store.db.prepare("UPDATE meta SET value=? WHERE key=?")
      .run(String(at), `driver_failure:${peer}`);
  }
};
const activity = DriverSession.prototype.activity;
DriverSession.prototype.activity = function () {
  const activities = seam().activities;
  return activities && Object.hasOwn(activities, this.instance.id)
    ? activities[this.instance.id]
    : activity.call(this);
};
