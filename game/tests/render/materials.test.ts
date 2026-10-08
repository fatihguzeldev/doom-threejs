import { describe, expect, it } from 'vitest';
import { RGBAFormat, NearestFilter, NoColorSpace } from 'three';
import { createNativeMaterials } from '../../src/render/materials';
import { packIndexedAtlas } from '../../src/render/atlas';

describe('WebGL2 indexed material uploads', () => {
  it('expands all native RGB palettes into WebGL2-compatible RGBA storage without changing colors', () => {
    const palettes = Uint8Array.from({ length: 14 * 256 * 3 }, (_, index) => index % 251);
    const colormaps = new Uint8Array(34 * 256);
    const atlas = packIndexedAtlas([{ key: 'patch', image: {
      width: 1, height: 1, leftOffset: 0, topOffset: 0, pixels: new Uint8Array([255]), alpha: new Uint8Array([255]),
    } }]);
    const materials = createNativeMaterials(atlas, { palettes, colormaps });
    expect(materials.paletteTexture.format).toBe(RGBAFormat);
    expect(materials.paletteTexture.colorSpace).toBe(NoColorSpace);
    expect(materials.paletteTexture.minFilter).toBe(NearestFilter);
    const upload = materials.paletteTexture.image.data;
    expect(upload).toBeInstanceOf(Uint8Array);
    if (!(upload instanceof Uint8Array)) throw new Error('Palette must upload unsigned RGBA bytes');
    expect(upload.length).toBe(14 * 256 * 4);
    for (let color = 0; color < 14 * 256; color++) {
      expect(Array.from(upload.slice(color * 4, color * 4 + 4))).toEqual([
        palettes[color * 3], palettes[color * 3 + 1], palettes[color * 3 + 2], 255,
      ]);
    }
    expect(materials.colormapTexture.image.data).toBe(colormaps);
    expect(materials.atlasTextures[0]?.image.data).toBe(atlas.pages[0]?.pixels);
    materials.dispose(); materials.dispose();
  });
});
