#!/usr/bin/env node

import { runCli } from './cli.js';

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Gestalt Mobile startup failed');
  process.exitCode = 1;
}
