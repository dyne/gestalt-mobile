/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { AuthStatementCache, withImmediateTransaction } from './sqlite.js';

function observed(database: DatabaseSync) {
  const commands: string[] = [];
  return {
    commands,
    db: {
      exec(sql: string) {
        commands.push(sql);
        database.exec(sql);
      },
      get isTransaction() {
        return database.isTransaction;
      },
    },
  };
}

describe('withImmediateTransaction', () => {
  it('commits returned results, including early-return outcomes', () => {
    const database = new DatabaseSync(':memory:');
    const { commands, db } = observed(database);

    expect(withImmediateTransaction(db, () => 'result')).toBe('result');
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
    expect(database.isTransaction).toBe(false);
    database.close();
  });

  it('preserves BEGIN IMMEDIATE contention behavior', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gestalt-auth-transaction-'));
    const path = join(directory, 'auth.sqlite');
    const holder = new DatabaseSync(path);
    const contender = new DatabaseSync(path);
    try {
      contender.exec('PRAGMA busy_timeout = 0');
      holder.exec('BEGIN IMMEDIATE');
      const { commands, db } = observed(contender);

      expect(() => withImmediateTransaction(db, () => undefined)).toThrow('database is locked');
      expect(commands).toEqual(['BEGIN IMMEDIATE']);
      expect(holder.isTransaction).toBe(true);
      expect(contender.isTransaction).toBe(false);
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK');
      holder.close();
      contender.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('rolls back and propagates the original error', () => {
    const database = new DatabaseSync(':memory:');
    const { commands, db } = observed(database);
    const original = new Error('original');

    expect(() =>
      withImmediateTransaction(db, () => {
        throw original;
      }),
    ).toThrow(original);
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
    expect(database.isTransaction).toBe(false);
    database.close();
  });

  it('does not roll back again after SQLite has rolled back the transaction', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE unique_values (value TEXT UNIQUE ON CONFLICT ROLLBACK)');
    database.prepare('INSERT INTO unique_values VALUES (?)').run('existing');
    const { commands, db } = observed(database);
    let original: unknown;

    try {
      withImmediateTransaction(db, () => {
        try {
          database.prepare('INSERT INTO unique_values VALUES (?)').run('existing');
        } catch (error) {
          original = error;
          throw error;
        }
      });
    } catch (error) {
      expect(error).toBe(original);
    }

    expect(original).toBeInstanceOf(Error);
    expect(commands).toEqual(['BEGIN IMMEDIATE']);
    expect(database.isTransaction).toBe(false);
    database.close();
  });
});

describe('AuthStatementCache', () => {
  it('prepares a repeated static statement only once', () => {
    const database = new DatabaseSync(':memory:');
    const prepare = vi.spyOn(database, 'prepare');
    const statements = new AuthStatementCache(database, 2);

    expect(statements.prepare('SELECT 1')).toBe(statements.prepare('SELECT 1'));
    expect(prepare).toHaveBeenCalledOnce();
    database.close();
  });
});
