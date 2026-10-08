import { describe, expect, it } from 'vitest';
import type { IndexedImage } from '../../src/wad/graphics';
import { packIndexedAtlas } from '../../src/render/atlas';
import type { IndexedAtlas } from '../../src/render/atlas';

function image(width: number, height: number, pixels?: readonly number[], alpha?: readonly number[]): IndexedImage {
  return {
    width, height, leftOffset: -7, topOffset: 12,
    pixels: pixels ? new Uint8Array(pixels) : new Uint8Array(width * height).fill(42),
    alpha: alpha ? new Uint8Array(alpha) : new Uint8Array(width * height).fill(255),
  };
}

function texel(atlas: IndexedAtlas, page: number, x: number, y: number): readonly number[] {
  const entry = atlas.pages[page];
  if (!entry) throw new Error('Atlas page missing');
  const index = (y * entry.width + x) * 2;
  return [entry.pixels[index] ?? -1, entry.pixels[index + 1] ?? -1];
}

describe('packIndexedAtlas', () => {
  it('packs palette indices and independent alpha into 1024-square RG pages', () => {
    const source = image(2, 2, [1, 2, 3, 255], [255, 0, 255, 255]);
    const atlas = packIndexedAtlas([{ key: 'wall', image: source }]);
    const region = atlas.regions.get('wall');
    if (!region) throw new Error('Atlas region missing');
    expect(atlas.pages).toHaveLength(1);
    expect([atlas.pages[0]?.width, atlas.pages[0]?.height, atlas.pages[0]?.pixels.length]).toEqual([1024, 1024, 1024 * 1024 * 2]);
    expect(region).toEqual({ page: 0, x: 1, y: 1, width: 2, height: 2, leftOffset: -7, topOffset: 12 });
    expect(texel(atlas, 0, region.x + 1, region.y + 1)).toEqual([255, 255]);
    expect(texel(atlas, 0, region.x + 1, region.y)).toEqual([2, 0]);
    source.pixels.fill(0);
    expect(texel(atlas, 0, region.x, region.y)).toEqual([1, 255]);
  });

  it('fills all gutter edges and corners by repeating opposite image edges', () => {
    const atlas = packIndexedAtlas([{ key: 'flat', image: image(2, 2, [1, 2, 3, 255], [255, 0, 255, 255]) }]);
    expect(Array.from({ length: 4 }, (_, y) => Array.from({ length: 4 }, (_, x) => texel(atlas, 0, x, y)[0]))).toEqual([
      [255, 3, 255, 3], [2, 1, 2, 1], [255, 3, 255, 3], [2, 1, 2, 1],
    ]);
    expect(texel(atlas, 0, 0, 1)).toEqual([2, 0]);
    expect(texel(atlas, 0, 3, 1)).toEqual([1, 255]);
  });

  it('deduplicates identical source images under different keys', () => {
    const source = image(64, 64);
    const atlas = packIndexedAtlas([{ key: 'sprite-left', image: source }, { key: 'sprite-right', image: source }]);
    expect(atlas.regions.get('sprite-left')).toBe(atlas.regions.get('sprite-right'));
    expect(atlas.pages).toHaveLength(1);
  });

  it('produces deterministic placement regardless of entry order', () => {
    const entries = [{ key: 'small', image: image(64, 64) }, { key: 'tall', image: image(32, 128) }, { key: 'wide', image: image(256, 32) }];
    const forward = packIndexedAtlas(entries);
    const reversed = packIndexedAtlas([...entries].reverse());
    for (const entry of entries) expect(reversed.regions.get(entry.key)).toEqual(forward.regions.get(entry.key));
    expect(reversed.pages[0]?.pixels).toEqual(forward.pages[0]?.pixels);
  });

  it('starts new pages when rectangles with their gutters cannot fit', () => {
    const atlas = packIndexedAtlas([{ key: 'first', image: image(1022, 1022) }, { key: 'second', image: image(1, 1) }]);
    expect(atlas.pages).toHaveLength(2);
    expect(atlas.regions.get('first')?.page).toBe(0);
    expect(atlas.regions.get('second')?.page).toBe(1);
    expect(texel(atlas, 0, 1023, 1023)).toEqual([42, 255]);
  });

  it('packs distinct regions without overlapping their gutters', () => {
    const entries = Array.from({ length: 80 }, (_, index) => ({ key: `image${index}`, image: image(64 + index % 5, 64 + index % 7) }));
    const atlas = packIndexedAtlas(entries);
    const regions = [...atlas.regions.values()];
    for (const [index, first] of regions.entries()) {
      for (const second of regions.slice(index + 1)) {
        if (first.page !== second.page) continue;
        expect(first.x + first.width + 1 <= second.x - 1 || second.x + second.width + 1 <= first.x - 1 ||
          first.y + first.height + 1 <= second.y - 1 || second.y + second.height + 1 <= first.y - 1).toBe(true);
      }
    }
  });

  it('does not allocate any page for an empty atlas', () => {
    expect(packIndexedAtlas([])).toEqual({ pages: [], regions: new Map() });
  });

  it('rejects duplicate or empty keys', () => {
    const source = image(1, 1);
    expect(() => packIndexedAtlas([{ key: '', image: source }])).toThrow(/key/i);
    expect(() => packIndexedAtlas([{ key: 'same', image: source }, { key: 'same', image: source }])).toThrow(/key/i);
  });

  it.each([[0, 1], [1, -1], [0.5, 1], [1023, 1], [1, 1023]])('rejects unsupported %i by %i image rectangles before page allocation', (width, height) => {
    const source = { ...image(1, 1), width, height };
    expect(() => packIndexedAtlas([{ key: 'bad', image: source }])).toThrow(/dimensions|page/i);
  });

  it('rejects inconsistent source image buffers', () => {
    expect(() => packIndexedAtlas([{ key: 'bad', image: image(2, 2, [1]) }])).toThrow(/buffer/i);
    expect(() => packIndexedAtlas([{ key: 'bad', image: image(2, 2, [1, 2, 3, 4], [255]) }])).toThrow(/buffer/i);
  });

  it('bounds total page allocation before creating GPU-sized buffers', () => {
    const entries = Array.from({ length: 33 }, (_, index) => ({ key: `page${index}`, image: image(1022, 1022) }));
    expect(() => packIndexedAtlas(entries)).toThrow(/allocation|page.*limit/i);
  });
});
