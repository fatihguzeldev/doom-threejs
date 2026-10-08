import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameAudio } from '../../src/audio/game-audio';
import type { AudioScene } from '../../src/audio/game-audio';
import type { MusicRequest, MusicResponse } from '../../src/audio/music-worker';
import type { WadArchive } from '../../src/wad/archive';
import { SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';

type FakeGain = { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
type FakeSource = { buffer: AudioBuffer | null; playbackRate: { value: number };
  connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };

function audioContext() {
  const sources: FakeSource[] = [];
  const gains: FakeGain[] = [];
  const mergers: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  function gain(): FakeGain {
    const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    gains.push(node); return node;
  }
  function source(): FakeSource {
    const node = { buffer: null as AudioBuffer | null, playbackRate: { value: 1 },
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onended: null as (() => void) | null };
    sources.push(node); return node;
  }
  const context = { currentTime: 0, destination: {}, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createGain: gain, createBufferSource: source,
    createChannelMerger() {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      mergers.push(node); return node;
    },
    createBuffer(channels: number, frames: number, rate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { duration: frames / rate, sampleRate: rate, length: frames,
        getChannelData(index: number) { const channel = data[index]; if (!channel) throw new Error('Bad channel'); return channel; },
      } as unknown as AudioBuffer;
    },
  };
  return { context, sources, gains, mergers, native: context as unknown as AudioContext };
}

function musicWorker() {
  const messages: MusicRequest[] = [];
  const worker = { onmessage: null as ((event: MessageEvent<MusicResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null, terminate: vi.fn(),
    postMessage(message: MusicRequest) { messages.push(message); },
  };
  return { worker, messages, native: worker as unknown as Worker,
    reply(message: MusicResponse) { worker.onmessage?.({ data: message } as MessageEvent<MusicResponse>); } };
}

function wad(): WadArchive {
  const dmx = new Uint8Array(8 + 32 + 2).fill(128);
  const view = new DataView(dmx.buffer);
  view.setUint16(0, 3, true); view.setUint16(2, 11025, true); view.setUint32(4, 34, true);
  const bytes = new Uint8Array(dmx.length + 2);
  bytes.set(dmx); bytes.set([77, 26], dmx.length);
  return { kind: 'IWAD', bytes, lumps: [
    { name: 'DSPISTOL', offset: 0, size: dmx.length },
    { name: 'DSSAWIDL', offset: 0, size: dmx.length },
    { name: 'DSITEMUP', offset: 0, size: dmx.length },
    { name: 'DSTELEPT', offset: 0, size: dmx.length },
    { name: 'DSTINK', offset: 0, size: dmx.length },
    { name: 'GENMIDI', offset: dmx.length, size: 1 },
    { name: 'D_E1M1', offset: dmx.length + 1, size: 1 },
    { name: 'D_E1M2', offset: dmx.length + 1, size: 1 },
  ] };
}

function scene(): AudioScene {
  return { listener: { actor: 0, x: 0, y: 0, angle: 0 }, mapNumber: 1,
    actors: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 100 * FRAC_UNIT }],
      [2, { x: 2000 * FRAC_UNIT, y: 0 }]]),
    sectors: [{ soundX: 300 * FRAC_UNIT, soundY: 0 }] };
}

afterEach(() => vi.restoreAllMocks());

describe('browser sound effects', () => {
  it('unlocks on a gesture, decodes cached DMX and replaces only the same origin', async () => {
    const fake = audioContext();
    const audio = createGameAudio(wad(), { context: fake.native, random: () => 16 });
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_pistol, actor: 0 }], scene());
    expect(fake.sources).toHaveLength(0);
    await audio.unlock();
    expect(fake.context.resume).toHaveBeenCalledTimes(1);
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_pistol, actor: 0 },
      { type: 'sound', sound: SfxId.sfx_chgun, actor: 0 },
      { type: 'sound', sound: SfxId.sfx_itemup, actor: null }], scene());
    expect(fake.sources).toHaveLength(3);
    expect(fake.sources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fake.sources[1]?.stop).not.toHaveBeenCalled();
    expect(fake.sources[0]?.buffer).toBe(fake.sources[1]?.buffer);
    expect(fake.sources[1]?.playbackRate.value).toBeCloseTo(2 ** (22 / 64));
    audio.dispose();
  });

  it('attenuates and pans moving actor/sector sources while keeping global sounds centered', async () => {
    const fake = audioContext(); const audio = createGameAudio(wad(), { context: fake.native, random: () => 16 });
    await audio.unlock();
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_pistol, actor: 1 },
      { type: 'sectorSound', sound: SfxId.sfx_pistol, sector: 0 },
      { type: 'sound', sound: SfxId.sfx_itemup, actor: null }], scene());
    expect(fake.gains[2]?.gain.value).toBe(125 / 127);
    expect(fake.gains[3]?.gain.value).toBe(31 / 127);
    expect(fake.gains[6]?.gain.value).toBe(95 / 127);
    expect(fake.gains[7]?.gain.value).toBe(96 / 127);
    const moved = scene();
    audio.update({ ...moved, actors: new Map([[1, { x: 0, y: -680 * FRAC_UNIT }]]) });
    expect(fake.gains[2]?.gain.value).toBe(15 / 127);
    expect(fake.gains[3]?.gain.value).toBe(63 / 127);
    audio.update({ ...moved, actors: new Map([[1, { x: 2000 * FRAC_UNIT, y: 0 }]]) });
    expect(fake.sources[0]?.stop).toHaveBeenCalledOnce();
    audio.dispose();
  });

  it('rejects inaudible starts before consuming random or stopping the old channel', async () => {
    const fake = audioContext(); const random = vi.fn(() => 16);
    const audio = createGameAudio(wad(), { context: fake.native, random }); await audio.unlock();
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_pistol, actor: 1 }], scene());
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_pistol, actor: 1 }],
      { ...scene(), actors: new Map([[1, { x: 2000 * FRAC_UNIT, y: 0 }]]) });
    expect(random).toHaveBeenCalledOnce(); expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]?.stop).not.toHaveBeenCalled(); audio.dispose();
  });

  it('limits effects to eight channels and honors native priority order', async () => {
    const fake = audioContext(); const audio = createGameAudio(wad(), { context: fake.native, random: () => 16 });
    await audio.unlock();
    const actors = new Map(Array.from({ length: 12 }, (_, id) => [id, { x: 0, y: 0 }]));
    const state = { ...scene(), actors };
    audio.handleEvents(Array.from({ length: 8 }, (_, actor) => ({ type: 'sound' as const,
      sound: SfxId.sfx_telept, actor })), state);
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_sawidl, actor: 8 }], state);
    expect(fake.sources).toHaveLength(8);
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_telept, actor: 9 }], state);
    expect(fake.sources).toHaveLength(9); expect(fake.sources[0]?.stop).toHaveBeenCalledOnce();
    audio.handleEvents([{ type: 'stopSound', actor: 9 }], state);
    expect(fake.sources[8]?.stop).toHaveBeenCalledOnce(); audio.dispose();
  });

  it('replaces global origins, handles completed sources and disconnects on stop/dispose', async () => {
    const fake = audioContext(); const audio = createGameAudio(wad(), { context: fake.native });
    await audio.unlock();
    audio.handleEvents([{ type: 'sound', sound: SfxId.sfx_itemup, actor: null },
      { type: 'sound', sound: SfxId.sfx_tink, actor: null }], scene());
    expect(fake.sources[0]?.stop).toHaveBeenCalledOnce();
    fake.sources[1]?.onended?.(); audio.stopSounds();
    expect(fake.sources[1]?.disconnect).toHaveBeenCalledOnce();
    audio.dispose(); audio.dispose();
    expect(fake.context.close).toHaveBeenCalledOnce();
  });
});

describe('streamed music lifecycle', () => {
  it('starts queued music after unlock and ignores chunks from a replaced track', async () => {
    const fake = audioContext(); const stream = musicWorker();
    const audio = createGameAudio(wad(), { context: fake.native, workerFactory: () => stream.native });
    audio.setMusic('D_E1M1', true); expect(stream.messages).toHaveLength(0);
    await audio.unlock();
    expect(stream.messages[0]).toMatchObject({ type: 'load', loop: true });
    const id = stream.messages[0]?.id ?? -1;
    stream.reply({ type: 'loaded', id });
    expect(stream.messages[1]).toMatchObject({ type: 'render', frames: 8192 });
    audio.setMusic('D_E1M2', false);
    stream.reply({ type: 'chunk', id, samples: new Float32Array(8), ended: true });
    expect(fake.sources).toHaveLength(0);
    audio.dispose(); expect(stream.worker.terminate).toHaveBeenCalledOnce();
  });

  it('bounds lookahead and resumes a paused chunk at the original playback offset', async () => {
    const fake = audioContext(); const stream = musicWorker();
    const audio = createGameAudio(wad(), { context: fake.native, workerFactory: () => stream.native });
    await audio.unlock(); audio.setMusic('D_E1M1', true);
    const id = stream.messages[0]?.id ?? -1;
    stream.reply({ type: 'loaded', id });
    for (let count = 0; count < 3; count++) {
      stream.reply({ type: 'chunk', id, samples: new Float32Array(8192 * 2), ended: false });
    }
    expect(stream.messages.filter(message => message.type === 'render')).toHaveLength(3);
    expect(fake.sources).toHaveLength(3);
    fake.context.currentTime = 0.1; audio.pause(true);
    expect(fake.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
    fake.context.currentTime = 2; audio.pause(false);
    expect(fake.sources).toHaveLength(6);
    expect(fake.sources[3]?.start.mock.calls[0]?.[1]).toBeCloseTo(0.08);
    audio.setVolume(0.5, 0.25);
    expect(fake.gains.slice(0, 2).map(gain => gain.gain.value)).toEqual([0.5, 0.25]);
    audio.dispose();
  });

  it('stops on null, reports worker errors, and frees a non-looping end chunk', async () => {
    const fake = audioContext(); const stream = musicWorker(); const onError = vi.fn();
    const audio = createGameAudio(wad(), { context: fake.native, workerFactory: () => stream.native, onError });
    await audio.unlock(); audio.setMusic('D_E1M1', false);
    const id = stream.messages[0]?.id ?? -1;
    stream.reply({ type: 'loaded', id });
    stream.reply({ type: 'chunk', id, samples: new Float32Array(8), ended: true });
    fake.sources[0]?.onended?.();
    expect(stream.messages.filter(message => message.type === 'render')).toHaveLength(1);
    audio.setMusic('D_E1M2', false);
    const nextId = stream.messages.at(-1)?.id ?? -1;
    stream.reply({ type: 'error', id: nextId, message: 'Bad MUS' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Bad MUS' }));
    audio.setMusic(null); audio.dispose();
  });
});
