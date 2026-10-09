/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

it('discovers the server project and resolves callers without opening them first', () => {
  const definition = resolve(root, 'src/server/app.ts');
  const caller = resolve(root, 'src/server/composition.ts');
  const configPath = ts.findConfigFile(dirname(definition), ts.sys.fileExists);
  expect(configPath).toBeDefined();
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath!,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  expect(config?.errors).toEqual([]);
  expect(config?.fileNames).toContain(definition);
  expect(config?.fileNames).toContain(caller);

  const service = ts.createLanguageService({
    ...ts.sys,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCompilationSettings: () => config!.options,
    getScriptFileNames: () => config!.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (path) => {
      const source = ts.sys.readFile(path);
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
  });
  try {
    const source = ts.sys.readFile(definition)!;
    const position = source.indexOf('buildApp(');
    expect(position).toBeGreaterThan(-1);
    const references = service.findReferences(definition, position);
    const callerSource = ts.sys.readFile(caller)!;
    const callPosition = callerSource.indexOf('buildApp({');
    expect(callPosition).toBeGreaterThan(-1);
    expect(
      references
        ?.flatMap((symbol) => symbol.references)
        .some(
          (reference) => reference.fileName === caller && reference.textSpan.start === callPosition,
        ),
    ).toBe(true);
  } finally {
    service.dispose();
  }
}, 15_000);
