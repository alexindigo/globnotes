// SPDX-License-Identifier: LGPL-3.0-only
export function commandPaletteEntries(commands, hint) {
  return commands.map((command) => ({
    topic: command.id,
    label: command.label,
    group: command.group,
    hint: hint(command.id),
  }));
}

export function filterCommandEntries(entries, query) {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) =>
    !q || `${entry.group} ${entry.label}`.toLowerCase().includes(q));
}

export function commandGroups(entries) {
  return [...new Set(entries.map((entry) => entry.group))];
}

export function commandGroupEntries(entries, group) {
  return entries.filter((entry) => entry.group === group);
}
