import type { IndexedImage } from './graphics';

export interface TexturePatch {
  readonly originX: number;
  readonly originY: number;
  readonly patch: number;
}

export interface TextureDefinition {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly patches: readonly TexturePatch[];
}

const NAME_BYTES = 8;
const TEXTURE_HEADER_BYTES = 22;
const TEXTURE_PATCH_BYTES = 10;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_TEXTURE_DEFINITIONS = 65536;
const MAX_TEXTURE_PATCH_RECORDS = 65536;
const MAX_COMPOSITION_PIXELS = 64 * 1024 * 1024;

function readName(view: DataView, offset: number, context: string): string {
  let name = '';
  for (let index = 0; index < NAME_BYTES; index++) {
    const value = view.getUint8(offset + index);
    if (value === 0) break;
    if (value < 0x20 || value > 0x7e) throw new Error(`${context} name must be printable ASCII`);
    name += String.fromCharCode(value);
  }
  if (name.length === 0) throw new Error(`${context} name is empty`);
  return name;
}

function imagePixelCount(width: number, height: number, context: string): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`${context} dimensions are outside supported limits`);
  }
  const count = width * height;
  if (count > MAX_IMAGE_PIXELS) throw new Error(`${context} allocation exceeds image limits`);
  return count;
}

export function parsePatchNames(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength < 4) throw new Error('PNAMES header is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > Math.floor((bytes.byteLength - 4) / NAME_BYTES)) throw new Error('PNAMES name table is truncated');
  const names: string[] = [];
  for (let index = 0; index < count; index++) names.push(readName(view, 4 + index * NAME_BYTES, `PNAMES patch ${index}`));
  return names;
}

export function parseTextureDefinitions(bytes: Uint8Array): readonly TextureDefinition[] {
  if (bytes.byteLength < 4) throw new Error('Texture directory header is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > Math.floor((bytes.byteLength - 4) / 4)) throw new Error('Texture offset table is truncated');
  if (count > MAX_TEXTURE_DEFINITIONS) throw new Error('Texture definition allocation exceeds decoding limits');
  const recordsStart = 4 + count * 4;
  const definitions: TextureDefinition[] = [];
  let totalPatchRecords = 0;
  for (let index = 0; index < count; index++) {
    const offset = view.getUint32(4 + index * 4, true);
    if (offset < recordsStart || offset > bytes.byteLength - TEXTURE_HEADER_BYTES) {
      throw new Error(`Texture ${index} record offset is outside texture data`);
    }
    const name = readName(view, offset, `Texture ${index}`);
    // The four-byte masked flag and obsolete column directory are not image data.
    const width = view.getInt16(offset + 12, true);
    const height = view.getInt16(offset + 14, true);
    imagePixelCount(width, height, `Texture ${name}`);
    const patchCount = view.getInt16(offset + 20, true);
    if (patchCount < 0) throw new Error(`Texture ${name} patch count is negative`);
    const patchesStart = offset + TEXTURE_HEADER_BYTES;
    if (patchCount > Math.floor((bytes.byteLength - patchesStart) / TEXTURE_PATCH_BYTES)) {
      throw new Error(`Texture ${name} patch records are truncated`);
    }
    // Repeated offsets can expand the same small source record many times.
    totalPatchRecords += patchCount;
    if (totalPatchRecords > MAX_TEXTURE_PATCH_RECORDS) throw new Error('Texture patch allocation exceeds decoding work limits');
    const patches: TexturePatch[] = [];
    for (let patchIndex = 0; patchIndex < patchCount; patchIndex++) {
      const entry = patchesStart + patchIndex * TEXTURE_PATCH_BYTES;
      const patch = view.getInt16(entry + 4, true);
      if (patch < 0) throw new Error(`Texture ${name} patch index is negative`);
      patches.push({
        originX: view.getInt16(entry, true),
        originY: view.getInt16(entry + 2, true),
        patch,
      });
    }
    definitions.push({ name, width, height, patches });
  }
  return definitions;
}

interface ClippedPatch {
  readonly image: IndexedImage;
  readonly originX: number;
  readonly originY: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function composeTexture(
  definition: TextureDefinition,
  patchNames: readonly string[],
  resolvePatch: (name: string) => IndexedImage,
): IndexedImage {
  const { width, height, name } = definition;
  const pixelCount = imagePixelCount(width, height, `Texture ${name}`);
  if (definition.patches.length > 32767) throw new Error(`Texture ${name} patch count exceeds format limits`);
  const prepared: ClippedPatch[] = [];
  let compositionPixels = 0;
  let sourcePixels = 0;
  for (const patch of definition.patches) {
    if (!Number.isInteger(patch.patch) || patch.patch < 0 || patch.patch >= patchNames.length) {
      throw new Error(`Texture ${name} patch index is outside PNAMES`);
    }
    const patchName = patchNames[patch.patch];
    if (patchName === undefined || patchName.length === 0) throw new Error(`Texture ${name} patch index has no PNAMES name`);
    if (!Number.isInteger(patch.originX) || !Number.isInteger(patch.originY) ||
        patch.originX < -32768 || patch.originX > 32767 || patch.originY < -32768 || patch.originY > 32767) {
      throw new Error(`Texture ${name} patch origin is outside signed-short limits`);
    }
    const image = resolvePatch(patchName);
    const patchPixels = imagePixelCount(image.width, image.height, `Texture ${name} patch ${patchName}`);
    if (image.pixels.byteLength !== patchPixels || image.alpha.byteLength !== patchPixels) {
      throw new Error(`Texture ${name} patch ${patchName} pixels or alpha buffer does not match its dimensions`);
    }
    sourcePixels += patchPixels;
    if (sourcePixels > MAX_COMPOSITION_PIXELS) throw new Error(`Texture ${name} source images exceed decoding work limits`);
    const left = Math.max(0, patch.originX);
    const top = Math.max(0, patch.originY);
    const right = Math.min(width, patch.originX + image.width);
    const bottom = Math.min(height, patch.originY + image.height);
    if (right <= left || bottom <= top) continue;
    compositionPixels += Math.max(0, right - left) * Math.max(0, bottom - top);
    if (compositionPixels > MAX_COMPOSITION_PIXELS) throw new Error(`Texture ${name} composition exceeds decoding work limits`);
    prepared.push({ image, originX: patch.originX, originY: patch.originY, left, top, right, bottom });
  }

  const pixels = new Uint8Array(pixelCount);
  const alpha = new Uint8Array(pixelCount);
  for (const patch of prepared) {
    const sourcePixels = new DataView(patch.image.pixels.buffer, patch.image.pixels.byteOffset, patch.image.pixels.byteLength);
    const sourceAlpha = new DataView(patch.image.alpha.buffer, patch.image.alpha.byteOffset, patch.image.alpha.byteLength);
    for (let y = patch.top; y < patch.bottom; y++) {
      for (let x = patch.left; x < patch.right; x++) {
        // Texture origins place raw patch pixels; sprite left/top offsets do not apply.
        const source = (y - patch.originY) * patch.image.width + x - patch.originX;
        const opacity = sourceAlpha.getUint8(source);
        if (opacity === 0) continue;
        const target = y * width + x;
        pixels[target] = sourcePixels.getUint8(source);
        alpha[target] = opacity;
      }
    }
  }
  return { width, height, leftOffset: 0, topOffset: 0, pixels, alpha };
}
