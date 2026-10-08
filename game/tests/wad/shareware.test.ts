import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findLump, mapLumps, parseWad, readLump } from '../../src/wad/archive';

const bytes = readFileSync(new URL('../../assets/doom1.wad', import.meta.url));

describe('original shareware IWAD', () => {
  it('preserves the unmodified id Software distribution', () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771');
  });

  it('reads every map directory and the complete palette collection', () => {
    const wad = parseWad(bytes);
    expect(wad.kind).toBe('IWAD');
    for (let map = 1; map <= 9; map++) {
      expect(mapLumps(wad, `E1M${map}`).size).toBe(10);
    }
    const palette = findLump(wad, 'PLAYPAL');
    if (!palette) throw new Error('IWAD palettes missing');
    expect(readLump(wad, palette).length).toBe(14 * 256 * 3);
  });
});
