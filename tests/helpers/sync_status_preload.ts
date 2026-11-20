// SPDX-License-Identifier: LGPL-3.0-only
// Loaded only by the sync-status native case with deno --import. No product
// switch or HTTP endpoint exists. Real driver transitions still invalidate the
// normal vault stream; the fixture supplies old wall time and held activity.
import { DriverPeers } from "../../server/hub/drivers/peers.ts";
import { DriverSession } from "../../server/hub/drivers/session.ts";
import { createFixtureScope } from "./fixture_scope_engine.ts";
import { syncStatusReader } from "./sync_status_control.ts";

// This reader's owner is the shim's actual process lifetime. It creates no
// child, observer, deadline or asynchronous diagnostic transport.
// The directory is borrowed and no resource is registered for disposal. Its
// read custody ends with the process; unload cannot join asynchronous close work.
const lifetime = createFixtureScope();
const reader = syncStatusReader(
  lifetime.scope,
  `${Deno.env.get("GLOBNOTES_GLOBNOTES_PATH")}/.globnotes`,
);
const seam = () => reader.read()?.value ?? {};
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
