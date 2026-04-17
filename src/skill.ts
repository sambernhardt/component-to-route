import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const SKILL_NAME = 'component-to-route';

const TARGETS = [
  { name: 'Cursor', dir: () => path.join(os.homedir(), '.agents', 'skills', SKILL_NAME) },
  { name: 'Claude', dir: () => path.join(os.homedir(), '.claude', 'skills', SKILL_NAME) },
];

function getSkillSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'skill');
}

export async function installSkill(): Promise<void> {
  const source = getSkillSource();

  if (!existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error(`Skill source not found at ${source}/SKILL.md`);
  }

  for (const target of TARGETS) {
    const dir = target.dir();
    await mkdir(path.dirname(dir), { recursive: true });
    await cp(source, dir, { recursive: true });
    process.stdout.write(`${target.name}: installed to ${dir}\n`);
  }
}

export async function uninstallSkill(): Promise<void> {
  for (const target of TARGETS) {
    const dir = target.dir();
    if (existsSync(dir)) {
      await rm(dir, { recursive: true });
      process.stdout.write(`${target.name}: removed ${dir}\n`);
    } else {
      process.stdout.write(`${target.name}: not installed\n`);
    }
  }
}
