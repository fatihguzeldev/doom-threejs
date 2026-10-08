import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_SHA = 'a77dfb96cb91780ca334d0d4cfd86957558007e0';
const SOURCE_URL = `https://raw.githubusercontent.com/id-Software/DOOM/${SOURCE_SHA}/linuxdoom-1.10`;
const SOURCE_HASHES = {
  'info.c': 'e09631527669ee528bdae20a47be79e1cb33972b39964c33ac4814e1701a0949',
  'info.h': '3e68ee6cc13323e69cbcf208e9a0af7b13867bead49e66d765abefa5d914b0dd',
  'd_items.c': '76531d5366de1157cf3d8510ef749617cfc46b6e721845bda4324cd697028fe6',
  'd_items.h': '322a73acb345703c9f00ae7528900daa3a49bd27c670d5acee4196c1ded74bda',
  'doomdef.h': '643daca966fb762fa86f39ce9a1779355117578527bf2e295163647f9ad0d74e',
  'sounds.h': 'fa5a6c19c689eeb6e4a2df08b1d4efe5c445b3d0cb4081dc3a7d28fdadfd39f8',
  'p_mobj.h': '85be6ea83fc4b5f95df666c68c8999f7fe5745a5f503d3a441afd66b5f7e5db0',
  'm_fixed.h': '67aa3925a905d448fb947fb7358093a39367f534c3e26e3f8b06228f553227ef',
} as const;
type SourceFile = keyof typeof SOURCE_HASHES;
interface EnumEntry { readonly name: string; readonly value: number }

const stateFields = ['sprite', 'frame', 'tics', 'action', 'nextstate', 'misc1', 'misc2'] as const;
const actorFields = [
  'doomednum', 'spawnstate', 'spawnhealth', 'seestate', 'seesound', 'reactiontime',
  'attacksound', 'painstate', 'painchance', 'painsound', 'meleestate', 'missilestate',
  'deathstate', 'xdeathstate', 'deathsound', 'speed', 'radius', 'height', 'mass',
  'damage', 'activesound', 'flags', 'raisestate',
] as const;
const weaponFields = ['ammo', 'upstate', 'downstate', 'readystate', 'atkstate', 'flashstate'] as const;
const actorStates = new Set(['spawnstate', 'seestate', 'painstate', 'meleestate',
  'missilestate', 'deathstate', 'xdeathstate', 'raisestate']);
const actorSounds = new Set(['seesound', 'attacksound', 'painsound', 'deathsound', 'activesound']);

function requireValue<T>(value: T | undefined, context: string): T {
  if (value === undefined) throw new Error(`Missing ${context}`);
  return value;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function splitFields(source: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '{' || character === '(') depth++;
    if (character === '}' || character === ')') depth--;
    if (depth < 0) throw new Error('Unbalanced C initializer');
    if (character === ',' && depth === 0) {
      fields.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) throw new Error('Unbalanced C initializer');
  fields.push(source.slice(start).trim());
  return fields.filter(field => field.length !== 0);
}

// This parses the small constant-expression subset present in the pinned tables.
// Unknown identifiers, tokens and non-integer arithmetic are rejected, never executed.
function constant(expression: string, symbols: ReadonlyMap<string, number>): number {
  const tokens: string[] = [];
  const lexer = /\s*(0x[\da-f]+|\d+|[a-z_]\w*|<<|>>|[()+\-*/|&^~])\s*/giy;
  let offset = 0;
  while (offset < expression.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(expression);
    if (!match) throw new Error(`Unsupported C constant: ${expression}`);
    tokens.push(requireValue(match[1], 'constant token'));
    offset = lexer.lastIndex;
  }
  const precedence = new Map([['|', 1], ['^', 2], ['&', 3], ['<<', 4], ['>>', 4],
    ['+', 5], ['-', 5], ['*', 6], ['/', 6]]);
  let cursor = 0;
  function integer(value: number): number {
    if (!Number.isSafeInteger(value)) throw new Error(`Inexact C constant: ${expression}`);
    return value;
  }
  function atom(): number {
    const token = requireValue(tokens[cursor++], 'constant operand');
    if (token === '+' || token === '-' || token === '~') {
      const value = atom();
      return integer(token === '-' ? -value : token === '~' ? ~value : value);
    }
    if (token === '(') {
      const value = binary(0);
      if (tokens[cursor++] !== ')') throw new Error(`Unclosed C constant: ${expression}`);
      return value;
    }
    if (/^(?:0x[\da-f]+|\d+)$/i.test(token)) return integer(Number(token));
    return requireValue(symbols.get(token), `C identifier ${token}`);
  }
  function binary(minimum: number): number {
    let left = atom();
    while (cursor < tokens.length) {
      const operator = requireValue(tokens[cursor], 'constant operator');
      const priority = precedence.get(operator);
      if (priority === undefined || priority < minimum) break;
      cursor++;
      const right = binary(priority + 1);
      switch (operator) {
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/':
          if (right === 0) throw new Error('Division by zero in C constant');
          left = Math.trunc(left / right);
          break;
        case '|': left |= right; break;
        case '&': left &= right; break;
        case '^': left ^= right; break;
        case '<<':
        case '>>':
          if (right < 0 || right > 31) throw new Error('Invalid C shift count');
          left = operator === '<<' ? left << right : left >> right;
          break;
        default: throw new Error(`Unsupported C operator ${operator}`);
      }
      integer(left);
    }
    return left;
  }
  const value = binary(0);
  if (cursor !== tokens.length) throw new Error(`Unparsed C constant: ${expression}`);
  return integer(value);
}

function enumeration(source: string, name: string, symbols: Map<string, number>): EnumEntry[] {
  const match = source.match(new RegExp(`typedef\\s+enum\\s*\\{([^{}]*)\\}\\s*${name}\\s*;`));
  const body = requireValue(match?.[1], `C enum ${name}`);
  let next = 0;
  return splitFields(body).map(field => {
    const entry = /^([a-z_]\w*)(?:\s*=\s*(.+))?$/i.exec(field);
    if (!entry) throw new Error(`Unsupported C enum entry ${field}`);
    const identifier = requireValue(entry[1], 'enum identifier');
    const value = entry[2] === undefined ? next : constant(entry[2], symbols);
    if (symbols.has(identifier)) throw new Error(`Duplicate C identifier ${identifier}`);
    symbols.set(identifier, value);
    next = value + 1;
    return { name: identifier, value };
  });
}

function structure(source: string, name: string, expected: readonly string[]): void {
  const match = source.match(new RegExp(`typedef\\s+struct\\s*\\{([^{}]*)\\}\\s*${name}\\s*;`));
  const body = requireValue(match?.[1], `C struct ${name}`);
  const fields = body.split(';').filter(field => field.trim()).flatMap(field => {
    const declaration = /^\s*\w+\s+(.+?)\s*$/s.exec(field);
    return splitFields(requireValue(declaration?.[1], `C declaration ${field}`));
  });
  if (fields.join(',') !== expected.join(',')) throw new Error(`Unexpected ${name} layout`);
}

function initializer(source: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{`).exec(source);
  if (!match) throw new Error(`Missing C array ${name}`);
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index);
  }
  throw new Error(`Unclosed C array ${name}`);
}

function records(source: string, name: string, fields: readonly string[], symbols: ReadonlyMap<string, number>): number[][] {
  return splitFields(initializer(source, name)).map((record, index) => {
    if (!record.startsWith('{') || !record.endsWith('}')) throw new Error(`Invalid ${name}[${index}]`);
    const values = splitFields(record.slice(1, -1));
    if (values.length !== fields.length) throw new Error(`Unexpected ${name}[${index}] field count`);
    return values.map(value => {
      const result = constant(value.startsWith('{') ? value.slice(1, -1).trim() : value, symbols);
      if (result < -2147483648 || result > 2147483647) throw new Error(`Out-of-range ${name} integer`);
      return result;
    });
  });
}

function enumCode(name: string, entries: readonly EnumEntry[]): string {
  return `export enum ${name} {\n${entries.map(entry => `  ${entry.name} = ${entry.value},`).join('\n')}\n}\n`;
}

function reference(name: string, entries: readonly EnumEntry[], value: number): string {
  const entry = entries.find(entry => entry.value === value);
  return `${name}.${requireValue(entry, `${name} reference ${value}`).name}`;
}

async function loadSource(localPath: string | undefined): Promise<Record<SourceFile, string>> {
  let directory: string | undefined;
  if (localPath !== undefined) {
    directory = resolve(localPath);
    try { await access(join(directory, 'info.c')); }
    catch { directory = join(directory, 'linuxdoom-1.10'); }
  }
  const files = await Promise.all((Object.keys(SOURCE_HASHES) as SourceFile[]).map(async name => {
    let source: string;
    if (directory !== undefined) source = await readFile(join(directory, name), 'utf8');
    else {
      const response = await fetch(`${SOURCE_URL}/${name}`);
      if (!response.ok) throw new Error(`Source download failed: ${name} (${response.status})`);
      source = await response.text();
    }
    if (createHash('sha256').update(source).digest('hex') !== SOURCE_HASHES[name]) {
      throw new Error(`${name} does not match pinned original source ${SOURCE_SHA}`);
    }
    return [name, stripComments(source)] as const;
  }));
  return Object.fromEntries(files) as Record<SourceFile, string>;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const check = arguments_.includes('--check');
  const paths = arguments_.filter(argument => argument !== '--check');
  if (paths.length > 1) throw new Error('Usage: generate-doom-data.ts [original-source-directory] [--check]');
  const source = await loadSource(paths[0]);
  const symbols = new Map<string, number>();
  for (const name of ['FRACBITS', 'FRACUNIT']) {
    const expression = requireValue(source['m_fixed.h'].match(new RegExp(`^#define\\s+${name}\\s+([^\\n]+)`, 'm'))?.[1], name);
    symbols.set(name, constant(expression.trim(), symbols));
  }
  const sprites = enumeration(source['info.h'], 'spritenum_t', symbols);
  const stateIds = enumeration(source['info.h'], 'statenum_t', symbols);
  const actorIds = enumeration(source['info.h'], 'mobjtype_t', symbols);
  const soundIds = enumeration(source['sounds.h'], 'sfxenum_t', symbols);
  const flags = enumeration(source['p_mobj.h'], 'mobjflag_t', symbols);
  const weaponIds = enumeration(source['doomdef.h'], 'weapontype_t', symbols);
  const ammoIds = enumeration(source['doomdef.h'], 'ammotype_t', symbols);
  const actionNames = [...source['info.c'].matchAll(/\bvoid\s+(A_\w+)\s*\(\s*\)\s*;/g)]
    .map(match => requireValue(match[1], 'action declaration'));
  if (new Set(actionNames).size !== actionNames.length) throw new Error('Duplicate C action declaration');
  const actions = [{ name: 'None', value: 0 }, ...actionNames.map((name, index) => ({ name, value: index + 1 }))];
  symbols.set('NULL', 0);
  for (const action of actions.slice(1)) symbols.set(action.name, action.value);

  structure(source['info.h'], 'state_t', stateFields);
  structure(source['info.h'], 'mobjinfo_t', actorFields);
  structure(source['d_items.h'], 'weaponinfo_t', weaponFields);
  const states = records(source['info.c'], 'states', stateFields, symbols);
  const actors = records(source['info.c'], 'mobjinfo', actorFields, symbols);
  const weapons = records(source['d_items.c'], 'weaponinfo', weaponFields, symbols);
  if (states.length !== 967 || states.length !== symbols.get('NUMSTATES') ||
    actors.length !== 137 || actors.length !== symbols.get('NUMMOBJTYPES') ||
    weapons.length !== 9 || weapons.length !== symbols.get('NUMWEAPONS')) {
    throw new Error('Original Doom table counts differ from expected values');
  }
  const spriteNames = splitFields(initializer(source['info.c'], 'sprnames')).map(value => {
    const name = /^"([A-Z0-9]{4})"$/.exec(value)?.[1];
    return requireValue(name, 'four-character sprite name');
  });
  if (spriteNames.length !== symbols.get('NUMSPRITES')) throw new Error('Sprite names differ from enum');
  sprites.slice(0, -1).forEach((sprite, index) => {
    if (sprite.name !== `SPR_${spriteNames[index]}`) throw new Error('Sprite enum and name mismatch');
  });

  const validStates = stateIds.filter(entry => entry.name !== 'NUMSTATES');
  const validSprites = sprites.filter(entry => entry.name !== 'NUMSPRITES');
  const validSounds = soundIds.filter(entry => entry.name !== 'NUMSFX');
  const validAmmo = ammoIds.filter(entry => entry.name !== 'NUMAMMO');
  function stateValue(field: string, value: number): string {
    if (field === 'sprite') return reference('SpriteId', validSprites, value);
    if (field === 'action') return reference('ActionId', actions, value);
    if (field === 'nextstate') return reference('StateId', validStates, value);
    if (field === 'tics' && value < -1) throw new Error('Invalid original state duration');
    return String(value);
  }
  function actorValue(field: string, value: number): string {
    if (actorStates.has(field)) return reference('StateId', validStates, value);
    if (actorSounds.has(field)) return reference('SfxId', validSounds, value);
    return String(value);
  }
  function weaponValue(field: string, value: number): string {
    return field === 'ammo' ? reference('AmmoType', validAmmo, value) : reference('StateId', validStates, value);
  }
  const banner = `// Generated from id Software's original Doom tables. Do not edit by hand.\n` +
    `// Copyright (C) 1993-1996 id Software, Inc. GNU GPL version 2; see game/LICENSE.\n` +
    `// Source SHA: ${SOURCE_SHA}\n` +
    `// Regenerate with tools/generate-doom-data.ts.\n\n`;
  function tableCode<T extends string>(name: string, type: string, fields: readonly T[], rows: readonly number[][],
    ids: readonly EnumEntry[], value: (field: T, number: number) => string, multiline = false): string {
    const records = rows.map((row, index) => {
      const members = fields.map((field, position) => `${field}: ${value(field, requireValue(row[position], `${name} field`))}`);
      const label = requireValue(ids[index], `${name} index`).name;
      return multiline ? `  // ${label}\n  {\n${members.map(member => `    ${member},`).join('\n')}\n  },`
        : `  // ${label}\n  { ${members.join(', ')} },`;
    });
    return `export const ${name}: readonly ${type}[] = [\n${records.join('\n')}\n];\n`;
  }
  const outputs = {
    'states.ts': banner + enumCode('SpriteId', sprites) + '\n' + enumCode('StateId', stateIds) + '\n' +
      enumCode('ActionId', actions) + '\n' +
      `export interface StateDefinition {\n  readonly sprite: SpriteId;\n  readonly frame: number;\n  readonly tics: number;\n` +
      `  readonly action: ActionId;\n  readonly nextstate: StateId;\n  readonly misc1: number;\n  readonly misc2: number;\n}\n\n` +
      `export const spriteNames: readonly string[] = [\n${spriteNames.map(name => `  '${name}',`).join('\n')}\n];\n\n` +
      tableCode('states', 'StateDefinition', stateFields, states, stateIds, stateValue),
    'actors.ts': banner + `import { StateId } from './states';\n\n` + enumCode('ActorType', actorIds) + '\n' +
      enumCode('SfxId', soundIds) + '\n' + enumCode('MobjFlag', flags) + '\n' +
      `export interface ActorDefinition {\n${actorFields.map(field =>
        `  readonly ${field}: ${actorStates.has(field) ? 'StateId' : actorSounds.has(field) ? 'SfxId' : 'number'};`).join('\n')}\n}\n\n` +
      tableCode('actors', 'ActorDefinition', actorFields, actors, actorIds, actorValue, true),
    'weapons.ts': banner + `import { StateId } from './states';\n\n` + enumCode('WeaponType', weaponIds) + '\n' +
      enumCode('AmmoType', ammoIds) + '\n' +
      `export interface WeaponDefinition {\n  readonly ammo: AmmoType;\n` +
      weaponFields.slice(1).map(field => `  readonly ${field}: StateId;`).join('\n') + '\n}\n\n' +
      tableCode('weapons', 'WeaponDefinition', weaponFields, weapons, weaponIds, weaponValue),
  };
  const outputDirectory = fileURLToPath(new URL('../game/src/simulation/data/', import.meta.url));
  if (!check) await mkdir(outputDirectory, { recursive: true });
  for (const [name, output] of Object.entries(outputs)) {
    const path = join(outputDirectory, name);
    if (check) {
      if (await readFile(path, 'utf8') !== output) throw new Error(`Generated data differs: ${name}`);
    } else await writeFile(path, output);
  }
  console.log(`${check ? 'Verified' : 'Generated'} ${states.length} states, ${actors.length} actors, ${weapons.length} weapons from ${SOURCE_SHA}`);
}

await main();
