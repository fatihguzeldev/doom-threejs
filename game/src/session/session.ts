// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native single-player G_Game progression. See ../../LICENSE.
import { idleCommand, type TicCommand } from '../simulation/command';
import { MobjFlag, type SfxId } from '../simulation/data/actors';
import { createPlayer, type Player } from '../simulation/player';
import { createRandom, type RandomState } from '../simulation/random';
import { createSimulation, type Simulation } from '../simulation/simulation';
import { createWorld, type GameEvent, type GameMode, type Skill, type World } from '../simulation/world';
import { findLump, type WadArchive } from '../wad/archive';
import { decodeMap } from '../wad/map';
import type { DoomResources } from '../wad/resources';
import { createFinale, readFinale, tickFinale, type FinaleState } from './finale';
import { advanceIntermission, createIntermission, readIntermission, tickIntermission, type IntermissionState } from './intermission';
import { boolean, integer, invalid, object, oneOf, shape, string } from './json';
import { loadWorld, readMode, readSkill, saveWorld } from './save';

export type { FinaleState } from './finale';
export type { IntermissionCounters, IntermissionState, IntermissionStats } from './intermission';
export interface LevelState { readonly kind: 'level'; readonly world: World; readonly simulation: Simulation }
export type SessionState = LevelState | IntermissionState | FinaleState;
export type SessionEvent = Exclude<GameEvent, { type: 'exit' }> |
  { readonly type: 'music'; readonly name: string; readonly loop: boolean } |
  { readonly type: 'state'; readonly kind: SessionState['kind'] };
export interface SessionOptions {
  readonly skill?: Skill;
  readonly episode?: number;
  readonly mapNumber?: number;
  readonly mode?: GameMode;
  readonly noMonsters?: boolean;
  readonly fastMonsters?: boolean;
  readonly respawnMonsters?: boolean;
}
export interface Session {
  readonly state: SessionState;
  readonly events: SessionEvent[];
  newGame(options?: SessionOptions): void;
  tick(command?: TicCommand): void;
  advanceIntermission(): void;
  save(): string;
  load(text: string): void;
}
interface Settings {
  skill: Skill;
  mode: GameMode;
  episode: number;
  mapNumber: number;
  noMonsters: boolean;
  fastMonsters: boolean;
  respawnMonsters: boolean;
}
const readSettings = shape<Settings>({ skill: readSkill, mode: readMode, episode: integer(1, 4), mapNumber: integer(1, 9),
  noMonsters: boolean, fastMonsters: boolean, respawnMonsters: boolean });
const readEnvelope = shape<{ version: 1; wad: string; settings: Settings; state: unknown }>({
  version: oneOf([1]), wad: string(64), settings: readSettings, state: value => value,
});
const E4_MUSIC = ['E3M4', 'E3M2', 'E3M3', 'E1M5', 'E2M7', 'E2M4', 'E2M6', 'E2M5', 'E1M9'];

function wadIdentity(wad: WadArchive): string {
  let hash = 0x811c9dc5;
  for (const byte of wad.bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  for (const lump of wad.lumps) {
    for (let i = 0; i < lump.name.length; i++) hash = Math.imul(hash ^ lump.name.charCodeAt(i), 0x01000193);
    hash = Math.imul(hash ^ lump.offset, 0x01000193);
    hash = Math.imul(hash ^ lump.size, 0x01000193);
  }
  return `${wad.bytes.length}:${wad.lumps.length}:${(hash >>> 0).toString(16)}`;
}

function finishLevel(world: World): void {
  world.player.powers.fill(0); world.player.cards.fill(false);
  const actor = world.actorsById.get(world.player.actorId);
  if (actor) actor.flags &= ~MobjFlag.MF_SHADOW;
  world.player.extraLight = world.player.fixedColormap = world.player.damageCount = world.player.bonusCount = 0;
}

export function createSession(wad: WadArchive, resources: DoomResources, options: SessionOptions = {}): Session {
  const identity = wadIdentity(wad);
  const inferredMode: GameMode = findLump(wad, 'E4M1') ? 'retail' : findLump(wad, 'E2M1') ? 'registered' : 'shareware';
  const events: SessionEvent[] = [];
  let state: SessionState;
  let settings: Settings;
  const sound = (id: SfxId): void => { events.push({ type: 'sound', sound: id, actor: null }); };
  const music = (name: string): void => { events.push({ type: 'music', name, loop: true }); };
  const levelMusic = (episode: number, map: number): string => `D_${episode === 4 ? E4_MUSIC[map - 1] : `E${episode}M${map}`}`;
  const normalize = (input: SessionOptions): Settings => {
    const mode = readMode(input.mode ?? inferredMode, 'options.mode');
    const maxEpisode = mode === 'shareware' ? 1 : mode === 'registered' ? 3 : 4;
    const episode = integer(1, maxEpisode)(Math.min(maxEpisode, Math.max(1, input.episode ?? 1)), 'options.episode');
    const mapNumber = integer(1, 9)(Math.min(9, Math.max(1, input.mapNumber ?? 1)), 'options.mapNumber');
    const skill = readSkill(Math.min(4, Math.max(0, input.skill ?? 2)), 'options.skill');
    return { skill, mode, episode, mapNumber, noMonsters: boolean(input.noMonsters ?? false, 'options.noMonsters'),
      fastMonsters: boolean(input.fastMonsters ?? false, 'options.fastMonsters') || skill === 4,
      respawnMonsters: boolean(input.respawnMonsters ?? false, 'options.respawnMonsters') || skill === 4 };
  };
  const enterLevel = (next: Settings, player: Player, random: RandomState): void => {
    const map = decodeMap(wad, `E${next.episode}M${next.mapNumber}`);
    const world = createWorld(map, { ...next, player, random });
    // Actor IDs are local to a level. An old attacker's ID cannot refer into it.
    player.attacker = null;
    const simulation = createSimulation(world, resources);
    settings = next;
    state = { kind: 'level', world, simulation };
    events.push({ type: 'state', kind: 'level' });
    music(levelMusic(next.episode, next.mapNumber));
    for (const event of world.events.splice(0)) if (event.type !== 'exit') events.push(event);
  };
  const newGame = (input: SessionOptions = options): void => {
    const next = normalize(input);
    events.length = 0;
    enterLevel(next, createPlayer(), createRandom());
  };
  const complete = (world: World, secret: boolean): void => {
    finishLevel(world);
    if (world.mapNumber === 8) {
      state = createFinale(world);
      music('D_VICTOR');
    } else {
      if (world.mapNumber === 9) world.player.didSecret = true;
      state = createIntermission(world, secret);
    }
    events.push({ type: 'state', kind: state.kind });
  };
  const tick = (command: TicCommand = idleCommand): void => {
    if (state.kind === 'level') {
      if (state.world.player.state === 'reborn') enterLevel(settings, createPlayer(), state.world.random);
      if (state.kind !== 'level') throw new Error('Reloaded session has no level');
      const { world, simulation } = state;
      simulation.tick(command);
      let exit: boolean | null = null;
      for (const event of world.events.splice(0)) {
        if (event.type === 'exit') exit = event.secret;
        else events.push(event);
      }
      if (exit !== null) complete(world, exit);
    } else if (state.kind === 'intermission') {
      if (state.ticks === 0) music('D_INTER');
      if (tickIntermission(state, command, sound)) {
        if (state.secretExit) state.player.didSecret = true;
        enterLevel({ ...settings, mapNumber: state.nextMapNumber }, state.player, state.random);
      }
    } else if (tickFinale(state, sound)) music('D_BUNNY');
  };
  const save = (): string => JSON.stringify({ version: 1, wad: identity, settings,
    state: state.kind === 'level' ? { kind: 'level', world: saveWorld(state.world) } : state });
  const load = (text: string): void => {
    if (text.length > 16 * 1024 * 1024) invalid('document', 'at most 16 MiB');
    let value: unknown;
    try { value = JSON.parse(text); } catch { invalid('document', 'valid JSON'); }
    const saved = readEnvelope(value, 'document');
    if (saved.wad !== identity) invalid('wad', 'the same WAD assets');
    const maxEpisode = saved.settings.mode === 'shareware' ? 1 : saved.settings.mode === 'registered' ? 3 : 4;
    if (saved.settings.episode > maxEpisode || (saved.settings.skill === 4 && (!saved.settings.fastMonsters || !saved.settings.respawnMonsters))) invalid('settings', 'valid episode and nightmare flags');
    const raw = object(saved.state, 'state');
    let restored: SessionState;
    if (raw['kind'] === 'level') {
      const level = shape<{ kind: 'level'; world: unknown }>({ kind: oneOf(['level']), world: item => item })(raw, 'state');
      const world = loadWorld(wad, level.world);
      if (world.skill !== saved.settings.skill || world.mode !== saved.settings.mode || world.episode !== saved.settings.episode || world.mapNumber !== saved.settings.mapNumber ||
        world.fastMonsters !== saved.settings.fastMonsters || world.respawnMonsters !== saved.settings.respawnMonsters) invalid('settings', 'the saved world settings');
      restored = { kind: 'level', world, simulation: createSimulation(world, resources, { initialize: false }) };
    } else if (raw['kind'] === 'intermission') {
      restored = readIntermission(raw, 'state');
      if (restored.episode !== saved.settings.episode || restored.mapNumber !== saved.settings.mapNumber) invalid('state', 'matching intermission level');
      decodeMap(wad, `E${restored.episode}M${restored.nextMapNumber}`);
    } else if (raw['kind'] === 'finale') {
      restored = readFinale(raw, 'state');
      if (restored.episode !== saved.settings.episode || saved.settings.mapNumber !== 8) invalid('state', 'matching episode finale');
      if (restored.episode === 1 && restored.picture !== (saved.settings.mode === 'retail' ? 'CREDIT' : 'HELP2')) invalid('state.picture', 'the game mode finale art');
    } else invalid('state.kind', 'level|intermission|finale');
    settings = saved.settings; state = restored;
    events.length = 0;
    events.push({ type: 'state', kind: state.kind });
    music(state.kind === 'level' ? levelMusic(state.world.episode, state.world.mapNumber) : state.kind === 'intermission' ? 'D_INTER' : state.stage === 'art' && state.episode === 3 ? 'D_BUNNY' : 'D_VICTOR');
  };
  newGame(options);
  return { get state() { return state; }, events, newGame, tick,
    advanceIntermission: () => { if (state.kind === 'intermission') advanceIntermission(state, sound); }, save, load };
}
