#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, '..', 'src', 'cli.ts');
const tsxLoader = path.join(here, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const result = spawnSync(
  process.execPath,
  ['--import', tsxLoader, cliEntry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPONENT_TO_ROUTE_INVOKE_CWD:
        process.env.COMPONENT_TO_ROUTE_INVOKE_CWD ?? process.env.PWD ?? process.cwd(),
    },
  },
);

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
