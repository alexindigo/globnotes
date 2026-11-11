// SPDX-License-Identifier: LGPL-3.0-only
import { pinExplanation } from "./configurationProvenance.js";
export function visibleSettingsFields(page, values) {
  return (page.fields ?? []).filter((field) => {
    if (!field.visibleWhen) return true;
    const conditions = Array.isArray(field.visibleWhen) ? field.visibleWhen : [field.visibleWhen];
    return conditions.every(condition => condition.oneOf
      ? condition.oneOf.includes(values[condition.field])
      : values[condition.field] === condition.equals);
  });
}

export function settingsFieldGroups(page, values) {
  const visibleFields = visibleSettingsFields(page, values);
  const byKey = new Map(visibleFields.map((field) => [field.key, field]));
  const assigned = new Set(), groups = [];
  for (const group of page.groups ?? []) {
    group.fields.forEach((key) => assigned.add(key));
    const fields = group.fields.map((key) => byKey.get(key)).filter(Boolean);
    if (fields.length) groups.push({ ...group, descriptionParagraphs: group.description?.split(/\r?\n\s*\r?\n/).filter(paragraph => paragraph.trim()) ?? [], fields });
  }
  const remaining = visibleFields.filter((field) => !assigned.has(field.key));
  if (remaining.length) groups.push({ id: "ungrouped", fields: remaining });
  return groups;
}

/** Control formatting and event adaptation are shared plain-module concerns. */
export function settingsFieldPresentation(field, value, provenance) {
  return { short:['toggle','select','number','color'].includes(field.type),
    pin:pinExplanation(provenance),
    text:String(value ?? ''), selected:JSON.stringify(value),
    browseLabel:field.type === 'folder' ? 'Choose folder…' : field.type === 'file' ? 'Choose file…' : null };
}
export function createSettingsFieldIntents(props, emit) {
  function edit(raw) { if (!props.readonly) emit('edit', { key:props.field.key, raw }); }
  function commit() { if (!props.readonly) emit('commit', props.field.key); }
  function enter(event) {
    if (event.target.form) return;
    event.preventDefault();
    commit();
  }
  function change(raw) { edit(raw); commit(); }
  return { edit, commit, change, enter,
    toggle:() => change(!props.value),
    select:raw => { let value; try { value = JSON.parse(raw); } catch { value = raw; } change(value); },
  };
}
