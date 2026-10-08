// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native classic demo format from G_DoPlayDemo/G_ReadDemoTiccmd in g_game.c.
// See ../../LICENSE.
import type { TicCommand } from '../simulation/command';

export type DemoPlayer = 0 | 1 | 2 | 3;
export type DemoSkill = 0 | 1 | 2 | 3 | 4;

export interface DemoHeader {
  readonly version: 109 | 110;
  readonly skill: DemoSkill;
  readonly episode: number;
  readonly mapNumber: number;
  readonly deathmatch: 0 | 1 | 2;
  readonly respawn: boolean;
  readonly fast: boolean;
  readonly noMonsters: boolean;
  readonly consolePlayer: DemoPlayer;
  readonly playersActive: readonly [boolean, boolean, boolean, boolean];
}

export interface DemoPlayerCommand {
  readonly player: DemoPlayer;
  readonly command: TicCommand;
}

export type DemoTic = readonly DemoPlayerCommand[];

export interface DoomDemo {
  readonly header: DemoHeader;
  readonly tics: readonly DemoTic[];
}

const HEADER_SIZE = 13;
const DEMO_MARKER = 0x80;

function checkRange(value: number, minimum: number, maximum: number, field: string): void {
  if (value < minimum || value > maximum) throw new Error(`Invalid demo ${field}: ${value}`);
}

export function decodeDemo(bytes: Uint8Array): DoomDemo {
  if (bytes.byteLength < HEADER_SIZE) throw new Error('Truncated demo header: expected 13 bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== 109 && version !== 110) throw new Error('Unsupported demo version: expected 109 or 110');
  const skill = view.getUint8(1), episode = view.getUint8(2), mapNumber = view.getUint8(3);
  const deathmatch = view.getUint8(4), consolePlayer = view.getUint8(8);
  checkRange(skill, 0, 4, 'skill');
  checkRange(episode, 1, 4, 'episode');
  checkRange(mapNumber, 1, 9, 'map');
  checkRange(deathmatch, 0, 2, 'deathmatch');
  checkRange(consolePlayer, 0, 3, 'console player');

  function flag(offset: number): boolean {
    const value = view.getUint8(offset);
    if (value > 1) throw new Error(`Invalid demo flag at header byte ${offset}: ${value}`);
    return value === 1;
  }

  const playersActive: DemoHeader['playersActive'] = [flag(9), flag(10), flag(11), flag(12)];
  const players = playersActive.flatMap((active, player) => active ? [player as DemoPlayer] : []);
  if (players.length === 0) throw new Error('Invalid demo header: no active players');
  if (!playersActive[consolePlayer]) throw new Error('Invalid demo header: console player is inactive');
  const header: DemoHeader = { version, skill: skill as DemoSkill, episode, mapNumber,
    deathmatch: deathmatch as DemoHeader['deathmatch'], respawn: flag(5), fast: flag(6), noMonsters: flag(7),
    consolePlayer: consolePlayer as DemoPlayer, playersActive };
  const tics: DemoTic[] = [];
  let cursor = HEADER_SIZE;
  for (;;) {
    if (cursor >= bytes.byteLength) throw new Error('Demo stream is missing its end marker');
    if (view.getUint8(cursor) === DEMO_MARKER) return { header, tics };
    const tic: DemoPlayerCommand[] = [];
    for (const player of players) {
      if (cursor < bytes.byteLength && view.getUint8(cursor) === DEMO_MARKER) {
        throw new Error(`Incomplete multiplayer demo tic ${tics.length}`);
      }
      if (bytes.byteLength - cursor < 4) throw new Error(`Truncated demo command in tic ${tics.length}, player ${player}`);
      tic.push({ player, command: {
        forwardMove: view.getInt8(cursor),
        sideMove: view.getInt8(cursor + 1),
        // The original unsigned byte shift is narrowed to ticcmd_t's signed short.
        angleTurn: view.getInt8(cursor + 2) << 8,
        buttons: view.getUint8(cursor + 3),
      } });
      cursor += 4;
    }
    tics.push(tic);
  }
}
