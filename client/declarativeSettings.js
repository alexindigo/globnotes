// SPDX-License-Identifier: LGPL-3.0-only
export function visibleSettingsFields(page, values) {
  return (page.fields ?? []).filter((field) => {
    if (!field.visibleWhen) return true;
    return values[field.visibleWhen.field] === field.visibleWhen.equals;
  });
}

export function settingsFieldGroups(page, values) {
  const visibleFields = visibleSettingsFields(page, values);
  const byKey = new Map(visibleFields.map((field) => [field.key, field]));
  const assigned = new Set(), groups = [];
  for (const group of page.groups ?? []) {
    group.fields.forEach((key) => assigned.add(key));
    const fields = group.fields.map((key) => byKey.get(key)).filter(Boolean);
    if (fields.length) groups.push({ ...group, fields });
  }
  const remaining = visibleFields.filter((field) => !assigned.has(field.key));
  if (remaining.length) groups.push({ id: "ungrouped", fields: remaining });
  return groups;
}
