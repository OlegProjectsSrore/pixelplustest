import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** Executes the actual application SQL on SQLite. Only the transport-shaped D1 wrapper is adapted. */
export class SqliteD1 {
  sqlite: DatabaseSync;
  beforeBatch: (() => void) | null = null;
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    const migrations = new URL('../../migrations/', import.meta.url);
    for (const filename of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(new URL(filename, migrations), 'utf8'));
    }
  }
  prepare(query: string): SqliteStatement { return new SqliteStatement(this, query, []); }
  async batch(statements: SqliteStatement[]): Promise<D1Result[]> {
    this.beforeBatch?.();
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.sqlite.close(); }
  binding(): D1Database { return this as unknown as D1Database; }
}
class SqliteStatement {
  owner: SqliteD1; query: string; values: unknown[];
  constructor(owner: SqliteD1, query: string, values: unknown[]) { this.owner = owner; this.query = query; this.values = values; }
  bind(...values: unknown[]): SqliteStatement { return new SqliteStatement(this.owner, this.query, values); }
  execute(): D1Result {
    const stmt = this.owner.sqlite.prepare(this.query);
    const results = stmt.all(...this.values as never[]);
    const changes = this.owner.sqlite.prepare('SELECT changes() count').get()!.count;
    return { success: true, results, meta: { changes: Number(changes) } } as D1Result;
  }
  async run(): Promise<D1Result> { return this.execute(); }
  async all(): Promise<D1Result> { return this.execute(); }
  async first(column?: string): Promise<unknown> { const row = this.execute().results[0] ?? null; return column && row ? (row as Record<string, unknown>)[column] : row; }
}
