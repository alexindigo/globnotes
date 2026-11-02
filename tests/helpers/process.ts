// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The one launcher for child processes started by server tests.
 *
 * `deno test --parallel` runs test modules as concurrent workers of one OS
 * process; a child that inherited that process's environment would receive
 * whatever another module is configuring at the moment. Every child therefore
 * starts with `clearEnv: true` and an explicit environment: the base below
 * (what a child process needs to run at all) plus exactly the caller's
 * variables. tests/test_isolation_contract_test.ts keeps `new Deno.Command(`
 * inside this file.
 */

/** Variables a child needs to run (tools, caches, scratch space, locale).
 * Copied from the test process only when set; never any GLOBNOTES_*. */
const BASE_KEYS = [
  "PATH",
  "HOME",
  "DENO_DIR",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
];

export const DENO = Deno.execPath();

/** The complete environment a child receives. */
export function childEnvironment(
  env: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = { NO_COLOR: "1" };
  for (const key of BASE_KEYS) {
    const value = Deno.env.get(key);
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...env };
}

export type ChildOptions = Omit<Deno.CommandOptions, "clearEnv" | "env"> & {
  env?: Record<string, string>;
};

/** A `Deno.Command` with a clean, explicit environment. */
export function command(
  program: string | URL,
  options: ChildOptions = {},
): Deno.Command {
  return new Deno.Command(program, {
    ...options,
    clearEnv: true,
    env: childEnvironment(options.env),
  });
}
