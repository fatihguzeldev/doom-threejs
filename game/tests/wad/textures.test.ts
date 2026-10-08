import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findLump, parseWad, readLump } from '../../src/wad/archive';
import { decodePatch } from '../../src/wad/graphics';
import type { IndexedImage } from '../../src/wad/graphics';
import { composeTexture, parsePatchNames, parseTextureDefinitions } from '../../src/wad/textures';
import type { TextureDefinition, TexturePatch } from '../../src/wad/textures';

function patchNamesLump(names: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(4 + names.length * 8);
  new DataView(bytes.buffer).setUint32(0, names.length, true);
  names.forEach((name, index) => bytes.set(new TextEncoder().encode(name).subarray(0, 8), 4 + index * 8));
  return bytes;
}

function textureLump(definitions: readonly TextureDefinition[]): Uint8Array {
  const tableSize = 4 + definitions.length * 4;
  const bytes = new Uint8Array(tableSize + definitions.reduce((size, definition) => size + 22 + definition.patches.length * 10, 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, definitions.length, true);
  let offset = tableSize;
  definitions.forEach((definition, index) => {
    view.setUint32(4 + index * 4, offset, true);
    bytes.set(new TextEncoder().encode(definition.name).subarray(0, 8), offset);
    view.setUint32(offset + 8, 0x12345678, true);
    view.setInt16(offset + 12, definition.width, true);
    view.setInt16(offset + 14, definition.height, true);
    view.setUint32(offset + 16, 0x87654321, true);
    view.setInt16(offset + 20, definition.patches.length, true);
    definition.patches.forEach((patch, patchIndex) => {
      const entry = offset + 22 + patchIndex * 10;
      view.setInt16(entry, patch.originX, true);
      view.setInt16(entry + 2, patch.originY, true);
      view.setInt16(entry + 4, patch.patch, true);
      view.setInt16(entry + 6, -1234, true);
      view.setInt16(entry + 8, 1234, true);
    });
    offset += 22 + definition.patches.length * 10;
  });
  return bytes;
}

function definition(width = 2, height = 2, patches: readonly TexturePatch[] = [{ originX: 0, originY: 0, patch: 0 }]): TextureDefinition {
  return { name: 'WALL', width, height, patches };
}

function image(width: number, height: number, pixels: readonly number[], alpha?: readonly number[]): IndexedImage {
  return {
    width, height, leftOffset: 91, topOffset: -47,
    pixels: new Uint8Array(pixels),
    alpha: alpha ? new Uint8Array(alpha) : new Uint8Array(width * height).fill(255),
  };
}

describe('parsePatchNames', () => {
  it('reads the PNAMES count and fixed eight-byte names in source order', () => {
    expect(parsePatchNames(patchNamesLump(['PATCHA', 'ABCDEFGH']))).toEqual(['PATCHA', 'ABCDEFGH']);
  });

  it('accepts zero names and ignores unused bytes after a name terminator', () => {
    expect(parsePatchNames(patchNamesLump([]))).toEqual([]);
    const bytes = patchNamesLump(['A']);
    bytes[11] = 255;
    expect(parsePatchNames(bytes)).toEqual(['A']);
  });

  it('reads an unaligned byte view without reading the surrounding buffer', () => {
    const bytes = patchNamesLump(['PATCH']);
    const storage = new Uint8Array(bytes.length + 7);
    storage.set(bytes, 3);
    expect(parsePatchNames(storage.subarray(3, 3 + bytes.length))).toEqual(['PATCH']);
  });

  it.each([0, 3])('rejects a truncated %i-byte PNAMES header', (length) => {
    expect(() => parsePatchNames(new Uint8Array(length))).toThrow(/PNAMES.*header/i);
  });

  it('rejects a truncated name table and a huge count without arithmetic wrapping', () => {
    const bytes = patchNamesLump(['PATCH']);
    expect(() => parsePatchNames(bytes.subarray(0, bytes.length - 1))).toThrow(/PNAMES.*table/i);
    new DataView(bytes.buffer).setUint32(0, 0x20000000, true);
    expect(() => parsePatchNames(bytes)).toThrow(/PNAMES.*table/i);
  });

  it.each(['', '\u007f', '\u001f'])('rejects an invalid patch name %j', (name) => {
    expect(() => parsePatchNames(patchNamesLump([name]))).toThrow(/name/i);
  });
});

describe('parseTextureDefinitions', () => {
  it('reads signed patch origins and ignores obsolete masked, column, step and colormap fields', () => {
    const expected: TextureDefinition[] = [{
      name: 'ABCDEFGH', width: 128, height: 72,
      patches: [{ originX: -17, originY: 24, patch: 7 }, { originX: 45, originY: -6, patch: 2 }],
    }];
    expect(parseTextureDefinitions(textureLump(expected))).toEqual(expected);
  });

  it('uses the offset table rather than assuming sequential texture records', () => {
    const first = { ...definition(16, 32), name: 'FIRST' };
    const second = { ...definition(64, 128), name: 'SECOND' };
    const bytes = textureLump([first, second]);
    const view = new DataView(bytes.buffer);
    const firstOffset = view.getUint32(4, true);
    view.setUint32(4, view.getUint32(8, true), true);
    view.setUint32(8, firstOffset, true);
    expect(parseTextureDefinitions(bytes)).toEqual([second, first]);
  });

  it('accepts an empty table and a texture with no patches', () => {
    expect(parseTextureDefinitions(textureLump([]))).toEqual([]);
    expect(parseTextureDefinitions(textureLump([definition(2, 2, [])]))).toEqual([definition(2, 2, [])]);
  });

  it('reads texture records from an unaligned byte view', () => {
    const expected = definition();
    const bytes = textureLump([expected]);
    const storage = new Uint8Array(bytes.length + 2);
    storage.set(bytes, 1);
    expect(parseTextureDefinitions(storage.subarray(1, 1 + bytes.length))).toEqual([expected]);
  });

  it.each([0, 3])('rejects a truncated %i-byte texture header', (length) => {
    expect(() => parseTextureDefinitions(new Uint8Array(length))).toThrow(/texture.*header/i);
  });

  it('rejects a truncated offset table or a huge texture count', () => {
    const bytes = textureLump([definition()]);
    expect(() => parseTextureDefinitions(bytes.subarray(0, 7))).toThrow(/texture.*table/i);
    new DataView(bytes.buffer).setUint32(0, 0x40000000, true);
    expect(() => parseTextureDefinitions(bytes)).toThrow(/texture.*table/i);
  });

  it.each([0, 4, 7, 0xffffffff])('rejects texture record offset %i outside record data', (offset) => {
    const bytes = textureLump([definition()]);
    new DataView(bytes.buffer).setUint32(4, offset, true);
    expect(() => parseTextureDefinitions(bytes)).toThrow(/texture.*offset|record/i);
  });

  it('rejects truncated maptexture headers and ten-byte patch records', () => {
    const bytes = textureLump([definition()]);
    expect(() => parseTextureDefinitions(bytes.subarray(0, 8 + 21))).toThrow(/texture.*record/i);
    expect(() => parseTextureDefinitions(bytes.subarray(0, bytes.length - 1))).toThrow(/patch.*record/i);
  });

  it.each([[0, 2], [2, 0], [-1, 2], [4096, 4096]])('rejects invalid texture dimensions %i by %i', (width, height) => {
    expect(() => parseTextureDefinitions(textureLump([definition(width, height)]))).toThrow(/dimensions|allocation/i);
  });

  it('rejects a negative patch count or patch index', () => {
    const bytes = textureLump([definition()]);
    const view = new DataView(bytes.buffer);
    view.setInt16(8 + 20, -1, true);
    expect(() => parseTextureDefinitions(bytes)).toThrow(/patch.*count/i);
    view.setInt16(8 + 20, 1, true);
    view.setInt16(8 + 22 + 4, -1, true);
    expect(() => parseTextureDefinitions(bytes)).toThrow(/patch.*index/i);
  });

  it('rejects an invalid texture name', () => {
    const bytes = textureLump([definition()]);
    bytes[8] = 255;
    expect(() => parseTextureDefinitions(bytes)).toThrow(/texture.*name/i);
  });

  it('bounds aggregate patch allocations when repeated offsets amplify a small source', () => {
    const patchCount = 32767;
    const bytes = new Uint8Array(16 + 22 + patchCount * 10);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 3, true);
    for (const offset of [4, 8, 12]) view.setUint32(offset, 16, true);
    bytes.set(new TextEncoder().encode('WALL'), 16);
    view.setInt16(16 + 12, 1, true);
    view.setInt16(16 + 14, 1, true);
    view.setInt16(16 + 20, patchCount, true);
    expect(() => parseTextureDefinitions(bytes)).toThrow(/work|allocation/i);
  });
});

describe('composeTexture', () => {
  it('layers patches in definition order while transparent holes preserve underlying pixels', () => {
    const bottom = image(2, 2, [3, 4, 5, 6]);
    const top = image(2, 2, [7, 255, 0, 8], [255, 255, 0, 255]);
    const texture = composeTexture(definition(2, 2, [
      { originX: 0, originY: 0, patch: 0 },
      { originX: 0, originY: 0, patch: 1 },
    ]), ['BOTTOM', 'TOP'], name => name === 'BOTTOM' ? bottom : top);
    expect([...texture.pixels]).toEqual([7, 255, 5, 8]);
    expect([...texture.alpha]).toEqual([255, 255, 255, 255]);
    expect([texture.leftOffset, texture.topOffset]).toEqual([0, 0]);
    expect([...bottom.pixels]).toEqual([3, 4, 5, 6]);
  });

  it('clips negative origins and the right and bottom edges to the texture dimensions', () => {
    const source = image(4, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const texture = composeTexture(definition(3, 2, [{ originX: -1, originY: -1, patch: 0 }]), ['PATCH'], () => source);
    expect([...texture.pixels]).toEqual([6, 7, 8, 10, 11, 12]);
    expect([...texture.alpha]).toEqual([255, 255, 255, 255, 255, 255]);
  });

  it('uses texture origins independently of the patch left and top sprite offsets', () => {
    const texture = composeTexture(definition(3, 2, [{ originX: 1, originY: 1, patch: 0 }]), ['PATCH'], () => image(1, 1, [255]));
    expect([...texture.pixels]).toEqual([0, 0, 0, 0, 255, 0]);
    expect([...texture.alpha]).toEqual([0, 0, 0, 0, 255, 0]);
  });

  it('does not require unused PNAMES entries to exist', () => {
    const texture = composeTexture(definition(1, 1, [{ originX: 0, originY: 0, patch: 1 }]), ['ABSENT', 'PRESENT'], name => {
      if (name !== 'PRESENT') throw new Error('Unused patch must not be loaded');
      return image(1, 1, [42]);
    });
    expect([...texture.pixels]).toEqual([42]);
  });

  it('reports a missing patch when its PNAMES entry is actually referenced', () => {
    expect(() => composeTexture(definition(1, 1), ['ABSENT'], name => {
      throw new Error(`Missing referenced patch ${name}`);
    })).toThrow('Missing referenced patch ABSENT');
  });

  it('leaves uncovered texels transparent, including when patches are entirely offscreen', () => {
    const texture = composeTexture(definition(2, 2, [{ originX: 2, originY: -5, patch: 0 }]), ['PATCH'], () => image(1, 1, [42]));
    expect([...texture.pixels]).toEqual([0, 0, 0, 0]);
    expect([...texture.alpha]).toEqual([0, 0, 0, 0]);
    expect(composeTexture(definition(2, 2, []), [], () => { throw new Error('No patch referenced'); }).alpha.every(value => value === 0)).toBe(true);
  });

  it('does not borrow source buffers', () => {
    const source = image(1, 1, [17]);
    const texture = composeTexture(definition(1, 1), ['PATCH'], () => source);
    source.pixels.fill(0);
    source.alpha.fill(0);
    expect([...texture.pixels]).toEqual([17]);
    expect([...texture.alpha]).toEqual([255]);
  });

  it.each([-1, 1, 0.5, Number.POSITIVE_INFINITY])('rejects invalid referenced patch index %s', (patch) => {
    expect(() => composeTexture(definition(1, 1, [{ originX: 0, originY: 0, patch }]), ['PATCH'], () => image(1, 1, [0]))).toThrow(/patch.*index/i);
  });

  it.each([Number.NaN, 0.5, 32768])('rejects invalid patch origin %s', (originX) => {
    expect(() => composeTexture(definition(1, 1, [{ originX, originY: 0, patch: 0 }]), ['PATCH'], () => image(1, 1, [0]))).toThrow(/origin/i);
  });

  it('rejects invalid caller-provided texture dimensions before allocating', () => {
    expect(() => composeTexture(definition(4096, 4096), ['PATCH'], () => image(1, 1, [0]))).toThrow(/allocation/i);
    expect(() => composeTexture(definition(0.5, 1), ['PATCH'], () => image(1, 1, [0]))).toThrow(/dimensions/i);
  });

  it('rejects a resolved patch whose pixels or alpha do not match its dimensions', () => {
    expect(() => composeTexture(definition(), ['PATCH'], () => image(2, 2, [1]))).toThrow(/patch.*buffer|pixels/i);
    expect(() => composeTexture(definition(), ['PATCH'], () => image(2, 2, [1, 2, 3, 4], [255]))).toThrow(/patch.*buffer|alpha/i);
  });

  it('bounds retained source images even when only one texel of each patch is visible', () => {
    const source: IndexedImage = {
      width: 2048, height: 2048, leftOffset: 0, topOffset: 0,
      pixels: new Uint8Array(2048 * 2048),
      alpha: new Uint8Array(2048 * 2048).fill(255),
    };
    const patches = Array.from({ length: 17 }, () => ({ originX: -2047, originY: -2047, patch: 0 }));
    expect(() => composeTexture(definition(1, 1, patches), ['PATCH'], () => source)).toThrow(/source|work/i);
  });
});

describe('shareware texture definitions and composition', () => {
  it('composes all 125 original wall textures while leaving absent unused PNAMES entries alone', () => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const pnames = findLump(wad, 'PNAMES');
    const texture1 = findLump(wad, 'TEXTURE1');
    if (!pnames || !texture1) throw new Error('Shareware texture resources missing');
    const names = parsePatchNames(readLump(wad, pnames));
    const definitions = parseTextureDefinitions(readLump(wad, texture1));
    const resolve = (name: string): IndexedImage => {
      const lump = findLump(wad, name);
      if (!lump) throw new Error(`Missing referenced patch ${name}`);
      return decodePatch(readLump(wad, lump));
    };
    expect(names.some(name => !findLump(wad, name))).toBe(true);
    expect(definitions.length).toBe(125);
    for (const textureDefinition of definitions) {
      const texture = composeTexture(textureDefinition, names, resolve);
      expect(texture.pixels.length).toBe(textureDefinition.width * textureDefinition.height);
      expect(texture.alpha.some(value => value === 255)).toBe(true);
    }
    const door = definitions.find(texture => texture.name === 'BIGDOOR2');
    if (!door) throw new Error('BIGDOOR2 missing');
    const composedDoor = composeTexture(door, names, resolve);
    const sourceDoor = resolve('DOOR2_4');
    expect(composedDoor.pixels).toEqual(sourceDoor.pixels);
    expect(composedDoor.alpha).toEqual(sourceDoor.alpha);
  });
});
