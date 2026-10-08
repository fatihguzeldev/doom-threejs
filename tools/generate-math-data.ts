import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const revision = 'a77dfb96cb91780ca334d0d4cfd86957558007e0';
const localSource = process.argv[2];

async function source(name: string): Promise<string> {
  if (localSource) return readFile(join(localSource, 'linuxdoom-1.10', name), 'utf8');
  const response = await fetch(`https://raw.githubusercontent.com/id-Software/DOOM/${revision}/linuxdoom-1.10/${name}`);
  if (!response.ok) throw new Error(`Could not fetch ${name}: HTTP ${response.status}`);
  return response.text();
}

function values(text: string, name: string, length: number): number[] {
  const expression = new RegExp(`\\b${name}\\s*\\[[^\\]]+\\]\\s*=\\s*\\{([^}]+)\\}`);
  const body = expression.exec(text)?.[1];
  if (!body) throw new Error(`Original table ${name} not found`);
  const tokens = body.replace(/\s/g, '').split(',').filter(Boolean);
  if (tokens.length !== length || tokens.some(token => !/^-?\d+$/.test(token))) {
    throw new Error(`Original table ${name} is not the expected ${length} integers`);
  }
  return tokens.map(Number);
}

function declaration(name: string, kind: string, numbers: readonly number[]): string {
  const lines: string[] = [];
  for (let index = 0; index < numbers.length; index += 16) {
    lines.push(`  ${numbers.slice(index, index + 16).join(', ')},`);
  }
  return `export const ${name} = new ${kind}([\n${lines.join('\n')}\n]);\n`;
}

const [tables, random] = await Promise.all([source('tables.c'), source('m_random.c')]);
for (const [text, checksum] of [
  [tables, 'db8759f4311654c63785dcffb8f73a00a61cfe2713e4284c238dea420b6e5f89'],
  [random, '8d89f5cfcbbd0170e46b55538c4c272b3cf5b5d7dce91023b8aa8d9b922b21ee'],
] as const) {
  if (createHash('sha256').update(text).digest('hex') !== checksum) {
    throw new Error('Original source does not match the pinned revision');
  }
}
const output = [
  '// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.',
  `// Generated from id-Software/DOOM ${revision}.`,
  '// Regenerate with: node --experimental-strip-types tools/generate-math-data.ts',
  '// See ../../../LICENSE.',
  '',
  declaration('fineSine', 'Int32Array', values(tables, 'finesine', 10240)),
  declaration('fineTangent', 'Int32Array', values(tables, 'finetangent', 4096)),
  declaration('tangentToAngle', 'Uint32Array', values(tables, 'tantoangle', 2049)),
  declaration('randomBytes', 'Uint8Array', values(random, 'rndtable', 256)),
].join('\n');
const destination = new URL('../game/src/simulation/data/math.ts', import.meta.url);
await mkdir(new URL('.', destination), { recursive: true });
await writeFile(destination, output);
