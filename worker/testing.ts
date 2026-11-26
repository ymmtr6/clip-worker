/// <reference types="vite/client" />
// @ts-nocheck node:sqlite の型は Workers の型定義と混ぜない
import { DatabaseSync } from "node:sqlite";

/**
 * テスト用の D1。本物の SQLite に migrations/ をそのまま流すので、
 * スキーマと SQL の食い違いもテストで見つかる。使うメソッドだけを実装している。
 */

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

type Value = string | number | null;

export function createTestD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const path of Object.keys(migrations).sort()) sqlite.exec(migrations[path]);

  class Statement {
    constructor(readonly sql: string, readonly args: Value[] = []) {}

    bind(...args: unknown[]) {
      return new Statement(this.sql, args.map((value) => (value === undefined ? null : value) as Value));
    }

    async first<T>() {
      return (sqlite.prepare(this.sql).get(...this.args) ?? null) as T | null;
    }

    async all<T>() {
      return { results: sqlite.prepare(this.sql).all(...this.args) as T[], success: true, meta: {} };
    }

    async run() {
      return this.runSync();
    }

    runSync() {
      const result = sqlite.prepare(this.sql).run(...this.args);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    // D1 の batch は1トランザクション。途中で失敗したら全体を戻す
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return db as unknown as D1Database;
}

export const testCtx = {
  waitUntil: (promise: Promise<unknown>) => { void promise; },
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** Wasabi の代わり。署名付き URL は形だけ返し、PUT はテストから putObject で行う */
export function createMemoryStorage() {
  const objects = new Map<string, { size: number; contentType: string }>();
  const storage = {
    objects,
    putObject(key: string, size: number, contentType: string) {
      objects.set(key, { size, contentType });
    },
    async presignGet(key: string) {
      return `https://s3.test/${key}?sig=get`;
    },
    async presignPut(key: string, contentType: string) {
      return `https://s3.test/${key}?sig=put&ct=${encodeURIComponent(contentType)}`;
    },
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async put(key: string, body: ReadableStream, length: number, contentType: string) {
      await new Response(body).arrayBuffer();
      objects.set(key, { size: length, contentType });
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return storage;
}
