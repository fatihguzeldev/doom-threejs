import { describe, expect, it } from 'vitest';
import { decodeFlat, decodePalette, decodePatch } from '../../src/wad/graphics';

function patch(
  width: number,
  height: number,
  columns: readonly (readonly number[])[],
  leftOffset = 0,
  topOffset = 0,
): Uint8Array {
  const headerSize = 8 + width * 4;
  const bytes = new Uint8Array(headerSize + columns.reduce((size, column) => size + column.length, 0));
  const view = new DataView(bytes.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  view.setInt16(4, leftOffset, true);
  view.setInt16(6, topOffset, true);
  let offset = headerSize;
  columns.forEach((column, x) => {
    view.setUint32(8 + x * 4, offset, true);
    bytes.set(column, offset);
    offset += column.length;
  });
  return bytes;
}

describe('decodePatch', () => {
  it('decodes separated column posts into row-major pixels with transparent holes', () => {
    const bytes = patch(2, 4, [
      [1, 2, 0, 255, 17, 0, 255],
      [0, 1, 0, 3, 0, 3, 1, 0, 4, 0, 255],
    ], -5, 7);
    const image = decodePatch(bytes);
    expect([image.width, image.height, image.leftOffset, image.topOffset]).toEqual([2, 4, -5, 7]);
    expect([...image.pixels]).toEqual([0, 3, 255, 0, 17, 0, 0, 4]);
    expect([...image.alpha]).toEqual([0, 255, 255, 0, 255, 0, 0, 255]);
  });

  it('keeps palette index 255 opaque when it occurs inside pixel data', () => {
    const image = decodePatch(patch(1, 2, [[0, 2, 88, 255, 0, 77, 255]], -32768, 32767));
    expect([...image.pixels]).toEqual([255, 0]);
    expect([...image.alpha]).toEqual([255, 255]);
    expect([image.leftOffset, image.topOffset]).toEqual([-32768, 32767]);
  });

  it('accepts an empty transparent column and a post ending exactly at image height', () => {
    const image = decodePatch(patch(2, 3, [[255], [2, 1, 0, 9, 0, 255]]));
    expect([...image.pixels]).toEqual([0, 0, 0, 0, 0, 9]);
    expect([...image.alpha]).toEqual([0, 0, 0, 0, 0, 255]);
  });

  it('accepts shared column offsets without duplicating or losing pixels', () => {
    const bytes = patch(2, 2, [[0, 2, 0, 6, 7, 0, 255], [255]]);
    new DataView(bytes.buffer).setUint32(12, 16, true);
    const image = decodePatch(bytes);
    expect([...image.pixels]).toEqual([6, 6, 7, 7]);
    expect([...image.alpha]).toEqual([255, 255, 255, 255]);
  });

  it('reads a patch from an unaligned byte view and owns its decoded pixels', () => {
    const bytes = patch(1, 1, [[0, 1, 0, 42, 0, 255]]);
    const storage = new Uint8Array(bytes.length + 5);
    storage.set(bytes, 3);
    const view = storage.subarray(3, 3 + bytes.length);
    const image = decodePatch(view);
    view.fill(0);
    expect([...image.pixels]).toEqual([42]);
    expect([...image.alpha]).toEqual([255]);
  });

  it('accepts a zero-length post with its two padding bytes', () => {
    const image = decodePatch(patch(1, 2, [[0, 0, 14, 15, 1, 1, 0, 8, 0, 255]]));
    expect([...image.pixels]).toEqual([0, 8]);
    expect([...image.alpha]).toEqual([0, 255]);
  });

  it.each([0, 7])('rejects a truncated %i-byte patch header', (length) => {
    expect(() => decodePatch(new Uint8Array(length))).toThrow(/header/i);
  });

  it.each([[0, 1], [1, 0], [-1, 1], [1, -1]])('rejects invalid dimensions %i by %i', (width, height) => {
    const bytes = patch(1, 1, [[255]]);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, width, true);
    view.setInt16(2, height, true);
    expect(() => decodePatch(bytes)).toThrow(/dimensions/i);
  });

  it('rejects a truncated column offset table', () => {
    const bytes = patch(1, 1, [[255]]);
    new DataView(bytes.buffer).setInt16(0, 2, true);
    expect(() => decodePatch(bytes)).toThrow(/column.*table/i);
  });

  it.each([0, 8, 11, 13, 0xffffffff])('rejects column pointer %i outside column data', (offset) => {
    const bytes = patch(1, 1, [[255]]);
    new DataView(bytes.buffer).setUint32(8, offset, true);
    expect(() => decodePatch(bytes)).toThrow(/column.*offset/i);
  });

  it.each([
    [0],
    [0, 1],
    [0, 2, 0, 7],
    [0, 1, 0, 7],
    [0, 1, 0, 7, 0],
    [0, 0, 0],
  ].map(column => ({ column })))('rejects incomplete post data or a missing column terminator: %j', ({ column }) => {
    expect(() => decodePatch(patch(1, 2, [column]))).toThrow(/column|post|padding|terminator/i);
  });

  it.each([
    [2, 1, 0, 7, 0, 255],
    [1, 2, 0, 7, 8, 0, 255],
  ].map(column => ({ column })))('rejects a post extending beyond image height: %j', ({ column }) => {
    expect(() => decodePatch(patch(1, 2, [column]))).toThrow(/height/i);
  });

  it('rejects enormous dimensions before attempting output allocation', () => {
    const bytes = patch(1, 1, [[255]]);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 32767, true);
    view.setInt16(2, 32767, true);
    expect(() => decodePatch(bytes)).toThrow(/dimensions|allocation/i);
  });

  it('rejects a huge sparse allocation from a small valid column table', () => {
    const width = 2048;
    const headerSize = 8 + width * 4;
    const bytes = new Uint8Array(headerSize + 1);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, width, true);
    view.setInt16(2, 2048, true);
    for (let x = 0; x < width; x++) view.setUint32(8 + x * 4, headerSize, true);
    bytes[headerSize] = 255;
    expect(() => decodePatch(bytes)).toThrow(/allocation/i);
  });
});

describe('decodeFlat', () => {
  it('decodes all 4096 bytes as opaque palette indices without borrowing the input', () => {
    const bytes = new Uint8Array(4096);
    bytes[0] = 255;
    bytes[4095] = 17;
    const image = decodeFlat(bytes);
    bytes.fill(0);
    expect([image.width, image.height, image.leftOffset, image.topOffset]).toEqual([64, 64, 0, 0]);
    expect([image.pixels[0], image.pixels[4095]]).toEqual([255, 17]);
    expect(image.alpha.every(value => value === 255)).toBe(true);
  });

  it.each([0, 4095, 4097])('rejects a %i-byte flat', (length) => {
    expect(() => decodeFlat(new Uint8Array(length))).toThrow(/4096/i);
  });
});

describe('decodePalette', () => {
  it('selects an RGB PLAYPAL palette without mutating or borrowing the source', () => {
    const bytes = new Uint8Array(768 * 3);
    bytes.fill(12, 0, 768);
    bytes.fill(34, 768, 1536);
    bytes.fill(56, 1536);
    const selected = decodePalette(bytes, 1);
    bytes.fill(0);
    expect(selected.length).toBe(768);
    expect(selected.every(value => value === 34)).toBe(true);
  });

  it('defaults to palette zero and preserves all RGB values', () => {
    const bytes = new Uint8Array(768);
    bytes.set([0, 127, 255]);
    expect([...decodePalette(bytes).subarray(0, 3)]).toEqual([0, 127, 255]);
  });

  it.each([0, 767, 769, 1535])('rejects incomplete %i-byte PLAYPAL data', (length) => {
    expect(() => decodePalette(new Uint8Array(length))).toThrow(/palette|768/i);
  });

  it.each([-1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects unavailable palette index %s', (index) => {
    expect(() => decodePalette(new Uint8Array(768), index)).toThrow(/palette.*index/i);
  });
});
