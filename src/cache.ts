import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CachedAnalysis } from './types.js';

const CACHE_VERSION = 1;

export async function readCachedAnalysis(
  cacheDir: string,
  cacheKey: string,
): Promise<CachedAnalysis | null> {
  const cacheFile = getCacheFile(cacheDir, cacheKey);

  try {
    const raw = await readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as CachedAnalysis;
    if (parsed.cacheVersion !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCachedAnalysis(
  cacheDir: string,
  cacheKey: string,
  analysis: Omit<CachedAnalysis, 'cacheVersion'>,
): Promise<void> {
  const cacheFile = getCacheFile(cacheDir, cacheKey);
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(
    cacheFile,
    JSON.stringify(
      {
        cacheVersion: CACHE_VERSION,
        ...analysis,
      },
      null,
      2,
    ),
  );
}

function getCacheFile(cacheDir: string, cacheKey: string): string {
  return path.join(cacheDir, `${cacheKey}.json`);
}
