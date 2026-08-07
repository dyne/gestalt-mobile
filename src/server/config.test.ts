/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliUsageError, normalizePublicOrigin, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('uses safe production defaults', () => {
    expect(parseConfig([], '/caller')).toEqual({
      host: '127.0.0.1',
      port: 3000,
      passkeyAuthEnabled: true,
      relyingParty: {
        publicOrigin: 'http://localhost:3000',
        rpId: 'localhost',
        rpName: 'Gestalt Mobile',
      },
      root: resolve('/caller'),
      dataDir: undefined,
    });
  });

  it('parses every supported option and resolves a relative workspace from the caller', () => {
    expect(
      parseConfig(
        [
          '--cwd',
          '../work',
          '--host',
          '0.0.0.0',
          '--port',
          '4242',
          '--public-origin',
          'https://gestalt.example:8443',
          '--data-dir',
          './state',
        ],
        '/caller/subdirectory',
      ),
    ).toEqual({
      host: '0.0.0.0',
      port: 4242,
      passkeyAuthEnabled: true,
      relyingParty: {
        publicOrigin: 'https://gestalt.example:8443',
        rpId: 'gestalt.example',
        rpName: 'Gestalt Mobile',
      },
      root: resolve('/caller/work'),
      dataDir: './state',
    });
  });

  it('uses localhost as the browser origin for every loopback listen address', () => {
    expect(parseConfig(['--host', 'localhost', '--port', '4242'], '/caller')).toMatchObject({
      relyingParty: { publicOrigin: 'http://localhost:4242', rpId: 'localhost' },
    });
    expect(parseConfig(['--host', '::1'], '/caller').relyingParty.publicOrigin).toBe(
      'http://localhost:3000',
    );
  });

  it('requires an explicit canonical origin for non-loopback listeners', () => {
    expect(() => parseConfig(['--host', '0.0.0.0'], '/caller')).toThrow(
      new CliUsageError('--public-origin is required when --host is not a loopback address'),
    );
  });

  it('allows an unprotected non-loopback listener only with the explicit opt-out flag', () => {
    expect(parseConfig(['--host', '0.0.0.0', '--disable-passkey-auth'], '/caller')).toMatchObject({
      host: '0.0.0.0',
      passkeyAuthEnabled: false,
      relyingParty: { publicOrigin: 'http://localhost:3000' },
    });
  });

  it('preserves an absolute workspace path', () => {
    expect(parseConfig(['--cwd', '/workspace'], '/caller').root).toBe(resolve('/workspace'));
  });

  it.each([
    [['--unknown', 'value'], 'Unknown option: --unknown'],
    [['--host'], 'Missing value for --host'],
    [['--host', '--port', '4000'], 'Missing value for --host'],
    [['--port', '0'], 'Invalid --port: 0'],
    [['--port', '65536'], 'Invalid --port: 65536'],
    [['--port', '3.5'], 'Invalid --port: 3.5'],
    [['workspace'], 'Unexpected argument: workspace'],
    [['--cwd', '.', '--cwd', '..'], 'Duplicate option: --cwd'],
    [
      ['--disable-passkey-auth', '--disable-passkey-auth'],
      'Duplicate option: --disable-passkey-auth',
    ],
  ])('rejects invalid arguments %#', (args, message) => {
    expect(() => parseConfig(args, '/caller')).toThrow(new CliUsageError(message));
  });
});

describe('normalizePublicOrigin', () => {
  it.each([
    ['http://localhost', 'http://localhost'],
    ['http://localhost:4173', 'http://localhost:4173'],
    ['https://GESTALT.example:8443', 'https://gestalt.example:8443'],
    ['https://gestalt.example:443', 'https://gestalt.example'],
  ])('normalizes supported origins', (value, expected) => {
    expect(normalizePublicOrigin(value)).toBe(expected);
  });

  it.each([
    ['https://user@gestalt.example', 'credentials'],
    ['https://gestalt.example/auth', 'bare origin'],
    ['https://gestalt.example/?next=1', 'bare origin'],
    ['https://gestalt.example/#login', 'bare origin'],
    ['https://gestalt.example?', 'bare origin'],
    ['https://gestalt.example#', 'bare origin'],
    ['https://gestalt.example/.', 'bare origin'],
    ['https://gestalt.example/section/..', 'bare origin'],
    ['https://gestalt.example ', 'bare origin'],
    ['https://gestalt.example\\', 'bare origin'],
    ['http://gestalt.example', 'must use HTTPS'],
    ['http://127.0.0.1:3000', 'must use a hostname'],
    ['https://192.0.2.1', 'must use a hostname'],
    ['not an origin', 'bare origin'],
  ])('rejects insecure or non-origin input', (value, message) => {
    expect(() => normalizePublicOrigin(value)).toThrow(message);
  });
});

describe('--skills', () => {
  it('parses an explicit profile', () => {
    expect(parseConfig(['--skills', 'focused'], '/caller').skillsProfile).toBe('focused');
  });

  it('rejects missing, empty, and duplicate forms', () => {
    for (const args of [['--skills'], ['--skills', ''], ['--skills', 'one', '--skills', 'two']])
      expect(() => parseConfig(args, '/caller')).toThrow(CliUsageError);
  });
});
