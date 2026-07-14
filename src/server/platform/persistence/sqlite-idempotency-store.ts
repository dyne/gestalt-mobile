import type { DatabaseSync } from 'node:sqlite';

export class SqliteIdempotencyStore {
  constructor(private readonly db: DatabaseSync) {}
  get(scope: string, key: string): { statusCode: number; body: string } | null {
    const row = this.db
      .prepare('SELECT status_code, body_json FROM idempotency_results WHERE scope = ? AND key = ?')
      .get(scope, key) as { status_code: number; body_json: string } | undefined;
    return row ? { statusCode: row.status_code, body: row.body_json } : null;
  }
  put(scope: string, key: string, statusCode: number, body: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO idempotency_results (scope,key,status_code,body_json) VALUES (?,?,?,?)',
      )
      .run(scope, key, statusCode, body);
  }
}
