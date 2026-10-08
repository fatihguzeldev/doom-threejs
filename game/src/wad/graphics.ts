export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  readonly leftOffset: number;
  readonly topOffset: number;
  readonly pixels: Uint8Array;
  readonly alpha: Uint8Array;
}

const MAX_PATCH_DIMENSION = 4096;
const MAX_PATCH_PIXELS = 4 * 1024 * 1024;
const SMALL_PATCH_PIXELS = 64 * 1024;
const MAX_PATCH_EXPANSION = 64;
const FLAT_SIZE = 64;
const PALETTE_BYTES = 256 * 3;

type PostVisitor = (top: number, pixelOffset: number, length: number) => void;

function visitColumn(
  view: DataView,
  height: number,
  columnOffset: number,
  visit?: PostVisitor,
  account?: (bytes: number) => void,
): void {
  let cursor = columnOffset;
  for (;;) {
    if (cursor >= view.byteLength) throw new Error('Doom patch column has no terminator');
    const top = view.getUint8(cursor);
    if (top === 255) {
      account?.(1);
      return;
    }
    if (cursor + 3 > view.byteLength) throw new Error('Doom patch post header is truncated');
    const length = view.getUint8(cursor + 1);
    const pixelOffset = cursor + 3;
    const pixelEnd = pixelOffset + length;
    if (pixelEnd >= view.byteLength) throw new Error('Doom patch post pixels or trailing padding are truncated');
    if (top + length > height) throw new Error('Doom patch post exceeds image height');
    account?.(length + 4);
    visit?.(top, pixelOffset, length);
    cursor = pixelEnd + 1;
  }
}

export function decodePatch(bytes: Uint8Array): IndexedImage {
  if (bytes.byteLength < 8) throw new Error('Doom patch header is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt16(0, true);
  const height = view.getInt16(2, true);
  if (width <= 0 || height <= 0 || width > MAX_PATCH_DIMENSION || height > MAX_PATCH_DIMENSION) {
    throw new Error('Doom patch dimensions are outside supported limits');
  }
  const pixelCount = width * height;
  const allocationLimit = Math.min(MAX_PATCH_PIXELS, Math.max(SMALL_PATCH_PIXELS, bytes.byteLength * MAX_PATCH_EXPANSION));
  if (pixelCount > allocationLimit) throw new Error('Doom patch allocation exceeds image or file expansion limits');
  const columnDataStart = 8 + width * 4;
  if (columnDataStart > bytes.byteLength) throw new Error('Doom patch column offset table is truncated');

  // Columns may share a stream. Validate each unique stream before allocating output.
  const firstColumns = new Map<number, number>();
  let scannedBytes = 0;
  const scanLimit = Math.min(32 * 1024 * 1024, Math.max(bytes.byteLength * 4, pixelCount * 6));
  const account = (count: number): void => {
    scannedBytes += count;
    if (scannedBytes > scanLimit) throw new Error('Doom patch column data exceeds decoding work limits');
  };
  for (let x = 0; x < width; x++) {
    const offset = view.getUint32(8 + x * 4, true);
    if (offset < columnDataStart || offset >= bytes.byteLength) throw new Error('Doom patch column offset is outside column data');
    if (!firstColumns.has(offset)) {
      visitColumn(view, height, offset, undefined, account);
      firstColumns.set(offset, x);
    }
  }

  const pixels = new Uint8Array(pixelCount);
  const alpha = new Uint8Array(pixelCount);
  for (const [offset, x] of firstColumns) {
    visitColumn(view, height, offset, (top, pixelOffset, length) => {
      for (let y = 0; y < length; y++) {
        const index = (top + y) * width + x;
        pixels[index] = view.getUint8(pixelOffset + y);
        alpha[index] = 255;
      }
    });
  }
  const pixelView = new DataView(pixels.buffer);
  const alphaView = new DataView(alpha.buffer);
  for (let x = 0; x < width; x++) {
    const offset = view.getUint32(8 + x * 4, true);
    const firstX = firstColumns.get(offset);
    if (firstX === undefined) throw new Error('Doom patch column was not validated');
    if (firstX === x) continue;
    for (let y = 0; y < height; y++) {
      const source = y * width + firstX;
      const target = y * width + x;
      pixels[target] = pixelView.getUint8(source);
      alpha[target] = alphaView.getUint8(source);
    }
  }

  return {
    width,
    height,
    leftOffset: view.getInt16(4, true),
    topOffset: view.getInt16(6, true),
    pixels,
    alpha,
  };
}

export function decodeFlat(bytes: Uint8Array): IndexedImage {
  const pixelCount = FLAT_SIZE * FLAT_SIZE;
  if (bytes.byteLength !== pixelCount) throw new Error('Doom flat must contain exactly 4096 palette indices');
  return {
    width: FLAT_SIZE,
    height: FLAT_SIZE,
    leftOffset: 0,
    topOffset: 0,
    pixels: bytes.slice(),
    alpha: new Uint8Array(pixelCount).fill(255),
  };
}

export function decodePalette(bytes: Uint8Array, index = 0): Uint8Array {
  if (bytes.byteLength === 0 || bytes.byteLength % PALETTE_BYTES !== 0) {
    throw new Error('Doom PLAYPAL must contain complete 768-byte RGB palettes');
  }
  if (!Number.isInteger(index) || index < 0 || index >= bytes.byteLength / PALETTE_BYTES) {
    throw new Error('Doom palette index is unavailable');
  }
  const start = index * PALETTE_BYTES;
  return bytes.slice(start, start + PALETTE_BYTES);
}
