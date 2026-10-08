import { decodeDmx } from './dmx';
import { soundDefinitions, soundParameters, selectSoundChannel, soundPitch, soundStereo } from './sound';
import type { AudioListener, AudioPosition, SoundParameters } from './sound';
import type { MusicRequest, MusicResponse } from './music-worker';
import { findLump, readLump } from '../wad/archive';
import type { WadArchive } from '../wad/archive';
import type { GameEvent } from '../simulation/world';
import { SfxId } from '../simulation/data/actors';
import { createRandom, menuRandom } from '../simulation/random';

export interface AudioScene {
  readonly listener: AudioListener;
  readonly actors: ReadonlyMap<number, AudioPosition>;
  readonly sectors: readonly { readonly soundX: number; readonly soundY: number }[];
  readonly mapNumber: number;
}

export interface GameAudio {
  unlock(): Promise<void>;
  handleEvents(events: readonly GameEvent[], scene: AudioScene): void;
  update(scene: AudioScene): void;
  setMusic(lumpName: string | null, loop?: boolean): void;
  stopSounds(): void;
  pause(paused: boolean): void;
  setVolume(sfx: number, music: number): void;
  dispose(): void;
}

export interface GameAudioOptions {
  readonly context?: AudioContext;
  readonly workerFactory?: () => Worker;
  readonly random?: () => number;
  readonly onError?: (error: Error) => void;
}

type Origin = { readonly type: 'actor'; readonly id: number }
  | { readonly type: 'sector'; readonly id: number } | { readonly type: 'global' };
interface SoundChannel {
  readonly origin: Origin;
  readonly priority: number;
  readonly source: AudioBufferSourceNode;
  readonly left: GainNode;
  readonly right: GainNode;
  readonly merger: ChannelMergerNode;
}
interface MusicPiece {
  readonly buffer: AudioBuffer;
  offset: number;
  source: AudioBufferSourceNode | null;
  startTime: number;
}

const MUSIC_RATE = 49700;
const CHUNK_FRAMES = 8192;
const LOOKAHEAD_SECONDS = 0.5;
const START_DELAY_SECONDS = 0.02;

export function createGameAudio(wad: WadArchive, options: GameAudioOptions = {}): GameAudio {
  const randomState = createRandom();
  const random = options.random ?? (() => menuRandom(randomState));
  const channels: (SoundChannel | null)[] = Array.from({ length: 8 }, () => null);
  const buffers = new Map<string, AudioBuffer>();
  const pieces: MusicPiece[] = [];
  let context: AudioContext | null = null;
  let sfxGain: GainNode | null = null;
  let musicGain: GainNode | null = null;
  let sfxVolume = 1;
  let musicVolume = 1;
  let unlocked = false;
  let disposed = false;
  let paused = false;
  let worker: Worker | null = null;
  let musicName: string | null = null;
  let musicLoop = true;
  let musicId = 0;
  let musicLoaded = false;
  let musicEnded = false;
  let renderPending = false;
  let nextMusicTime = 0;

  function report(error: unknown): void {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  function lumpBytes(name: string): Uint8Array {
    const lump = findLump(wad, name);
    if (!lump) throw new Error(`Missing audio WAD lump ${name}`);
    return readLump(wad, lump);
  }
  function sameOrigin(a: Origin, b: Origin): boolean {
    return a.type === b.type && (a.type === 'global' || (b.type !== 'global' && a.id === b.id));
  }
  function finishChannel(index: number, channel: SoundChannel, stop: boolean): void {
    if (channels[index] !== channel) return;
    channels[index] = null;
    channel.source.onended = null;
    if (stop) channel.source.stop();
    channel.source.disconnect(); channel.left.disconnect(); channel.right.disconnect(); channel.merger.disconnect();
  }
  function stopOrigin(origin: Origin): void {
    const index = channels.findIndex(channel => channel !== null && sameOrigin(channel.origin, origin));
    const channel = channels[index];
    if (channel) finishChannel(index, channel, true);
  }
  function parameters(origin: Origin, scene: AudioScene): SoundParameters | null {
    if (origin.type === 'global' || (origin.type === 'actor' && origin.id === scene.listener.actor)) {
      return soundParameters(scene.listener, null, scene.mapNumber);
    }
    if (origin.type === 'actor') {
      const position = scene.actors.get(origin.id);
      return position ? soundParameters(scene.listener, position, scene.mapNumber) : null;
    }
    const sector = scene.sectors[origin.id];
    return sector ? soundParameters(scene.listener, { x: sector.soundX, y: sector.soundY }, scene.mapNumber) : null;
  }
  function setParameters(channel: SoundChannel, params: SoundParameters): void {
    const [left, right] = soundStereo(params);
    channel.left.gain.value = left;
    channel.right.gain.value = right;
  }
  function startSound(sound: SfxId, origin: Origin, scene: AudioScene): void {
    if (!context || !sfxGain || !unlocked || disposed || sound <= SfxId.sfx_None || sound >= SfxId.NUMSFX) return;
    const definition = soundDefinitions[sound];
    const params = parameters(origin, scene);
    if (!definition || !params) return;
    // Original S_StartSound rejects inaudible sounds before RNG or replacement.
    const pitch = soundPitch(sound, random);
    stopOrigin(origin);
    const index = selectSoundChannel(channels, definition.priority);
    if (index < 0) return;
    const occupied = channels[index];
    if (occupied) finishChannel(index, occupied, true);
    try {
      let buffer = buffers.get(definition.name);
      if (!buffer) {
        const decoded = decodeDmx(lumpBytes(`DS${definition.name.toUpperCase()}`));
        buffer = context.createBuffer(1, decoded.samples.length, decoded.sampleRate);
        buffer.getChannelData(0).set(decoded.samples);
        buffers.set(definition.name, buffer);
      }
      const source = context.createBufferSource();
      const left = context.createGain();
      const right = context.createGain();
      const merger = context.createChannelMerger(2);
      source.buffer = buffer;
      source.playbackRate.value = 2 ** ((pitch - 128) / 64);
      source.connect(left); source.connect(right);
      left.connect(merger, 0, 0); right.connect(merger, 0, 1); merger.connect(sfxGain);
      const channel: SoundChannel = { origin, priority: definition.priority, source, left, right, merger };
      channels[index] = channel;
      setParameters(channel, params);
      source.onended = () => finishChannel(index, channel, false);
      source.start();
    } catch (error: unknown) { report(error); }
  }

  function post(message: MusicRequest, transfer?: Transferable[]): void {
    worker?.postMessage(message, transfer ?? []);
  }
  function clearMusic(): void {
    for (const piece of pieces) {
      if (piece.source) {
        piece.source.onended = null;
        piece.source.stop(); piece.source.disconnect();
      }
    }
    pieces.length = 0;
    nextMusicTime = 0;
    musicLoaded = false;
    musicEnded = false;
    renderPending = false;
  }
  function schedule(piece: MusicPiece): void {
    if (!context || !musicGain) return;
    const source = context.createBufferSource();
    source.buffer = piece.buffer;
    source.connect(musicGain);
    piece.source = source;
    piece.startTime = Math.max(nextMusicTime, context.currentTime + START_DELAY_SECONDS);
    nextMusicTime = piece.startTime + piece.buffer.duration - piece.offset;
    source.onended = () => {
      source.disconnect();
      const index = pieces.indexOf(piece);
      if (index >= 0) pieces.splice(index, 1);
      pump();
    };
    source.start(piece.startTime, piece.offset);
  }
  function pump(): void {
    if (!context || !unlocked || disposed || paused || !musicLoaded || musicEnded || renderPending) return;
    if (nextMusicTime - context.currentTime >= LOOKAHEAD_SECONDS) return;
    renderPending = true;
    post({ type: 'render', id: musicId, frames: CHUNK_FRAMES });
  }
  function receive({ data }: MessageEvent<MusicResponse>): void {
    if (disposed || data.id !== musicId || !context) return;
    if (data.type === 'error') {
      clearMusic();
      report(new Error(data.message));
    } else if (data.type === 'loaded') {
      musicLoaded = true; pump();
    } else {
      renderPending = false;
      musicEnded = data.ended;
      if (data.samples.length > 0) {
        const frames = data.samples.length / 2;
        const buffer = context.createBuffer(2, frames, MUSIC_RATE);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let index = 0; index < frames; index++) {
          left[index] = data.samples[index * 2] as number;
          right[index] = data.samples[index * 2 + 1] as number;
        }
        const piece: MusicPiece = { buffer, offset: 0, source: null, startTime: 0 };
        pieces.push(piece);
        if (!paused) schedule(piece);
      }
      pump();
    }
  }
  function startMusic(): void {
    if (!musicName || !unlocked || disposed) return;
    try {
      if (!worker) {
        worker = options.workerFactory?.() ?? new Worker(new URL('./music-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = receive;
        worker.onerror = event => { clearMusic(); report(new Error(event.message)); };
      }
      const mus = new Uint8Array(lumpBytes(musicName));
      const genMidi = new Uint8Array(lumpBytes('GENMIDI'));
      post({ type: 'load', id: musicId, mus, genMidi, loop: musicLoop }, [mus.buffer, genMidi.buffer]);
    } catch (error: unknown) { report(error); }
  }

  return {
    async unlock(): Promise<void> {
      if (disposed) return;
      if (!context) {
        context = options.context ?? new AudioContext();
        sfxGain = context.createGain(); musicGain = context.createGain();
        sfxGain.gain.value = sfxVolume; musicGain.gain.value = musicVolume;
        sfxGain.connect(context.destination); musicGain.connect(context.destination);
      }
      await context.resume();
      if (disposed || unlocked) return;
      unlocked = true;
      startMusic();
    },
    handleEvents(events, scene): void {
      for (const event of events) {
        if (event.type === 'sound') {
          startSound(event.sound, event.actor === null ? { type: 'global' } : { type: 'actor', id: event.actor }, scene);
        } else if (event.type === 'sectorSound') startSound(event.sound, { type: 'sector', id: event.sector }, scene);
        else if (event.type === 'stopSound') stopOrigin({ type: 'actor', id: event.actor });
      }
    },
    update(scene): void {
      for (let index = 0; index < channels.length; index++) {
        const channel = channels[index];
        if (!channel) continue;
        const params = parameters(channel.origin, scene);
        if (params) setParameters(channel, params);
        else finishChannel(index, channel, true);
      }
      pump();
    },
    setMusic(lumpName, loop = true): void {
      if (disposed) return;
      const name = lumpName?.toUpperCase() ?? null;
      if (name === musicName && loop === musicLoop) return;
      clearMusic();
      musicName = name; musicLoop = loop; musicId++;
      post({ type: 'stop', id: musicId });
      startMusic();
    },
    stopSounds(): void {
      for (let index = 0; index < channels.length; index++) {
        const channel = channels[index];
        if (channel) finishChannel(index, channel, true);
      }
    },
    pause(value): void {
      if (paused === value || disposed) return;
      paused = value;
      if (value && context) {
        for (let index = pieces.length - 1; index >= 0; index--) {
          const piece = pieces[index] as MusicPiece;
          if (!piece.source) continue;
          piece.offset += Math.max(0, context.currentTime - piece.startTime);
          piece.source.onended = null;
          piece.source.stop(); piece.source.disconnect(); piece.source = null;
          if (piece.offset >= piece.buffer.duration) pieces.splice(index, 1);
        }
        nextMusicTime = 0;
      } else if (!value) {
        for (const piece of pieces) schedule(piece);
        pump();
      }
    },
    setVolume(sfx, music): void {
      sfxVolume = Math.max(0, Math.min(1, Number.isFinite(sfx) ? sfx : 0));
      musicVolume = Math.max(0, Math.min(1, Number.isFinite(music) ? music : 0));
      if (sfxGain) sfxGain.gain.value = sfxVolume;
      if (musicGain) musicGain.gain.value = musicVolume;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (let index = 0; index < channels.length; index++) {
        const channel = channels[index];
        if (channel) finishChannel(index, channel, true);
      }
      clearMusic(); worker?.terminate(); worker = null;
      sfxGain?.disconnect(); musicGain?.disconnect(); buffers.clear();
      if (context) void context.close().catch(report);
      context = null;
    },
  };
}
