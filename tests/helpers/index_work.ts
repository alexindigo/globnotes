// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import type { IndexerAdapters } from "../../server/search/fts5.ts";
import { fileAdapters } from "../../server/search/fts5.ts";

/** Observe actual I/O through the index owner's existing adapters. Counts SQL
 * results at the JS boundary, not SQLite's internal FTS maintenance writes. */
export function indexWork() {
  const reads: string[] = [];
  const statements: { sql: string; method: string; rows: number }[] = [];
  let outerTransactions = 0, depth = 0;
  const databases: DatabaseSync[] = [];
  const adapters: Partial<IndexerAdapters> = {
    readText(filepath) {
      reads.push(filepath);
      return fileAdapters.readText(filepath);
    },
    openDatabase(filepath) {
      const db = new DatabaseSync(filepath);
      databases.push(db);
      return new Proxy(db, {
        get(target, prop) {
          if (prop === "exec") {
            return (sql: string) => {
              target.exec(sql);
              if (/^SAVEPOINT /i.test(sql)) {
                if (depth++ === 0) outerTransactions++;
              } else if (/^RELEASE /i.test(sql)) depth--;
              statements.push({ sql, method: "exec", rows: 0 });
            };
          }
          if (prop === "prepare") {
            return (sql: string) =>
              new Proxy(target.prepare(sql), {
                get(statement, method) {
                  const value = Reflect.get(statement, method, statement);
                  if (["all", "get", "run"].includes(String(method))) {
                    return (...args: never[]) => {
                      const result = value.apply(statement, args);
                      const rows = method === "all"
                        ? result.length
                        : method === "get"
                        ? Number(result !== undefined)
                        : Number(result.changes);
                      statements.push({ sql, method: String(method), rows });
                      return result;
                    };
                  }
                  return typeof value === "function"
                    ? value.bind(statement)
                    : value;
                },
              });
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return {
    adapters,
    reads,
    statements,
    get outerTransactions() {
      return outerTransactions;
    },
    reset() {
      reads.length = 0;
      statements.length = 0;
      outerTransactions = 0;
    },
    close() {
      for (const db of databases) db.close();
    },
  };
}
