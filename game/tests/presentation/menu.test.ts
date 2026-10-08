import { describe, expect, it } from 'vitest';
import { createGameMenu } from '../../src/presentation/menu';
import type { PatchPainter } from '../../src/presentation/patches';

function fixture() {
  const patches: { name: string; x: number; y: number }[] = [], texts: { text: string; x: number; y: number }[] = [];
  const context = { fillRect() {} } as unknown as CanvasRenderingContext2D;
  const painter: PatchPainter = {
    patch(_context, name, x, y) { patches.push({ name, x, y }); },
    text(_context, text, x, y) { texts.push({ text, x, y }); }, textWidth: text => text.length * 4,
    image: () => ({} as HTMLCanvasElement), indexed: () => ({} as HTMLCanvasElement), clear() {},
  };
  const menu = createGameMenu(painter, () => 'shareware', () => ['FIRST SAVE']);
  return { menu, context, patches, texts };
}

describe('native menu placement and selection', () => {
  it('uses the original main, episode and skill origins with a matching skull cursor', () => {
    const f = fixture(); f.menu.draw(f.context, 0);
    expect(f.patches).toContainEqual({ name: 'M_NGAME', x: 97, y: 64 });
    expect(f.patches).toContainEqual({ name: 'M_SKULL1', x: 65, y: 59 });
    f.patches.length = 0; f.menu.input('confirm'); f.menu.draw(f.context, 0);
    expect(f.patches).toContainEqual({ name: 'M_EPI1', x: 48, y: 63 });
    expect(f.patches).toContainEqual({ name: 'M_SKULL1', x: 16, y: 58 });
    f.patches.length = 0; f.menu.input('confirm'); f.menu.draw(f.context, 0);
    expect(f.patches).toContainEqual({ name: 'M_HURT', x: 48, y: 95 });
  });

  it('uses the same options-row spacing for drawing and pointer hit testing', () => {
    const f = fixture(); f.menu.input('down'); f.menu.input('confirm');
    f.menu.click(80, 95);
    expect(f.menu.input('right')).toEqual({ type: 'volume', channel: 'music', value: 0.65 });
    f.menu.draw(f.context, 0);
    expect(f.texts).toContainEqual({ text: 'MUSIC VOLUME  7', x: 60, y: 92 });
    expect(f.patches).toContainEqual({ name: 'M_SKULL1', x: 28, y: 87 });
  });

  it('positions save-slot headers, borders and text at their native coordinates', () => {
    const f = fixture(); f.menu.show('save'); f.menu.draw(f.context, 0);
    expect(f.patches).toContainEqual({ name: 'M_SAVEG', x: 72, y: 28 });
    expect(f.texts).toContainEqual({ text: 'FIRST SAVE', x: 80, y: 54 });
    expect(f.patches).toContainEqual({ name: 'M_LSLEFT', x: 72, y: 61 });
    expect(f.patches.filter(command => command.name === 'M_LSCNTR')).toHaveLength(24 * 6);
    expect(f.menu.click(100, 55)).toEqual({ type: 'save', slot: 0 });
  });
});
