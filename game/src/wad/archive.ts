export interface WadLump {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface WadArchive {
  readonly kind: 'IWAD' | 'PWAD';
  readonly bytes: Uint8Array;
  readonly lumps: readonly WadLump[];
}

const HEADER_SIZE = 12;
const DIRECTORY_ENTRY_SIZE = 16;
const MAP_LUMP_NAMES = [
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP',
] as const;

function checkLumpRange(bytes: Uint8Array, lump: WadLump): void {
  if (!Number.isSafeInteger(lump.size) || lump.size < 0) {
    throw new Error(`Invalid WAD lump ${lump.name}: size is outside the valid range`);
  }
  // Empty markers contain no data; original WADs may give them arbitrary positions.
  if (lump.size === 0) return;
  if (!Number.isSafeInteger(lump.offset) || lump.offset < 0 ||
      lump.offset > bytes.length || lump.size > bytes.length - lump.offset) {
    throw new Error(`Invalid WAD lump ${lump.name}: data range exceeds the archive`);
  }
}

function readName(view: DataView, offset: number, index: number): string {
  let name = '';
  for (let i = 0; i < 8; i++) {
    const value = view.getUint8(offset + i);
    if (value === 0) break;
    if (value < 0x20 || value > 0x7e) {
      throw new Error(`Invalid WAD lump name at directory index ${index}: expected printable ASCII`);
    }
    name += String.fromCharCode(value);
  }
  return name;
}

export function parseWad(bytes: Uint8Array): WadArchive {
  if (bytes.length < HEADER_SIZE) {
    throw new Error('Invalid WAD header: fewer than 12 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (signature !== 'IWAD' && signature !== 'PWAD') {
    throw new Error('Invalid WAD header: expected IWAD or PWAD');
  }
  const count = view.getUint32(4, true);
  const directory = view.getUint32(8, true);
  if (directory < HEADER_SIZE || directory > bytes.length ||
      count > Math.floor((bytes.length - directory) / DIRECTORY_ENTRY_SIZE)) {
    throw new Error('Invalid WAD directory: records exceed the archive or overlap its header');
  }
  const lumps: WadLump[] = [];
  for (let index = 0; index < count; index++) {
    const record = directory + index * DIRECTORY_ENTRY_SIZE;
    const lump: WadLump = {
      name: readName(view, record + 8, index),
      offset: view.getUint32(record, true),
      size: view.getUint32(record + 4, true),
    };
    checkLumpRange(bytes, lump);
    lumps.push(lump);
  }
  return { kind: signature, bytes, lumps };
}

export function findLump(wad: WadArchive, name: string): WadLump | undefined {
  const target = name.toUpperCase();
  // Later entries replace earlier resources, including entries from patch WADs.
  for (let index = wad.lumps.length - 1; index >= 0; index--) {
    const lump = wad.lumps[index];
    if (lump?.name.toUpperCase() === target) return lump;
  }
  return undefined;
}

export function readLump(wad: WadArchive, lump: WadLump): Uint8Array {
  checkLumpRange(wad.bytes, lump);
  if (lump.size === 0) return wad.bytes.subarray(0, 0);
  return wad.bytes.subarray(lump.offset, lump.offset + lump.size);
}

export function mapLumps(wad: WadArchive, mapName: string): ReadonlyMap<string, WadLump> {
  const marker = findLump(wad, mapName);
  if (!marker) throw new Error(`WAD map ${mapName} not found`);
  let index = wad.lumps.lastIndexOf(marker);
  const result = new Map<string, WadLump>();
  for (const name of MAP_LUMP_NAMES) {
    const lump = wad.lumps[++index];
    if (lump?.name.toUpperCase() !== name) {
      throw new Error(`Invalid WAD map ${mapName}: expected contiguous ${name} lump`);
    }
    result.set(name, lump);
  }
  return result;
}
