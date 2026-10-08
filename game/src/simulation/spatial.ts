// Copyright (C) 1993-1996 id Software, Inc.
// Native TypeScript port of p_maputl.c and r_main.c, under GPL-2.0-only.
// See ../../LICENSE.
import type { BBox, DoomMap, Vertex } from '../wad/map';
import { fixedDiv, fixedMul, FRAC_BITS, FRAC_UNIT } from './fixed';

export interface FixedLine {
  readonly v1: number;
  readonly v2: number;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly flags: number;
  readonly special: number;
  readonly tag: number;
  readonly frontSector: number;
  readonly backSector: number | null;
  readonly bbox: BBox;
}

export interface FixedNode {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly boxes: readonly [BBox, BBox];
  readonly children: readonly [number, number];
}

export interface SpatialMap {
  readonly map: DoomMap;
  readonly vertices: readonly Vertex[];
  readonly lines: readonly FixedLine[];
  readonly nodes: readonly FixedNode[];
  readonly blockOriginX: number;
  readonly blockOriginY: number;
}

export interface LineIntercept {
  readonly line: number;
  readonly fraction: number;
}

type Divline = Pick<FixedLine, 'x' | 'y' | 'dx' | 'dy'>;
const BLOCK_SHIFT = FRAC_BITS + 7;
const BLOCK_MASK = (128 * FRAC_UNIT) - 1;
const BLOCK_TO_FRAC = 7;
const SUBSECTOR_FLAG = 0x8000;

function element<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Invalid spatial map reference ${index}`);
  return value;
}

function fixedBox(box: BBox): BBox {
  return {
    top: box.top << FRAC_BITS, bottom: box.bottom << FRAC_BITS,
    left: box.left << FRAC_BITS, right: box.right << FRAC_BITS,
  };
}

export function buildSpatialMap(map: DoomMap): SpatialMap {
  const vertices = map.vertices.map(vertex => ({ x: vertex.x << FRAC_BITS, y: vertex.y << FRAC_BITS }));
  const lines = map.lines.map<FixedLine>(line => {
    const v1 = element(vertices, line.v1), v2 = element(vertices, line.v2);
    return {
      v1: line.v1, v2: line.v2, x: v1.x, y: v1.y,
      dx: (v2.x - v1.x) | 0, dy: (v2.y - v1.y) | 0,
      flags: line.flags, special: line.special, tag: line.tag,
      frontSector: element(map.sides, line.frontSide).sector,
      backSector: line.backSide === null ? null : element(map.sides, line.backSide).sector,
      bbox: {
        top: Math.max(v1.y, v2.y), bottom: Math.min(v1.y, v2.y),
        left: Math.min(v1.x, v2.x), right: Math.max(v1.x, v2.x),
      },
    };
  });
  const nodes = map.nodes.map<FixedNode>(node => ({
    x: node.x << FRAC_BITS, y: node.y << FRAC_BITS,
    dx: node.dx << FRAC_BITS, dy: node.dy << FRAC_BITS,
    boxes: [fixedBox(node.boxes[0]), fixedBox(node.boxes[1])], children: node.children,
  }));
  return {
    map, vertices, lines, nodes,
    blockOriginX: map.blockmap.originX << FRAC_BITS,
    blockOriginY: map.blockmap.originY << FRAC_BITS,
  };
}

export function pointOnLineSide(x: number, y: number, line: FixedLine): 0 | 1 {
  if (line.dx === 0) return (x <= line.x ? line.dy > 0 : line.dy < 0) ? 1 : 0;
  if (line.dy === 0) return (y <= line.y ? line.dx < 0 : line.dx > 0) ? 1 : 0;
  const dx = (x - line.x) | 0, dy = (y - line.y) | 0;
  const left = fixedMul(line.dy >> FRAC_BITS, dx);
  const right = fixedMul(dy, line.dx >> FRAC_BITS);
  return right < left ? 0 : 1;
}

export function boxOnLineSide(box: BBox, line: FixedLine): 0 | 1 | -1 {
  let first: 0 | 1, second: 0 | 1;
  if (line.dx === 0) {
    first = (box.right < line.x) !== (line.dy < 0) ? 1 : 0;
    second = (box.left < line.x) !== (line.dy < 0) ? 1 : 0;
  } else if (line.dy === 0) {
    first = (box.top > line.y) !== (line.dx < 0) ? 1 : 0;
    second = (box.bottom > line.y) !== (line.dx < 0) ? 1 : 0;
  } else if (fixedDiv(line.dy, line.dx) > 0) {
    first = pointOnLineSide(box.left, box.top, line);
    second = pointOnLineSide(box.right, box.bottom, line);
  } else {
    first = pointOnLineSide(box.right, box.top, line);
    second = pointOnLineSide(box.left, box.bottom, line);
  }
  return first === second ? first : -1;
}

export function pointOnNodeSide(x: number, y: number, node: FixedNode): 0 | 1 {
  if (node.dx === 0) return (x <= node.x ? node.dy > 0 : node.dy < 0) ? 1 : 0;
  if (node.dy === 0) return (y <= node.y ? node.dx < 0 : node.dx > 0) ? 1 : 0;
  const dx = (x - node.x) | 0, dy = (y - node.y) | 0;
  if ((node.dy ^ node.dx ^ dx ^ dy) & 0x80000000) {
    return (node.dy ^ dx) & 0x80000000 ? 1 : 0;
  }
  const left = fixedMul(node.dy >> FRAC_BITS, dx);
  const right = fixedMul(dy, node.dx >> FRAC_BITS);
  return right < left ? 0 : 1;
}

export function findSubsector(spatial: SpatialMap, x: number, y: number): number {
  if (spatial.nodes.length === 0) return 0;
  let index = spatial.nodes.length - 1;
  while ((index & SUBSECTOR_FLAG) === 0) {
    const node = element(spatial.nodes, index);
    index = node.children[pointOnNodeSide(x, y, node)];
  }
  return index & ~SUBSECTOR_FLAG;
}

function pointOnDivlineSide(x: number, y: number, line: Divline): 0 | 1 {
  if (line.dx === 0) return (x <= line.x ? line.dy > 0 : line.dy < 0) ? 1 : 0;
  if (line.dy === 0) return (y <= line.y ? line.dx < 0 : line.dx > 0) ? 1 : 0;
  const dx = (x - line.x) | 0, dy = (y - line.y) | 0;
  if ((line.dy ^ line.dx ^ dx ^ dy) & 0x80000000) {
    return (line.dy ^ dx) & 0x80000000 ? 1 : 0;
  }
  const left = fixedMul(line.dy >> 8, dx >> 8);
  const right = fixedMul(dy >> 8, line.dx >> 8);
  return right < left ? 0 : 1;
}

function interceptFraction(trace: Divline, line: Divline): number {
  const denominator = (fixedMul(line.dy >> 8, trace.dx) - fixedMul(line.dx >> 8, trace.dy)) | 0;
  if (denominator === 0) return 0;
  const numerator = (fixedMul(((line.x - trace.x) | 0) >> 8, line.dy) +
    fixedMul(((trace.y - line.y) | 0) >> 8, line.dx)) | 0;
  return fixedDiv(numerator, denominator);
}

export function traceLines(spatial: SpatialMap, x1: number, y1: number, x2: number, y2: number): readonly LineIntercept[] {
  const intercepts: LineIntercept[] = [];
  const visited = new Set<number>();
  if (((x1 - spatial.blockOriginX) & BLOCK_MASK) === 0) x1 = (x1 + FRAC_UNIT) | 0;
  if (((y1 - spatial.blockOriginY) & BLOCK_MASK) === 0) y1 = (y1 + FRAC_UNIT) | 0;
  const trace: Divline = { x: x1, y: y1, dx: (x2 - x1) | 0, dy: (y2 - y1) | 0 };
  const longTrace = trace.dx > 16 * FRAC_UNIT || trace.dx < -16 * FRAC_UNIT ||
    trace.dy > 16 * FRAC_UNIT || trace.dy < -16 * FRAC_UNIT;
  const addLine = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const line = element(spatial.lines, index);
    let first: 0 | 1, second: 0 | 1;
    if (longTrace) {
      const v1 = element(spatial.vertices, line.v1), v2 = element(spatial.vertices, line.v2);
      first = pointOnDivlineSide(v1.x, v1.y, trace);
      second = pointOnDivlineSide(v2.x, v2.y, trace);
    } else {
      first = pointOnLineSide(trace.x, trace.y, line);
      second = pointOnLineSide((trace.x + trace.dx) | 0, (trace.y + trace.dy) | 0, line);
    }
    if (first === second) return;
    const fraction = interceptFraction(trace, line);
    if (fraction >= 0 && fraction <= FRAC_UNIT) intercepts.push({ line: index, fraction });
  };
  x1 = (x1 - spatial.blockOriginX) | 0;
  y1 = (y1 - spatial.blockOriginY) | 0;
  x2 = (x2 - spatial.blockOriginX) | 0;
  y2 = (y2 - spatial.blockOriginY) | 0;
  const startX = x1 >> BLOCK_SHIFT, startY = y1 >> BLOCK_SHIFT;
  const endX = x2 >> BLOCK_SHIFT, endY = y2 >> BLOCK_SHIFT;
  let stepX: number, stepY: number, partial: number, xStep: number, yStep: number;
  if (endX > startX) {
    stepX = 1;
    partial = FRAC_UNIT - ((x1 >> BLOCK_TO_FRAC) & (FRAC_UNIT - 1));
    yStep = fixedDiv((y2 - y1) | 0, Math.abs((x2 - x1) | 0));
  } else if (endX < startX) {
    stepX = -1;
    partial = (x1 >> BLOCK_TO_FRAC) & (FRAC_UNIT - 1);
    yStep = fixedDiv((y2 - y1) | 0, Math.abs((x2 - x1) | 0));
  } else {
    stepX = 0;
    partial = FRAC_UNIT;
    yStep = 256 * FRAC_UNIT;
  }
  let yIntercept = ((y1 >> BLOCK_TO_FRAC) + fixedMul(partial, yStep)) | 0;
  if (endY > startY) {
    stepY = 1;
    partial = FRAC_UNIT - ((y1 >> BLOCK_TO_FRAC) & (FRAC_UNIT - 1));
    xStep = fixedDiv((x2 - x1) | 0, Math.abs((y2 - y1) | 0));
  } else if (endY < startY) {
    stepY = -1;
    partial = (y1 >> BLOCK_TO_FRAC) & (FRAC_UNIT - 1);
    xStep = fixedDiv((x2 - x1) | 0, Math.abs((y2 - y1) | 0));
  } else {
    stepY = 0;
    partial = FRAC_UNIT;
    xStep = 256 * FRAC_UNIT;
  }
  let xIntercept = ((x1 >> BLOCK_TO_FRAC) + fixedMul(partial, xStep)) | 0;
  let blockX = startX, blockY = startY;
  const { width, height, cells } = spatial.map.blockmap;
  for (let count = 0; count < 64; count++) {
    if (blockX >= 0 && blockY >= 0 && blockX < width && blockY < height) {
      // Vanilla P_BlockLinesIterator also reads the list's dummy zero as line 0.
      // The map decoder strips that header; restore its traversal order here.
      if (spatial.lines.length !== 0) addLine(0);
      for (const index of element(cells, blockY * width + blockX)) addLine(index);
    }
    if (blockX === endX && blockY === endY) break;
    if ((yIntercept >> FRAC_BITS) === blockY) {
      yIntercept = (yIntercept + yStep) | 0;
      blockX += stepX;
    } else if ((xIntercept >> FRAC_BITS) === blockX) {
      xIntercept = (xIntercept + xStep) | 0;
      blockY += stepY;
    }
  }
  return intercepts.sort((first, second) => first.fraction - second.fraction);
}
