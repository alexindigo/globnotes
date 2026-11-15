// SPDX-License-Identifier: LGPL-3.0-only
/** Generation-local declarations and state only. The host owns execution. */
import { type HandlerRegistration, record, stableId } from "./contracts.ts";

export interface ServiceJobStatus {
  id: string;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  code?: "plugin_job_failed" | "plugin_job_deadline";
}
export function jobDeclaration(value: unknown): { id: string } {
  const raw = record(value, "post-activation job");
  if (Object.keys(raw).some((key) => key !== "id")) {
    throw new Error("unsupported job option");
  }
  return { id: stableId(raw.id, "job id") };
}
export function jobDependencies(value: unknown): string[] {
  const raw = record(value, "versioning options");
  if (Object.keys(raw).some((key) => key !== "after")) {
    throw new Error("unsupported versioning option");
  }
  if (raw.after === undefined) return [];
  if (!Array.isArray(raw.after)) {
    throw new Error("after must be a list of job IDs");
  }
  const ids = raw.after.map((id) => stableId(id, "job dependency"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("duplicate job dependency");
  }
  return ids;
}
export function registrationDependencies(
  registration: HandlerRegistration,
): string[] {
  return jobDependencies(
    registration.definition === undefined ? {} : registration.definition,
  );
}
export class ServiceJobs {
  private declarations = new Map<string, string>();
  private dependencies = new Map<string, string[]>();
  private records = new Map<string, ServiceJobStatus>();
  private admitted = false;
  constructor(private readonly changed: () => void) {}
  seal(registry: ReadonlyMap<string, HandlerRegistration>): void {
    const declarations = new Map<string, string>();
    const dependencies = new Map<string, string[]>();
    for (const [handler, registration] of registry) {
      if (registration.kind !== "job") continue;
      const { id } = jobDeclaration(registration.definition);
      if (id !== registration.id || declarations.has(id)) {
        throw new Error("duplicate or invalid job identity");
      }
      declarations.set(id, handler);
    }
    for (const [handler, registration] of registry) {
      if (registration.kind !== "versioning") continue;
      const after = registrationDependencies(registration);
      for (const id of after) {
        if (!declarations.has(id)) throw new Error("unknown job dependency");
      }
      dependencies.set(handler, after);
    }
    this.declarations = declarations;
    this.dependencies = dependencies;
  }
  admit(): readonly [string, string][] {
    if (this.admitted) throw new Error("service jobs already admitted");
    this.admitted = true;
    for (const id of this.declarations.keys()) {
      this.records.set(id, { id, state: "pending" });
    }
    this.changed();
    return [...this.declarations];
  }
  get snapshot(): ServiceJobStatus[] {
    return structuredClone([...this.records.values()]);
  }
  eligible(handler: string): boolean {
    return (this.dependencies.get(handler) ?? []).every((id) => {
      const state = this.records.get(id)?.state;
      return state === "succeeded" || state === "failed";
    });
  }
  required(id: string): boolean {
    return [...this.dependencies.values()].some((after) => after.includes(id));
  }
  transition(
    id: string,
    state: ServiceJobStatus["state"],
    code?: ServiceJobStatus["code"],
  ): void {
    const previous = this.records.get(id);
    if (!previous || !["pending", "running"].includes(previous.state)) return;
    this.records.set(id, { id, state, ...(code ? { code } : {}) });
    this.changed();
  }
  remove(id: string): void {
    this.declarations.delete(id);
    this.transition(id, "cancelled");
  }
  cancel(): void {
    for (const id of this.records.keys()) this.transition(id, "cancelled");
  }
}
