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

/** Control formatting and event adaptation are shared plain-module concerns. */
export function settingsFieldPresentation(field, value, provenance) {
  return { short:['toggle','select','number','color'].includes(field.type),
    pin:provenance?.source === 'environment' ? 'Set by the server configuration' : '',
    text:String(value ?? ''), selected:JSON.stringify(value),
    browseLabel:field.type === 'folder' ? 'Choose folder…' : field.type === 'file' ? 'Choose file…' : null };
}
export function createSettingsFieldIntents(props, emit) {
  function edit(raw) { if (!props.readonly) emit('edit', { key:props.field.key, raw }); }
  function commit() { if (!props.readonly) emit('commit', props.field.key); }
  function change(raw) { edit(raw); commit(); }
  return { edit, commit, change,
    toggle:() => change(!props.value),
    select:raw => { let value; try { value = JSON.parse(raw); } catch { value = raw; } change(value); },
  };
}
