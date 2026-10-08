import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SpriteId } from '../../src/simulation/data/states';
import { findLump, parseWad, readLump } from '../../src/wad/archive';
import type { WadArchive, WadLump } from '../../src/wad/archive';
import { createResources } from '../../src/wad/resources';

interface LumpFixture {
  readonly name: string;
  readonly data?: Uint8Array;
}

function archive(lumps: readonly LumpFixture[]): WadArchive {
  const bytes = new Uint8Array(lumps.reduce((size, lump) => size + (lump.data?.length ?? 0), 0));
  const entries: WadLump[] = [];
  let offset = 0;
  for (const lump of lumps) {
    const data = lump.data ?? new Uint8Array();
    bytes.set(data, offset);
    entries.push({ name: lump.name, offset, size: data.length });
    offset += data.length;
  }
  return { kind: 'IWAD', bytes, lumps: entries };
}

function patch(values: readonly number[]): Uint8Array {
  const width = values.length;
  const dataStart = 8 + width * 4;
  const bytes = new Uint8Array(dataStart + width * 6);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, 1, true);
  view.setInt16(4, -7, true);
  view.setInt16(6, 12, true);
  values.forEach((value, index) => {
    const offset = dataStart + index * 6;
    view.setUint32(8 + index * 4, offset, true);
    bytes.set([0, 1, 0, value, 0, 255], offset);
  });
  return bytes;
}

function patchNames(names: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(4 + names.length * 8);
  new DataView(bytes.buffer).setUint32(0, names.length, true);
  names.forEach((name, index) => bytes.set(new TextEncoder().encode(name), 4 + index * 8));
  return bytes;
}

function wall(name: string, patchIndex = 0): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 8, true);
  bytes.set(new TextEncoder().encode(name), 8);
  view.setInt16(8 + 12, 2, true);
  view.setInt16(8 + 14, 1, true);
  view.setInt16(8 + 20, 1, true);
  view.setInt16(8 + 22 + 4, patchIndex, true);
  return bytes;
}

function walls(names: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(4 + names.length * 4 + names.length * 32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, names.length, true);
  names.forEach((name, index) => {
    const offset = 4 + names.length * 4 + index * 32;
    view.setUint32(4 + index * 4, offset, true);
    bytes.set(wall(name).subarray(8), offset);
  });
  return bytes;
}

function fixture(extra: readonly LumpFixture[] = []): WadArchive {
  return archive([
    { name: 'PLAYPAL', data: Uint8Array.from({ length: 14 * 768 }, (_, index) => index % 256) },
    { name: 'COLORMAP', data: Uint8Array.from({ length: 34 * 256 }, (_, index) => (index + Math.floor(index / 256)) % 256) },
    { name: 'PNAMES', data: patchNames(['PATCH', 'ABSENT']) },
    { name: 'TEXTURE1', data: wall('WALL') },
    { name: 'PATCH', data: patch([10, 255]) },
    ...extra,
  ]);
}

describe('createResources', () => {
  it('preserves all original PLAYPAL palettes and COLORMAP rows as independent buffers', () => {
    const wad = fixture();
    const resources = createResources(wad);
    const playpal = findLump(wad, 'PLAYPAL');
    const colormap = findLump(wad, 'COLORMAP');
    if (!playpal || !colormap) throw new Error('Fixture tables missing');
    expect(resources.palettes).toEqual(readLump(wad, playpal));
    expect(resources.colormaps).toEqual(readLump(wad, colormap));
    readLump(wad, playpal).fill(0);
    readLump(wad, colormap).fill(0);
    expect(resources.palettes[1]).toBe(1);
    expect(resources.colormaps[256]).toBe(1);
  });

  it('decodes patches only on request, caches identity and resolves HUD names using the latest entry', () => {
    const wad = fixture([
      { name: 'HUD', data: patch([1, 2]) },
      { name: 'HUD', data: patch([3, 4]) },
      { name: 'BAD', data: new Uint8Array([1]) },
    ]);
    const resources = createResources(wad);
    const lump = findLump(wad, 'HUD');
    if (!lump) throw new Error('Fixture HUD missing');
    const data = readLump(wad, lump);
    data[19] = 42;
    const image = resources.patch('hud');
    expect([...image.pixels]).toEqual([42, 4]);
    expect([image.leftOffset, image.topOffset]).toEqual([-7, 12]);
    data[19] = 99;
    expect(resources.patch('HUD')).toBe(image);
    expect([...image.pixels]).toEqual([42, 4]);
    expect(() => resources.patch('BAD')).toThrow(/BAD.*patch|patch.*BAD/i);
  });

  it('lazily composes walls and leaves absent unused PNAMES entries alone', () => {
    const resources = createResources(fixture());
    const image = resources.wall('wall');
    expect([...image.pixels]).toEqual([10, 255]);
    expect([...image.alpha]).toEqual([255, 255]);
    expect(resources.wall('WALL')).toBe(image);
  });

  it('keeps the native first-name match from TEXTURE1 before TEXTURE2', () => {
    const resources = createResources(fixture([
      { name: 'PNAMES', data: patchNames(['PATCH', 'SECOND']) },
      { name: 'SECOND', data: patch([7, 8]) },
      { name: 'TEXTURE2', data: wall('WALL', 1) },
    ]));
    expect([...resources.wall('WALL').pixels]).toEqual([10, 255]);
  });

  it('queries wall heights and texture-zero height without decoding referenced patches', () => {
    const resources = createResources(fixture([{ name: 'PNAMES', data: patchNames(['ABSENT']) }]));
    expect(resources.textureHeight('wall')).toBe(1);
    expect(resources.textureHeight('-')).toBe(1);
    expect(() => resources.textureHeight('UNKNOWN')).toThrow(/wall.*UNKNOWN/i);
    expect(() => resources.wall('WALL')).toThrow(/ABSENT/i);
  });

  it('animates wall ranges with their absolute original indices, including duplicate prefix names', () => {
    const resources = createResources(fixture([
      { name: 'TEXTURE1', data: walls(['WALL', 'WALL', 'SLADRIP1', 'SLADRIP2', 'SLADRIP3']) },
    ]));
    expect(resources.animatedWall('sladrip1', 0)).toBe('SLADRIP3');
    expect(resources.animatedWall('SLADRIP1', 7)).toBe('SLADRIP3');
    expect(resources.animatedWall('SLADRIP1', 8)).toBe('SLADRIP1');
    expect(resources.animatedWall('SLADRIP2', 8)).toBe('SLADRIP2');
    expect(resources.animatedWall('SLADRIP1', 24)).toBe('SLADRIP3');
    expect(resources.animatedWall('WALL', 999)).toBe('WALL');
  });

  it('retains nested flat marker positions in the native animation phase', () => {
    const resources = createResources(fixture([
      { name: 'F_START' }, { name: 'F1_START' },
      { name: 'NUKAGE1', data: new Uint8Array(4096) },
      { name: 'NUKAGE2', data: new Uint8Array(4096) },
      { name: 'NUKAGE3', data: new Uint8Array(4096) },
      { name: 'F1_END' }, { name: 'F_END' },
    ]));
    expect(resources.animatedFlat('nukage1', 0)).toBe('NUKAGE2');
    expect(resources.animatedFlat('NUKAGE1', 8)).toBe('NUKAGE3');
    expect(resources.animatedFlat('NUKAGE1', 16)).toBe('NUKAGE1');
    expect(resources.flat('NUKAGE1')).toBe(resources.flat('NUKAGE1'));
  });

  it('skips absent animation starts but rejects incomplete native cycles without decoding patches', () => {
    expect(createResources(fixture()).animatedWall('WALL', 8)).toBe('WALL');
    expect(() => createResources(fixture([{ name: 'TEXTURE1', data: wall('SLADRIP1') }]))).toThrow(/animation.*SLADRIP1.*SLADRIP3/i);
  });

  it('reports referenced missing patches when the wall is requested', () => {
    const resources = createResources(fixture([{ name: 'TEXTURE1', data: wall('MISSING', 1) }]));
    expect(() => resources.wall('MISSING')).toThrow(/MISSING.*ABSENT|ABSENT.*MISSING/i);
  });

  it('finds flats only inside their namespace and ignores nested F1 marker names', () => {
    const resources = createResources(fixture([
      { name: 'FLAT1', data: new Uint8Array(4096).fill(2) },
      { name: 'F_START' },
      { name: 'F1_START' },
      { name: 'FLAT1', data: new Uint8Array(4096).fill(7) },
      { name: 'F1_END' },
      { name: 'F_END' },
      { name: 'FLAT1', data: new Uint8Array(4096).fill(99) },
    ]));
    const image = resources.flat('flat1');
    expect(image.width).toBe(64);
    expect(image.height).toBe(64);
    expect(image.pixels.every(value => value === 7)).toBe(true);
    expect(image.alpha.every(value => value === 255)).toBe(true);
    expect(resources.flat('FLAT1')).toBe(image);
    expect(() => resources.flat('F1_START')).toThrow(/flat.*F1_START/i);
  });

  it('uses the latest flat inside multiple complete namespace ranges', () => {
    const resources = createResources(fixture([
      { name: 'F_START' }, { name: 'FLOOR', data: new Uint8Array(4096).fill(3) }, { name: 'F_END' },
      { name: 'F_START' }, { name: 'FLOOR', data: new Uint8Array(4096).fill(4) }, { name: 'F_END' },
    ]));
    expect(resources.flat('FLOOR').pixels[0]).toBe(4);
  });

  it('indexes both frame/rotation pairs, marking the second pair mirrored without copying its image', () => {
    const resources = createResources(fixture([
      { name: 'S_START' },
      { name: 'TROOA1C1', data: patch([3, 4]) },
      { name: 'TROOA2A8', data: patch([5, 6]) },
      { name: 'S_END' },
      { name: 'TROOA1C1', data: patch([99, 99]) },
    ]));
    const first = resources.sprite(SpriteId.SPR_TROO, 0, 1);
    const second = resources.sprite(SpriteId.SPR_TROO, 2, 1);
    expect(first.name).toBe('TROOA1C1');
    expect(first.flip).toBe(false);
    expect(second.flip).toBe(true);
    expect(first.image).toBe(second.image);
    expect([...first.image.pixels]).toEqual([3, 4]);
    expect(resources.sprite(SpriteId.SPR_TROO, 0, 1)).toBe(first);
    expect(resources.sprite(SpriteId.SPR_TROO, 0, 2).flip).toBe(false);
    expect(resources.sprite(SpriteId.SPR_TROO, 0, 8).flip).toBe(true);
    expect(resources.sprite(SpriteId.SPR_TROO, 0, 2).image).toBe(resources.sprite(SpriteId.SPR_TROO, 0, 8).image);
    expect([...resources.patch('TROOA1C1').pixels]).toEqual([99, 99]);
  });

  it('maps rotation zero to every viewing rotation and reuses the patch cache', () => {
    const resources = createResources(fixture([
      { name: 'S_START' }, { name: 'ARM1A0', data: patch([1, 2]) }, { name: 'S_END' },
    ]));
    const first = resources.sprite(SpriteId.SPR_ARM1, 0, 1);
    for (let rotation = 1; rotation <= 8; rotation++) {
      const result = resources.sprite(SpriteId.SPR_ARM1, 0, rotation);
      expect(result).toBe(first);
      expect(result.flip).toBe(false);
    }
    expect(resources.patch('ARM1A0')).toBe(first.image);
  });

  it('supports a mirrored second frame with rotation zero and later sprite lump overrides', () => {
    const resources = createResources(fixture([
      { name: 'S_START' },
      { name: 'TROOA0C0', data: patch([1, 2]) },
      { name: 'TROOA0C0', data: patch([8, 9]) },
      { name: 'S_END' },
    ]));
    const first = resources.sprite(SpriteId.SPR_TROO, 0, 4);
    const second = resources.sprite(SpriteId.SPR_TROO, 2, 7);
    expect([...first.image.pixels]).toEqual([8, 9]);
    expect(first.flip).toBe(false);
    expect(second.flip).toBe(true);
    expect(second.image).toBe(first.image);
  });

  it('enumerates unique raw sprite images across frame and rotation aliases for atlas preload', () => {
    const resources = createResources(fixture([
      { name: 'S_START' },
      { name: 'TROOA0C0', data: patch([1, 2]) },
      { name: 'TROOB2B8', data: patch([3, 4]) },
      { name: 'S_END' },
    ]));
    const frames = resources.spriteFrames(SpriteId.SPR_TROO);
    expect(frames.map(frame => frame.name)).toEqual(['TROOA0C0', 'TROOB2B8']);
    expect(frames.every(frame => frame.flip === false)).toBe(true);
    expect(frames[0]?.image).toBe(resources.sprite(SpriteId.SPR_TROO, 2, 3).image);
    expect(resources.spriteFrames(SpriteId.SPR_TROO)).toBe(frames);
  });

  it('reports missing asset names, frames and rotations without decoding unrelated images', () => {
    const resources = createResources(fixture([
      { name: 'S_START' }, { name: 'TROOA1', data: patch([1, 2]) }, { name: 'S_END' },
    ]));
    expect(() => resources.patch('UNKNOWN')).toThrow(/patch.*UNKNOWN/i);
    expect(() => resources.wall('UNKNOWN')).toThrow(/wall.*UNKNOWN/i);
    expect(() => resources.flat('UNKNOWN')).toThrow(/flat.*UNKNOWN/i);
    expect(() => resources.sprite(SpriteId.SPR_TROO, 1, 1)).toThrow(/sprite.*TROO.*B.*1/i);
    expect(() => resources.sprite(SpriteId.SPR_TROO, 0, 3)).toThrow(/sprite.*TROO.*A.*3/i);
  });

  it.each([-1, 27, 0.5, Number.NaN, 32768])('rejects sprite frame %s outside the decoded frame range', (frame) => {
    expect(() => createResources(fixture()).sprite(SpriteId.SPR_TROO, frame, 1)).toThrow(/frame/i);
  });

  it.each([0, 9, 1.5, Number.NaN])('rejects viewing rotation %s outside 1 through 8', (rotation) => {
    expect(() => createResources(fixture()).sprite(SpriteId.SPR_TROO, 0, rotation)).toThrow(/rotation/i);
  });

  it('rejects the sprite enum sentinel', () => {
    expect(() => createResources(fixture()).sprite(SpriteId.NUMSPRITES, 0, 1)).toThrow(/sprite.*id/i);
  });

  it.each([0, 767, 768, 14 * 768 - 1])('rejects an incomplete original PLAYPAL of %i bytes', (size) => {
    expect(() => createResources(fixture([{ name: 'PLAYPAL', data: new Uint8Array(size) }]))).toThrow(/PLAYPAL/i);
  });

  it.each([0, 255, 33 * 256, 34 * 256 + 1])('rejects a COLORMAP without all 34 complete rows (%i bytes)', (size) => {
    expect(() => createResources(fixture([{ name: 'COLORMAP', data: new Uint8Array(size) }]))).toThrow(/COLORMAP/i);
  });

  it.each(['PLAYPAL', 'COLORMAP', 'PNAMES', 'TEXTURE1'])('reports missing required table %s', (name) => {
    const wad = fixture();
    expect(() => createResources({ ...wad, lumps: wad.lumps.filter(lump => lump.name !== name) })).toThrow(new RegExp(name));
  });
});

describe('original shareware resources', () => {
  it('reuses E1 walls, floors, directional monsters and rotation-zero weapons from the IWAD', () => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const resources = createResources(wad);
    const wallImage = resources.wall('STARTAN3');
    expect([wallImage.width, wallImage.height]).toEqual([128, 128]);
    expect(resources.wall('startan3')).toBe(wallImage);
    expect(resources.flat('FLOOR4_8').pixels.length).toBe(4096);
    expect(resources.flat('FLOOR4_8')).toBe(resources.flat('floor4_8'));
    const right = resources.sprite(SpriteId.SPR_TROO, 0, 2);
    const left = resources.sprite(SpriteId.SPR_TROO, 0, 8);
    expect(right.name).toBe('TROOA2A8');
    expect(right.flip).toBe(false);
    expect(left.flip).toBe(true);
    expect(left.image).toBe(right.image);
    expect(resources.patch('TROOA2A8')).toBe(right.image);
    const weapon = resources.sprite(SpriteId.SPR_SHTG, 0, 1);
    expect(weapon.name).toBe('SHTGA0');
    expect(resources.sprite(SpriteId.SPR_SHTG, 0, 8)).toBe(weapon);
    expect(resources.patch('M_DOOM').alpha.some(value => value === 0)).toBe(true);
  });

  it('translates original SLADRIP and NUKAGE frames at eight-tic intervals', () => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const resources = createResources(wad);
    expect(resources.animatedWall('SLADRIP1', 0)).toBe('SLADRIP2');
    expect(resources.animatedWall('SLADRIP1', 8)).toBe('SLADRIP3');
    expect(resources.animatedWall('SLADRIP1', 16)).toBe('SLADRIP1');
    expect(resources.animatedFlat('NUKAGE1', 0)).toBe('NUKAGE1');
    expect(resources.animatedFlat('NUKAGE1', 8)).toBe('NUKAGE2');
    expect(resources.animatedFlat('NUKAGE1', 16)).toBe('NUKAGE3');
  });
});
