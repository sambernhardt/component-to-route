#!/usr/bin/env node

import path from 'node:path';

import { analyzeComponentRoutes } from './analyze.js';
import { formatHuman, formatJson } from './format.js';

async function main(): Promise<void> {
  const invokedCwd =
    process.env.COMPONENT_TO_ROUTE_INVOKE_CWD ?? process.env.PWD ?? process.cwd();
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first || first === '--help' || first === '-h') {
    printHelp();
    return;
  }

  const componentPath = first;
  const restArgs = args.slice(1);

  if (!componentPath || componentPath.startsWith('-')) {
    throw new Error(
      'Missing component path. Usage: component-to-route <component-path> [--dir <app-root>] [--export <name>]',
    );
  }

  const options = parseOptions(restArgs);

  const cacheDir = options.cacheDir
    ? path.resolve(invokedCwd, options.cacheDir)
    : path.resolve(invokedCwd, '.cache', 'component-to-route');

  const result = await analyzeComponentRoutes({
    workspaceRoot: invokedCwd,
    appRoot: path.resolve(invokedCwd, options.appRoot ?? '.'),
    componentPath: path.resolve(invokedCwd, componentPath),
    exportName: options.exportName ?? undefined,
    useCache: options.cache,
    useBuildArtifacts: options.buildArtifacts,
    followDynamicImports: options.dynamicImports,
    cacheDir,
  });

  process.stdout.write(
    options.json ? formatJson(result) : formatHuman(result, { cwd: invokedCwd }),
  );
}

function parseOptions(args: string[]): {
  appRoot: string | null;
  exportName: string | null;
  json: boolean;
  cache: boolean;
  cacheDir: string | null;
  buildArtifacts: boolean;
  dynamicImports: boolean;
} {
  let appRoot: string | null = null;
  let exportName: string | null = null;
  let json = false;
  let cache = true;
  let cacheDir: string | null = null;
  let buildArtifacts = true;
  let dynamicImports = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dir') {
      appRoot = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--export') {
      exportName = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--no-cache') {
      cache = false;
      continue;
    }

    if (arg === '--cache-dir') {
      cacheDir = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--no-build-artifacts') {
      buildArtifacts = false;
      continue;
    }

    if (arg === '--dynamic-imports') {
      dynamicImports = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    appRoot,
    exportName,
    json,
    cache,
    cacheDir,
    buildArtifacts,
    dynamicImports,
  };
}

function printHelp(): void {
  const text = `
component-to-route

Usage:
  component-to-route <component-path> [options]
  component-to-route skill install|uninstall

Options:
  --dir <path>           Directory of the Next.js app to search (defaults to cwd)
  --export <name>        Target a specific exported component, e.g. Button
  --json                 Print machine-readable JSON output
  --no-cache             Disable the local analysis cache
  --cache-dir <path>     Override the cache directory
  --no-build-artifacts   Skip .next manifest enrichment
  --dynamic-imports      Follow next/dynamic and React.lazy imports (slower)
  -h, --help             Show this help

Examples:
  component-to-route src/components/button.tsx
  component-to-route packages/design-system/src/components/button/button.tsx --dir apps/web
  component-to-route src/components/button.tsx --export Button
`;

  process.stdout.write(text.trimStart());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
