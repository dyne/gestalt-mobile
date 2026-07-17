import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliUsageError, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('uses safe production defaults', () => {
    expect(parseConfig([], '/caller')).toEqual({
      host: '127.0.0.1',
      port: 3000,
      root: resolve('/caller'),
      dataDir: undefined,
    });
  });

  it('parses every supported option and resolves a relative workspace from the caller', () => {
    expect(
      parseConfig(
        ['--cwd', '../work', '--host', '0.0.0.0', '--port', '4242', '--data-dir', './state'],
        '/caller/subdirectory',
      ),
    ).toEqual({
      host: '0.0.0.0',
      port: 4242,
      root: resolve('/caller/work'),
      dataDir: './state',
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
  ])('rejects invalid arguments %#', (args, message) => {
    expect(() => parseConfig(args, '/caller')).toThrow(new CliUsageError(message));
  });
});
