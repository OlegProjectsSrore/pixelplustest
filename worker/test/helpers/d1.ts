import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
export const migrationFiles = (): string[] => readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort();

/** Executes the actual application SQL on SQLite. Only the transport-shaped D1 wrapper is adapted. */
export class SqliteD1 {
  sqlite: DatabaseSync;
  beforeBatch: (() => void) | null = null;
  /** before: apply only migrations whose file names sort before it, so a test can add data and then run migrate(). */
  constructor(options: { before?: string } = {}) {
    this.sqlite = new DatabaseSync(':memory:');
    for (const filename of migrationFiles()) if (!options.before || filename < options.before) this.migrate(filename);
  }
  migrate(filename: string): void { this.sqlite.exec(readFileSync(new URL(filename, MIGRATIONS), 'utf8')); }
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
