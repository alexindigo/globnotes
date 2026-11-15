// Canonical production-fixture leaves shared by native and aggregate execution.
import { PREFIX_AUTH_CASES } from "./prefix-auth-cases.mjs";
import { REVIEW_REPAIR_CASES } from "./review-repair-cases.mjs";
import { matrixSelection, parseMatrixArguments } from "./native-matrix-cases.mjs";
export const SETTINGS_UI_CASES = [
  "inline-core", "cross-browser", "pending-recovery", "menu-parity", "editor-source", "editor-wysiwyg", "geometry", "open-dismiss",
  ...["wizard", "logout"].flatMap(kind => ["cancel", "discard", "save", "blocked-save"].map(choice => `${kind}-${choice}`)),
].map(label => ({ label, groups: 1 }));
export const ACCESS_SETTINGS_CASES = [
  "initial-public-prefixed", "totp-in-place", "public-lock", "protected-public-cancel", "protected-public-save",
  "current-totp-password", "lost-password-receipt", "replace-authenticator", "peer-policy",
  "initial-public-explicit-lock-prefixed", "protected-public-explicit-unlocked", "protected-enrolment-geometry",
  "protected-current-totp-geometry", "locked-controls", "pinned-credentials",
].map(label => ({ label, groups: 1 }));
export const PERMISSION_CASES = [
  { label: "normal-parent", groups: 7 }, { label: "isolated-import-parent", groups: 0 }, { label: "dirty-work", groups: 1 },
];
export const BACKUP_CASES = [
  ...Array.from({ length: 10 }, (_, index) => ({ label: `count-${index + 1}`, kind: "count", count: index + 1 })),
  ...["aliases", "location", "pin", "recovery", "cleanup", "distinct", "retarget", "failure", "settings-lock"].map(kind => ({ label: kind, kind })),
];
export const MATRIX_CASES = {
  "plugin-prefix-auth": PREFIX_AUTH_CASES, "plugin-review-repairs": REVIEW_REPAIR_CASES,
  "settings-ui": SETTINGS_UI_CASES, "access-settings": ACCESS_SETTINGS_CASES, "plugin-permissions": PERMISSION_CASES,
  "backup-plugin": BACKUP_CASES,
};
export const nativeMatrixSelection = driver => matrixSelection(driver, MATRIX_CASES[driver]);
export const parseFixtureArguments = (driver, args) => parseMatrixArguments(args, MATRIX_CASES[driver]);

// The shared root is a handoff slot, not a second permanent leaf report.
// Retain exact bytes before releasing it for the next create-new producer.
export async function retainFixtureReport(source, retained, storage) {
  const raw = await storage.read(source), report = JSON.parse(raw);
  await storage.write(retained, raw, { createNew: true });
  await storage.remove(source);
  return { report, retained };
}

export async function collectFixtureReports(driver, readLeaf) {
  const outcomes = [], leafReports = [], names = new Set();
  for (const item of MATRIX_CASES[driver]) {
    const { report, retained } = await readLeaf(item);
    if (report.failure || !Array.isArray(report.outcomes) || report.outcomes.length !== (item.groups ?? 1) || report.outcomes.some(row => !row.passed)) throw Error(`${driver}/${item.label}: incomplete native fixture evidence`);
    for (const row of report.outcomes) {
      const name = row.name ?? row.group;
      if (!name || names.has(name)) throw Error(`${driver}/${item.label}: duplicate or unnamed outcome`);
      names.add(name); outcomes.push(row);
    }
    leafReports.push({ variant: item.label, report: retained });
  }
  return { outcomes, leafReports };
}
