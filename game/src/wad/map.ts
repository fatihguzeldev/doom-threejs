import { mapLumps, readLump, type WadArchive } from './archive';

export interface Vertex {
  readonly x: number;
  readonly y: number;
}

export interface MapSector {
  readonly floorHeight: number;
  readonly ceilingHeight: number;
  readonly floorTexture: string;
  readonly ceilingTexture: string;
  readonly lightLevel: number;
  readonly special: number;
  readonly tag: number;
}

export interface MapSide {
  readonly textureOffset: number;
  readonly rowOffset: number;
  readonly upperTexture: string;
  readonly lowerTexture: string;
  readonly middleTexture: string;
  readonly sector: number;
}

export interface MapLine {
  readonly v1: number;
  readonly v2: number;
  readonly flags: number;
  readonly special: number;
  readonly tag: number;
  readonly frontSide: number;
  readonly backSide: number | null;
}

export interface MapSeg {
  readonly v1: number;
  readonly v2: number;
  readonly angle: number;
  readonly line: number;
  readonly side: 0 | 1;
  readonly offset: number;
}

export interface MapSubsector {
  readonly firstSeg: number;
  readonly segCount: number;
  readonly sector: number;
}

export interface BBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface MapNode {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly boxes: readonly [BBox, BBox];
  readonly children: readonly [number, number];
}

export interface MapThing {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly type: number;
  readonly flags: number;
}

export interface Blockmap {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly (readonly number[])[];
}

export interface DoomMap {
  readonly name: string;
  readonly vertices: readonly Vertex[];
  readonly sectors: readonly MapSector[];
  readonly sides: readonly MapSide[];
  readonly lines: readonly MapLine[];
  readonly segs: readonly MapSeg[];
  readonly subsectors: readonly MapSubsector[];
  readonly nodes: readonly MapNode[];
  readonly things: readonly MapThing[];
  readonly blockmap: Blockmap;
  readonly reject: Uint8Array;
}

function records<T>(bytes: Uint8Array, size: number, name: string,
  decode: (view: DataView, offset: number, index: number) => T): T[] {
  if (bytes.length % size !== 0) {
    throw new Error(`Invalid ${name}: truncated ${size}-byte record`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / size }, (_, index) => decode(view, index * size, index));
}

function reference<T>(values: readonly T[], index: number, context: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Invalid ${context}: index ${index} is out of range`);
  return value;
}

function textureName(view: DataView, offset: number): string {
  let result = '';
  for (let i = 0; i < 8; i++) {
    const value = view.getUint8(offset + i);
    if (value === 0) break;
    if (value < 0x20 || value > 0x7e) throw new Error('Invalid map texture name: expected printable ASCII');
    result += String.fromCharCode(value);
  }
  return result.toUpperCase();
}

function boundingBox(view: DataView, offset: number): BBox {
  return {
    top: view.getInt16(offset, true),
    bottom: view.getInt16(offset + 2, true),
    left: view.getInt16(offset + 4, true),
    right: view.getInt16(offset + 6, true),
  };
}

function validateBsp(nodes: readonly MapNode[], subsectors: readonly MapSubsector[]): void {
  if (nodes.length === 0 && subsectors.length !== 1) {
    throw new Error('Invalid BSP: a root node is required for multiple or missing subsectors');
  }
  const indegree = new Uint32Array(nodes.length);
  for (const [index, node] of nodes.entries()) {
    for (const child of node.children) {
      if (child & 0x8000) {
        reference(subsectors, child & 0x7fff, `BSP node ${index} leaf child`);
      } else {
        reference(nodes, child, `BSP node ${index} node child`);
        indegree[child] = (indegree[child] ?? 0) + 1;
      }
    }
  }
  // Topological traversal checks even disconnected nodes without recursion.
  const queue: number[] = [];
  indegree.forEach((count, index) => { if (count === 0) queue.push(index); });
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = reference(queue, cursor, 'BSP traversal');
    for (const child of reference(nodes, index, 'BSP traversal').children) {
      if (child & 0x8000) continue;
      const count = (indegree[child] ?? 0) - 1;
      indegree[child] = count;
      if (count === 0) queue.push(child);
    }
  }
  if (queue.length !== nodes.length) throw new Error('Invalid BSP: node cycle detected');
}

function decodeBlockmap(bytes: Uint8Array, lines: readonly MapLine[]): Blockmap {
  if (bytes.length < 8) throw new Error('Invalid BLOCKMAP: truncated header');
  if (bytes.length % 2 !== 0) throw new Error('Invalid BLOCKMAP: truncated 16-bit word');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const cellCount = width * height;
  const wordCount = bytes.length / 2;
  const listsStart = 4 + cellCount;
  if (width === 0 || height === 0 || listsStart > wordCount) {
    throw new Error('Invalid BLOCKMAP: dimensions exceed its offset table');
  }
  const lists = new Map<number, readonly number[]>();
  const cells: (readonly number[])[] = [];
  // Overlapping list tails can otherwise expand quadratically when decoded.
  // Each scanned word adds at most one entry, bounding work and stored indices.
  const scanBudget = wordCount * 16 + 1024;
  let scannedWords = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    const offset = view.getUint16((4 + cell) * 2, true);
    if (offset < listsStart || offset >= wordCount) {
      throw new Error(`Invalid BLOCKMAP cell ${cell}: list offset is out of range`);
    }
    let list = lists.get(offset);
    if (list === undefined) {
      if (++scannedWords > scanBudget) throw new Error('Invalid BLOCKMAP: decoded lists exceed the word budget');
      if (view.getUint16(offset * 2, true) !== 0) {
        throw new Error(`Invalid BLOCKMAP cell ${cell}: list must begin with zero`);
      }
      const indices: number[] = [];
      let cursor = offset + 1;
      for (; cursor < wordCount; cursor++) {
        if (++scannedWords > scanBudget) throw new Error('Invalid BLOCKMAP: decoded lists exceed the word budget');
        const index = view.getUint16(cursor * 2, true);
        if (index === 0xffff) break;
        reference(lines, index, `BLOCKMAP cell ${cell} line`);
        indices.push(index);
      }
      if (cursor === wordCount) throw new Error(`Invalid BLOCKMAP cell ${cell}: missing list terminator`);
      list = indices;
      lists.set(offset, list);
    }
    cells.push(list);
  }
  return {
    originX: view.getInt16(0, true), originY: view.getInt16(2, true),
    width, height, cells,
  };
}

export function decodeMap(wad: WadArchive, mapName: string): DoomMap {
  const lumps = mapLumps(wad, mapName);
  const data = (name: string): Uint8Array => {
    const lump = lumps.get(name);
    if (!lump) throw new Error(`WAD map ${mapName} is missing ${name}`);
    return readLump(wad, lump);
  };
  const vertices = records<Vertex>(data('VERTEXES'), 4, 'VERTEXES', (view, offset) => ({
    x: view.getInt16(offset, true), y: view.getInt16(offset + 2, true),
  }));
  const sectors = records<MapSector>(data('SECTORS'), 26, 'SECTORS', (view, offset) => ({
    floorHeight: view.getInt16(offset, true), ceilingHeight: view.getInt16(offset + 2, true),
    floorTexture: textureName(view, offset + 4), ceilingTexture: textureName(view, offset + 12),
    lightLevel: view.getInt16(offset + 20, true),
    special: view.getUint16(offset + 22, true), tag: view.getUint16(offset + 24, true),
  }));
  const sides = records<MapSide>(data('SIDEDEFS'), 30, 'SIDEDEFS', (view, offset, index) => {
    const sector = view.getUint16(offset + 28, true);
    reference(sectors, sector, `SIDEDEFS ${index} sector`);
    return {
      textureOffset: view.getInt16(offset, true), rowOffset: view.getInt16(offset + 2, true),
      upperTexture: textureName(view, offset + 4), lowerTexture: textureName(view, offset + 12),
      middleTexture: textureName(view, offset + 20), sector,
    };
  });
  const lines = records<MapLine>(data('LINEDEFS'), 14, 'LINEDEFS', (view, offset, index) => {
    const v1 = view.getUint16(offset, true), v2 = view.getUint16(offset + 2, true);
    const frontSide = view.getUint16(offset + 10, true);
    const backIndex = view.getUint16(offset + 12, true);
    const backSide = backIndex === 0xffff ? null : backIndex;
    reference(vertices, v1, `LINEDEFS ${index} first vertex`);
    reference(vertices, v2, `LINEDEFS ${index} second vertex`);
    reference(sides, frontSide, `LINEDEFS ${index} front side`);
    if (backSide !== null) reference(sides, backSide, `LINEDEFS ${index} back side`);
    return {
      v1, v2, flags: view.getUint16(offset + 4, true),
      special: view.getUint16(offset + 6, true), tag: view.getUint16(offset + 8, true),
      frontSide, backSide,
    };
  });
  const segSectors: number[] = [];
  const segs = records<MapSeg>(data('SEGS'), 12, 'SEGS', (view, offset, index) => {
    const v1 = view.getUint16(offset, true), v2 = view.getUint16(offset + 2, true);
    const lineIndex = view.getUint16(offset + 6, true);
    const side = view.getUint16(offset + 8, true);
    reference(vertices, v1, `SEGS ${index} first vertex`);
    reference(vertices, v2, `SEGS ${index} second vertex`);
    const line = reference(lines, lineIndex, `SEGS ${index} line`);
    if (side !== 0 && side !== 1) throw new Error(`Invalid SEGS ${index}: side must be 0 or 1`);
    const sideIndex = side === 0 ? line.frontSide : line.backSide;
    if (sideIndex === null) throw new Error(`Invalid SEGS ${index}: absent back side`);
    segSectors.push(reference(sides, sideIndex, `SEGS ${index} side`).sector);
    return { v1, v2, angle: view.getUint16(offset + 4, true), line: lineIndex, side, offset: view.getInt16(offset + 10, true) };
  });
  const subsectors = records<MapSubsector>(data('SSECTORS'), 4, 'SSECTORS', (view, offset, index) => {
    const segCount = view.getUint16(offset, true), firstSeg = view.getUint16(offset + 2, true);
    if (segCount === 0 || firstSeg >= segs.length || segCount > segs.length - firstSeg) {
      throw new Error(`Invalid subsector ${index}: segment span is out of range`);
    }
    const sector = reference(segSectors, firstSeg, `subsector ${index} first segment`);
    for (let seg = firstSeg + 1; seg < firstSeg + segCount; seg++) {
      if (segSectors[seg] !== sector) throw new Error(`Invalid subsector ${index}: segments disagree on their sector`);
    }
    return { firstSeg, segCount, sector };
  });
  const nodes = records<MapNode>(data('NODES'), 28, 'NODES', (view, offset) => ({
    x: view.getInt16(offset, true), y: view.getInt16(offset + 2, true),
    dx: view.getInt16(offset + 4, true), dy: view.getInt16(offset + 6, true),
    boxes: [boundingBox(view, offset + 8), boundingBox(view, offset + 16)],
    children: [view.getUint16(offset + 24, true), view.getUint16(offset + 26, true)],
  }));
  validateBsp(nodes, subsectors);
  const things = records<MapThing>(data('THINGS'), 10, 'THINGS', (view, offset) => ({
    x: view.getInt16(offset, true), y: view.getInt16(offset + 2, true),
    angle: view.getUint16(offset + 4, true), type: view.getUint16(offset + 6, true), flags: view.getUint16(offset + 8, true),
  }));
  const reject = data('REJECT');
  const rejectMinimum = Math.ceil(sectors.length * sectors.length / 8);
  if (reject.length < rejectMinimum) {
    throw new Error(`Invalid REJECT: map requires at least ${rejectMinimum} bytes`);
  }
  return {
    name: mapName.toUpperCase(), vertices, sectors, sides, lines, segs, subsectors,
    nodes, things, blockmap: decodeBlockmap(data('BLOCKMAP'), lines), reject,
  };
}
