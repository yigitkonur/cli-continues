#!/usr/bin/env node

import { existsSync } from 'node:fs';

const compiledCli = new URL('../dist/cli.js', import.meta.url);

if (existsSync(compiledCli)) {
  await import(compiledCli.href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/cli.ts');
}
