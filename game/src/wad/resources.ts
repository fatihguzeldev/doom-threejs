import { spriteNames } from '../simulation/data/states';
import type { SpriteId } from '../simulation/data/states';
import { readLump } from './archive';
import type { WadArchive, WadLump } from './archive';
import { decodeFlat, decodePatch } from './graphics';
import type { IndexedImage } from './graphics';
import { composeTexture, parsePatchNames, parseTextureDefinitions } from './textures';
import type { TextureDefinition } from './textures';

export interface SpriteResource {
  readonly image: IndexedImage;
  readonly flip: boolean;
  readonly name: string;
}

export interface DoomResources {
  readonly palettes: Uint8Array;
  readonly colormaps: Uint8Array;
  patch(name: string): IndexedImage;
  wall(name: string): IndexedImage;
  flat(name: string): IndexedImage;
  sprite(sprite: SpriteId, frame: number, rotation: number): SpriteResource;
}

interface SpriteSelection {
  readonly lump: WadLump;
  readonly flip: boolean;
}

function namespaceLumps(wad: WadArchive, prefix: 'F' | 'S'): readonly WadLump[] {
  const result: WadLump[] = [];
  const nestedMarker = new RegExp(`^${prefix}[0-9]*_(START|END)$`);
  let inside = false;
  for (const lump of wad.lumps) {
    const name = lump.name.toUpperCase();
    if (name === `${prefix}_START`) inside = true;
    else if (name === `${prefix}_END`) inside = false;
    else if (inside && !nestedMarker.test(name)) result.push(lump);
  }
  return result;
}

function spriteKey(name: string, frame: number, rotation: number): string {
  return `${name}:${frame}:${rotation}`;
}

function indexSprites(lumps: readonly WadLump[]): ReadonlyMap<string, SpriteSelection> {
  const result = new Map<string, SpriteSelection>();
  const knownNames = new Set(spriteNames);
  for (const lump of lumps) {
    const name = lump.name.toUpperCase();
    const base = name.slice(0, 4);
    if (!knownNames.has(base)) continue;
    if (name.length !== 6 && name.length !== 8) throw new Error(`Invalid WAD sprite name ${name}`);
    for (let pair = 4; pair < name.length; pair += 2) {
      const frame = name.charCodeAt(pair) - 65;
      const rotation = name.charCodeAt(pair + 1) - 48;
      if (frame < 0 || frame > 26 || rotation < 0 || rotation > 8) {
        throw new Error(`Invalid WAD sprite frame or rotation in ${name}`);
      }
      const selection: SpriteSelection = { lump, flip: pair === 6 };
      const first = rotation === 0 ? 1 : rotation;
      const last = rotation === 0 ? 8 : rotation;
      for (let view = first; view <= last; view++) result.set(spriteKey(base, frame, view), selection);
    }
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createResources(wad: WadArchive): DoomResources {
  const globalLumps = new Map<string, WadLump>();
  for (const lump of wad.lumps) globalLumps.set(lump.name.toUpperCase(), lump);
  const required = (name: string): Uint8Array => {
    const lump = globalLumps.get(name);
    if (!lump) throw new Error(`Missing WAD resource ${name}`);
    return readLump(wad, lump);
  };

  const playpal = required('PLAYPAL');
  if (playpal.byteLength !== 14 * 256 * 3) throw new Error('Doom PLAYPAL must contain all 14 original RGB palettes');
  const colormap = required('COLORMAP');
  if (colormap.byteLength !== 34 * 256) throw new Error('Doom COLORMAP must contain all 34 original 256-byte rows');
  const palettes = playpal.slice();
  const colormaps = colormap.slice();
  const patchNames = parsePatchNames(required('PNAMES'));
  const wallDefinitions = new Map<string, TextureDefinition>();
  for (const definition of parseTextureDefinitions(required('TEXTURE1'))) {
    wallDefinitions.set(definition.name.toUpperCase(), definition);
  }
  const texture2 = globalLumps.get('TEXTURE2');
  if (texture2) {
    for (const definition of parseTextureDefinitions(readLump(wad, texture2))) {
      wallDefinitions.set(definition.name.toUpperCase(), definition);
    }
  }
  const flatLumps = new Map<string, WadLump>();
  for (const lump of namespaceLumps(wad, 'F')) flatLumps.set(lump.name.toUpperCase(), lump);
  const spriteSelections = indexSprites(namespaceLumps(wad, 'S'));

  // Sprite rotations and texture references share the same decoded source patch.
  const patchImages = new Map<WadLump, IndexedImage>();
  const wallImages = new Map<string, IndexedImage>();
  const flatImages = new Map<WadLump, IndexedImage>();
  const spriteResources = new Map<SpriteSelection, SpriteResource>();
  const patchImage = (lump: WadLump): IndexedImage => {
    const cached = patchImages.get(lump);
    if (cached) return cached;
    try {
      const image = decodePatch(readLump(wad, lump));
      patchImages.set(lump, image);
      return image;
    } catch (error) {
      throw new Error(`WAD patch ${lump.name}: ${errorMessage(error)}`, { cause: error });
    }
  };
  const patch = (name: string): IndexedImage => {
    const lump = globalLumps.get(name.toUpperCase());
    if (!lump) throw new Error(`Missing WAD patch ${name}`);
    return patchImage(lump);
  };
  const wall = (name: string): IndexedImage => {
    const key = name.toUpperCase();
    const cached = wallImages.get(key);
    if (cached) return cached;
    const definition = wallDefinitions.get(key);
    if (!definition) throw new Error(`Missing WAD wall ${name}`);
    try {
      const image = composeTexture(definition, patchNames, patch);
      wallImages.set(key, image);
      return image;
    } catch (error) {
      throw new Error(`WAD wall ${name}: ${errorMessage(error)}`, { cause: error });
    }
  };
  const flat = (name: string): IndexedImage => {
    const lump = flatLumps.get(name.toUpperCase());
    if (!lump) throw new Error(`Missing WAD flat ${name}`);
    const cached = flatImages.get(lump);
    if (cached) return cached;
    try {
      const image = decodeFlat(readLump(wad, lump));
      flatImages.set(lump, image);
      return image;
    } catch (error) {
      throw new Error(`WAD flat ${name}: ${errorMessage(error)}`, { cause: error });
    }
  };
  const sprite = (id: SpriteId, frame: number, rotation: number): SpriteResource => {
    const base = spriteNames[id];
    if (!Number.isInteger(id) || base === undefined) throw new Error(`Doom sprite id ${id} is unavailable`);
    if (!Number.isInteger(frame) || frame < 0 || frame > 26) throw new Error(`Doom sprite frame ${frame} is outside 0 through 26`);
    if (!Number.isInteger(rotation) || rotation < 1 || rotation > 8) throw new Error(`Doom sprite rotation ${rotation} is outside 1 through 8`);
    const selection = spriteSelections.get(spriteKey(base, frame, rotation));
    if (!selection) throw new Error(`Missing WAD sprite ${base}${String.fromCharCode(65 + frame)}${rotation}`);
    const cached = spriteResources.get(selection);
    if (cached) return cached;
    const result: SpriteResource = {
      image: patchImage(selection.lump),
      flip: selection.flip,
      name: selection.lump.name.toUpperCase(),
    };
    spriteResources.set(selection, result);
    return result;
  };

  return { palettes, colormaps, patch, wall, flat, sprite };
}
