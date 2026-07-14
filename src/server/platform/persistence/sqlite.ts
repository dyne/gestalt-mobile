import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openRelayDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return database;
}
