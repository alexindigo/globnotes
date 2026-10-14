// SPDX-License-Identifier: LGPL-3.0-only

import {
  type JsonValues,
  jsonValues,
  PluginContractError,
  record,
  type SettingsField,
  type SettingsPage,
  stableId,
  text,
  uniqueStrings,
} from "./contracts.ts";

const KINDS = new Set([
  "toggle",
  "text",
  "textarea",
  "number",
  "slider",
  "select",
  "file",
  "folder",
  "color",
]);
function invalid(detail: string): never {
  throw new PluginContractError(422, "invalid_plugin_settings", detail);
}
function only(raw: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(raw).some((key) => !keys.includes(key))) {
    invalid(`${label} has an unsupported property`);
  }
}
function optionalText(raw: Record<string, unknown>, key: string) {
  if (raw[key] !== undefined && typeof raw[key] !== "string") {
    invalid(`${key} must be text`);
  }
}

export function validateFieldValue(
  field: SettingsField,
  value: unknown,
): string | number | boolean {
  if (field.type === "toggle") {
    if (typeof value !== "boolean") invalid(`${field.key} must be a boolean`);
  } else if (field.type === "number" || field.type === "slider") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalid(`${field.key} must be a finite number`);
    }
    if (field.min !== undefined && value < field.min) {
      invalid(`${field.key} is below its minimum`);
    }
    if (field.max !== undefined && value > field.max) {
      invalid(`${field.key} is above its maximum`);
    }
    if (field.step !== undefined) {
      const ratio = (value - (field.min ?? 0)) / field.step;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-8) {
        invalid(`${field.key} does not match its step`);
      }
    }
  } else if (field.type === "select") {
    if (!field.options?.some((option) => option.value === value)) {
      invalid(`${field.key} must be a declared option`);
    }
  } else {
    if (typeof value !== "string") invalid(`${field.key} must be text`);
    if (field.minLength !== undefined && value.length < field.minLength) {
      invalid(`${field.key} is too short`);
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      invalid(`${field.key} is too long`);
    }
    if (field.type === "color" && !/^#[a-fA-F0-9]{6}$/.test(value)) {
      invalid(`${field.key} must be a six-digit color`);
    }
  }
  return value as string | number | boolean;
}

export function validateSettingsPages(value: unknown): SettingsPage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    invalid("settings must be an array of page descriptors");
  }
  const pages: SettingsPage[] = [];
  const pageIds = new Set<string>();
  for (const input of value) {
    const page = record(input, "settings page");
    only(
      page,
      ["id", "label", "description", "renderer", "fields", "groups"],
      "page",
    );
    stableId(page.id, "page id");
    text(page.label, "page label");
    optionalText(page, "description");
    if (pageIds.has(page.id as string)) invalid("duplicate settings page id");
    pageIds.add(page.id as string);
    const renderer = record(page.renderer, "renderer");
    only(renderer, ["kind", "version"], "renderer");
    if (renderer.kind !== "declarative-v1" || renderer.version !== 1) {
      throw new PluginContractError(
        422,
        "unsupported_plugin_feature",
        "v2 supports only declarative-v1 settings renderer version 1",
      );
    }
    if (!Array.isArray(page.fields)) invalid("page fields must be an array");
    const fields = new Map<string, SettingsField>();
    for (const input of page.fields) {
      const field = record(input, "settings field");
      only(field, [
        "key",
        "label",
        "description",
        "type",
        "default",
        "min",
        "max",
        "step",
        "minLength",
        "maxLength",
        "options",
        "visibleWhen",
      ], "field");
      stableId(field.key, "field key");
      text(field.label, "field label");
      optionalText(field, "description");
      if (!KINDS.has(field.type as string)) {
        invalid("unsupported settings field type");
      }
      if (fields.has(field.key as string)) invalid("duplicate field key");
      const numeric = field.type === "number" || field.type === "slider";
      const textual = ["text", "textarea", "file", "folder", "color"].includes(
        field.type as string,
      );
      for (const key of ["min", "max", "step"]) {
        if (
          field[key] !== undefined &&
          (!numeric || typeof field[key] !== "number" ||
            !Number.isFinite(field[key]))
        ) invalid(`${key} is valid only as a finite numeric constraint`);
      }
      if (field.step !== undefined && (field.step as number) <= 0) {
        invalid("step must be positive");
      }
      if (
        field.min !== undefined && field.max !== undefined &&
        (field.min as number) > (field.max as number)
      ) invalid("minimum exceeds maximum");
      if (
        field.type === "slider" &&
        (field.min === undefined || field.max === undefined)
      ) invalid("slider requires min and max");
      for (const key of ["minLength", "maxLength"]) {
        if (
          field[key] !== undefined &&
          (!textual || !Number.isSafeInteger(field[key]) ||
            (field[key] as number) < 0)
        ) invalid(`${key} is valid only as a non-negative text constraint`);
      }
      if (
        field.minLength !== undefined && field.maxLength !== undefined &&
        (field.minLength as number) > (field.maxLength as number)
      ) invalid("minimum length exceeds maximum length");
      if (field.type === "select") {
        if (!Array.isArray(field.options) || !field.options.length) {
          invalid("select requires options");
        }
        const values = new Set<string>();
        for (const input of field.options) {
          const option = record(input, "option");
          only(option, ["label", "value"], "option");
          text(option.label, "option label");
          if (
            !["string", "number", "boolean"].includes(typeof option.value) ||
            (typeof option.value === "number" && !Number.isFinite(option.value))
          ) invalid("option value must be a finite primitive");
          const key = JSON.stringify(option.value);
          if (values.has(key)) invalid("duplicate option value");
          values.add(key);
        }
      } else if (field.options !== undefined) {
        invalid("options require a select field");
      }
      const validated = field as unknown as SettingsField;
      validateFieldValue(validated, validated.default);
      fields.set(validated.key, validated);
    }
    for (const field of fields.values()) {
      if (field.visibleWhen !== undefined) {
        const condition = record(field.visibleWhen, "visibility condition");
        only(condition, ["field", "equals"], "visibility condition");
        const dependency = fields.get(condition.field as string);
        if (!dependency || dependency.key === field.key) {
          invalid("visibility condition requires another declared field");
        }
        validateFieldValue(dependency, condition.equals);
      }
    }
    if (page.groups !== undefined) {
      if (!Array.isArray(page.groups)) invalid("groups must be an array");
      const ids = new Set<string>();
      const assigned = new Set<string>();
      for (const input of page.groups) {
        const group = record(input, "group");
        only(group, ["id", "label", "description", "fields"], "group");
        const id = stableId(group.id, "group id");
        if (ids.has(id)) invalid("duplicate group id");
        ids.add(id);
        text(group.label, "group label");
        optionalText(group, "description");
        for (const key of uniqueStrings(group.fields, "group fields")) {
          if (!fields.has(key) || assigned.has(key)) {
            invalid("group fields must be declared and assigned once");
          }
          assigned.add(key);
        }
      }
    }
    // Return detached JSON, never the caller's mutable descriptor objects.
    pages.push(jsonValues(page) as unknown as SettingsPage);
  }
  return pages;
}

/** Source-owned definition comparison shared by persistence and preparation.
 * A page read/write binds only its requested pages; activation binds the whole
 * declaration. The expected definitions are captured before any storage wait. */
export function assertSettingsSchemaCurrent(
  expected: SettingsPage[],
  current: SettingsPage[],
  complete = false,
): void {
  const selected = complete
    ? current
    : expected.map((page) =>
      current.find((candidate) => candidate.id === page.id)
    );
  if (JSON.stringify(expected) !== JSON.stringify(selected)) {
    throw new PluginContractError(
      409,
      "plugin_settings_schema_conflict",
      "plugin settings definition changed; review the current schema before retrying",
    );
  }
}

/** Project valid persisted JSON onto the current schema without changing its
 * raw orphan fields. Declared values still use the strict validator/defaults. */
export function projectPageValues(
  page: SettingsPage,
  saved: unknown = {},
): JsonValues {
  const values = jsonValues(saved);
  return effectivePageValues(
    page,
    Object.fromEntries(
      page.fields.filter((field) => Object.hasOwn(values, field.key)).map((
        field,
      ) => [field.key, values[field.key]]),
    ),
  );
}

/** Strict incoming control envelope: undeclared fields are never writable. */
export function effectivePageValues(
  page: SettingsPage,
  saved: unknown = {},
): JsonValues {
  const values = jsonValues(saved);
  const declared = new Set(page.fields.map((f) => f.key));
  if (Object.keys(values).some((key) => !declared.has(key))) {
    invalid("saved settings do not match the declared page schema");
  }
  return Object.fromEntries(page.fields.map((field) => [
    field.key,
    validateFieldValue(
      field,
      Object.hasOwn(values, field.key) ? values[field.key] : field.default,
    ),
  ]));
}
