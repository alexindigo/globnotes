// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Minimal leveled logger, matching the Python server's format:
 *   YYYY-MM-DD HH:MM:SS [LEVEL]: message
 * Level from LOGLEVEL env (default INFO).
 */

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const LEVELS: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

const configured = (Deno.env.get("LOGLEVEL") ?? "INFO").toUpperCase() as Level;
const threshold = LEVELS[configured] ?? LEVELS.INFO;

function ts(): string {
  // Local time, matching the Python logger's %(asctime)s.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} [${level}]:`;
  if (level === "ERROR") console.error(line, ...args);
  else if (level === "WARNING") console.warn(line, ...args);
  else console.log(line, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => write("DEBUG", args),
  info: (...args: unknown[]) => write("INFO", args),
  warning: (...args: unknown[]) => write("WARNING", args),
  error: (...args: unknown[]) => write("ERROR", args),
};
