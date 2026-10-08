import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawSessionScreen } from '../../src/presentation/screens';
import type { PatchPainter } from '../../src/presentation/patches';
import { createIntermission } from '../../src/session/intermission';
import { createFinale } from '../../src/session/finale';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);

function fixture() {
  const patches: { name: string; x: number; y: number }[] = [], texts: { text: string; x: number; y: number }[] = [];
  const context = { clearRect() {}, drawImage() {} } as unknown as CanvasRenderingContext2D;
  const painter: PatchPainter = {
    patch(_context, name, x, y) { patches.push({ name, x, y }); },
    text(_context, text, x, y) { texts.push({ text, x, y }); }, textWidth: text => text.length * 4,
    image: () => ({} as HTMLCanvasElement), indexed: () => ({} as HTMLCanvasElement), clear() {},
  };
  const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 }), state = createIntermission(world, false);
  const registered = { ...resources, patch(name: string) { return /^WILV[123]/.test(name) ? resources.patch('WILV00') : resources.patch(name); } };
  return { context, painter, state, world, patches, texts, registered };
}

describe('native intermission drawing commands', () => {
  it('uses original digit sizes, two-digit time groups and source-derived title/stat spacing', () => {
    const f = fixture();
    Object.assign(f.state.counters, { kills: 100, items: 75, secrets: 0, time: 65, par: 5 });
    drawSessionScreen(f.context, f.state, resources, f.painter);
    expect(f.patches).toContainEqual({ name: 'WIF', x: 114, y: 17 });
    expect(f.patches).toContainEqual({ name: 'WIOSTI', x: 50, y: 68 });
    expect(f.patches).toContainEqual({ name: 'WISCRT2', x: 50, y: 86 });
    expect(f.patches).toContainEqual({ name: 'WINUM5', x: 133, y: 168 });
    expect(f.patches).toContainEqual({ name: 'WINUM0', x: 122, y: 168 });
    expect(f.patches).toContainEqual({ name: 'WICOLON', x: 117, y: 168 });
    expect(f.patches).toContainEqual({ name: 'WINUM1', x: 106, y: 168 });
    expect(f.patches).toContainEqual({ name: 'WINUM0', x: 95, y: 168 });
    expect(f.patches.filter(command => command.name.startsWith('WINUM') && command.x > 200 && command.y === 168)).toHaveLength(2);
  });

  it('draws current animation frames and obeys pointerOn through showNext/leaving', () => {
    const f = fixture(); f.state.stage = 'showNext';
    const animation = f.state.animations[0]; if (!animation) throw new Error('Intermission animation missing');
    animation.frame = 2; f.state.ticks = 0; f.state.pointerOn = false;
    drawSessionScreen(f.context, f.state, resources, f.painter);
    expect(f.patches).toContainEqual({ name: 'WIA00002', x: 224, y: 104 });
    expect(f.patches.some(command => command.name.startsWith('WIURH'))).toBe(false);
    f.patches.length = 0; f.state.stage = 'leaving'; f.state.ticks = 31; f.state.pointerOn = true;
    drawSessionScreen(f.context, f.state, resources, f.painter);
    expect(f.patches.some(command => command.name.startsWith('WIURH'))).toBe(true);
  });

  it('marks only completed regular maps and the visited secret map when returning from E1M9', () => {
    const f = fixture(); Object.assign(f.state, { mapNumber: 9, nextMapNumber: 4, stage: 'showNext' });
    f.state.player.didSecret = true;
    drawSessionScreen(f.context, f.state, resources, f.painter);
    expect(f.patches.filter(command => command.name === 'WISPLAT')).toEqual([
      { name: 'WISPLAT', x: 185, y: 164 }, { name: 'WISPLAT', x: 148, y: 143 },
      { name: 'WISPLAT', x: 69, y: 122 }, { name: 'WISPLAT', x: 71, y: 24 },
    ]);
  });

  it('chooses the pointer variant that fits near the right screen edge', () => {
    const f = fixture(); Object.assign(f.state, { episode: 3, mapNumber: 3, nextMapNumber: 4, stage: 'showNext', pointerOn: true });
    drawSessionScreen(f.context, f.state, f.registered, f.painter);
    expect(f.patches).toContainEqual({ name: 'WIURH1', x: 265, y: 75 });
    expect(f.patches.some(command => command.name === 'WIURH0')).toBe(false);
  });

  it('reuses the original episode-two animation-four patch for animation-eight', () => {
    const f = fixture(); Object.assign(f.state, { episode: 2 });
    f.state.animations.splice(0, 10, ...Array.from({ length: 9 }, (_, index) => ({ frame: index === 8 ? 0 : -1, nextTic: 0 })));
    drawSessionScreen(f.context, f.state, f.registered, f.painter);
    expect(f.patches).toContainEqual({ name: 'WIA10400', x: 128, y: 136 });
  });
});

describe('native finale text drawing commands', () => {
  it('advances original explicit lines by eleven pixels without inserting extra wraps', () => {
    const f = fixture(), state = createFinale(f.world);
    state.textVisibleChars = state.text.length;
    drawSessionScreen(f.context, state, resources, f.painter);
    expect(f.texts[0]?.y).toBe(10);
    expect(f.texts[1]?.y).toBe(21);
    expect(f.texts[2]?.y).toBe(32);
    expect(f.texts[0]?.text).not.toContain('\n');
  });
});
