import path from 'node:path';

import type { ComponentToRouteResult, RouteMatch } from './types.js';

export interface FormatHumanOptions {
  cwd?: string;
}

export function formatHuman(
  result: ComponentToRouteResult,
  options?: FormatHumanOptions,
): string {
  const base = options?.cwd ?? process.cwd();
  const rel = (p: string) => path.relative(base, p) || '.';
  const relNote = (note: string) => note.replace(/\/\S+/g, (m) => (path.isAbsolute(m) ? rel(m) : m));

  const lines: string[] = [];

  lines.push('# component-to-route');
  lines.push('');

  const symbol = result.exportName ?? result.targetSymbols[0]?.name ?? 'component';
  lines.push(`> ${symbol} from \`${rel(result.componentPath)}\``);
  lines.push(
    `> ${result.routes.length} route${result.routes.length === 1 ? '' : 's'} found`,
  );

  for (const route of result.routes) {
    lines.push('');
    lines.push(formatRouteHeading(route, relNote));

    for (const frame of route.stack) {
      lines.push(`  -> ${rel(frame.filePath)}`);
    }
  }

  return lines.join('\n') + '\n';
}

function formatRouteHeading(
  route: RouteMatch,
  relNote: (note: string) => string,
): string {
  const parts: string[] = [route.confidence];

  if (route.qaReason === 'shared-layout') parts.push('shared layout');
  else if (route.qaReason === 'shared-template') parts.push('shared template');
  else if (route.qaReason === 'global-wrapper') parts.push('global wrapper');

  for (const note of route.notes) {
    const cleaned = relNote(note);
    if (!parts.includes(cleaned)) parts.push(cleaned);
  }

  return `## ${route.route} (${parts.join(', ')})`;
}

export function formatJson(result: ComponentToRouteResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}
