// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Minimal leveled logger, matching the Python server's format:
 *   YYYY-MM-DD HH:MM:SS [LEVEL]: message
 * The composition root initializes a validated level after configuration resolution.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";
type Level = LogLevel;

const LEVELS: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

let threshold: number | undefined;
export const isLogLevel = (value: string): value is LogLevel =>
  Object.hasOwn(LEVELS, value);
export function initializeLogger(level: string): void {
  if (!isLogLevel(level)) throw new Error("Invalid log level");
  threshold = LEVELS[level];
}

function ts(): string {
  // Local time, matching the Python logger's %(asctime)s.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level: Level, args: unknown[]): void {
  // Configuration tools may own stdout before logging has been initialized.
  // Preserve their diagnostics without inventing a level or contaminating data.
  if (threshold === undefined) {
    console.error(...args);
    return;
  }
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
