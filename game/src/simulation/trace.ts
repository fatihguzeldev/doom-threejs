// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native path and sight port of p_maputl.c and p_sight.c. See ../../LICENSE.
import type { Actor } from './actors';
import { fixedDiv, FRAC_BITS, FRAC_UNIT } from './fixed';
import {
  interceptFraction, lineIntercept, makeTrace, pointOnDivlineSide, traverseBlocks,
  type Divline,
} from './spatial';
import type { World } from './world';

export interface ActorIntercept {
  readonly kind: 'actor';
  readonly actor: Actor;
  readonly fraction: number;
}

export interface LinePathIntercept {
  readonly kind: 'line';
  readonly line: number;
  readonly fraction: number;
}

export type PathIntercept = ActorIntercept | LinePathIntercept;

export interface TraceOptions {
  readonly lines?: boolean;
  readonly actors?: boolean;
}

function element<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`Invalid trace reference ${index}`);
  return value;
}

function actorIntercept(trace: Divline, actor: Actor): number | null {
  // The strict XOR test and selected diagonal are vanilla behavior, including
  // the collinear miss when the trace has exactly equal positive X/Y deltas.
  const positive = (trace.dx ^ trace.dy) > 0;
  const x1 = (actor.x - actor.radius) | 0, x2 = (actor.x + actor.radius) | 0;
  const y1 = (actor.y + (positive ? actor.radius : -actor.radius)) | 0;
  const y2 = (actor.y + (positive ? -actor.radius : actor.radius)) | 0;
  if (pointOnDivlineSide(x1, y1, trace) === pointOnDivlineSide(x2, y2, trace)) return null;
  const fraction = interceptFraction(trace, { x: x1, y: y1, dx: (x2 - x1) | 0, dy: (y2 - y1) | 0 });
  return fraction >= 0 && fraction <= FRAC_UNIT ? fraction : null;
}

export function tracePath(
  world: World, x1: number, y1: number, x2: number, y2: number,
  options: TraceOptions = {},
): readonly PathIntercept[] {
  const spatial = world.spatial, trace = makeTrace(spatial, x1, y1, x2, y2);
  const intercepts: PathIntercept[] = [], visitedLines = new Set<number>();
  const addLine = (index: number): void => {
    if (visitedLines.has(index)) return;
    visitedLines.add(index);
    const fraction = lineIntercept(spatial, trace, index);
    if (fraction !== null) intercepts.push({ kind: 'line', line: index, fraction });
  };
  traverseBlocks(spatial, trace, block => {
    if (options.lines !== false) {
      // Restore the raw BLOCKMAP dummy zero stripped by the archive decoder.
      if (spatial.lines.length !== 0) addLine(0);
      for (const index of element(spatial.map.blockmap.cells, block)) addLine(index);
    }
    if (options.actors !== false) {
      for (const id of element(world.actorBlocks, block)) {
        const actor = world.actorsById.get(id);
        if (!actor || actor.removed) continue;
        const fraction = actorIntercept(trace, actor);
        if (fraction !== null) intercepts.push({ kind: 'actor', actor, fraction });
      }
    }
  });
  // ECMAScript's stable sort matches P_TraverseIntercepts' first equal entry.
  return intercepts.sort((first, second) => first.fraction - second.fraction);
}

export function traceActors(world: World, x1: number, y1: number, x2: number, y2: number): readonly ActorIntercept[] {
  return tracePath(world, x1, y1, x2, y2, { lines: false })
    .flatMap(hit => hit.kind === 'actor' ? [hit] : []);
}

function sightSide(x: number, y: number, line: Divline): 0 | 1 | 2 {
  if (line.dx === 0) {
    if (x === line.x) return 2;
    return (x <= line.x ? line.dy > 0 : line.dy < 0) ? 1 : 0;
  }
  if (line.dy === 0) {
    // P_DivlineSide compares X here, even though the partition is horizontal.
    if (x === line.y) return 2;
    return (y <= line.y ? line.dx < 0 : line.dx > 0) ? 1 : 0;
  }
  const dx = (x - line.x) | 0, dy = (y - line.y) | 0;
  const left = Math.imul(line.dy >> FRAC_BITS, dx >> FRAC_BITS);
  const right = Math.imul(dy >> FRAC_BITS, line.dx >> FRAC_BITS);
  return right < left ? 0 : left === right ? 2 : 1;
}

export function checkSight(world: World, from: Actor, to: Actor): boolean {
  const spatial = world.spatial, map = spatial.map;
  const rejectBit = from.sector * world.sectors.length + to.sector;
  if (((map.reject[Math.floor(rejectBit / 8)] ?? 0) & (1 << (rejectBit & 7))) !== 0) return false;
  const eyeZ = (from.z + from.height - (from.height >> 2)) | 0;
  let topSlope = (to.z + to.height - eyeZ) | 0, bottomSlope = (to.z - eyeZ) | 0;
  const trace: Divline = { x: from.x, y: from.y, dx: (to.x - from.x) | 0, dy: (to.y - from.y) | 0 };
  const visitedLines = new Set<number>();
  const crossSubsector = (index: number): boolean => {
    const subsector = element(map.subsectors, index);
    for (let i = 0; i < subsector.segCount; i++) {
      const seg = element(map.segs, subsector.firstSeg + i);
      if (visitedLines.has(seg.line)) continue;
      visitedLines.add(seg.line);
      const line = element(spatial.lines, seg.line);
      const v1 = element(spatial.vertices, line.v1), v2 = element(spatial.vertices, line.v2);
      if (sightSide(v1.x, v1.y, trace) === sightSide(v2.x, v2.y, trace) ||
        sightSide(trace.x, trace.y, line) === sightSide(to.x, to.y, line)) continue;
      if (((world.lineFlags[seg.line] ?? line.flags) & 4) === 0 || line.backSector === null) return false;
      const front = element(world.sectors, line.frontSector), back = element(world.sectors, line.backSector);
      if (front.floorHeight === back.floorHeight && front.ceilingHeight === back.ceilingHeight) continue;
      const top = Math.min(front.ceilingHeight, back.ceilingHeight);
      const bottom = Math.max(front.floorHeight, back.floorHeight);
      if (bottom >= top) return false;
      const fraction = interceptFraction(trace, line);
      if (front.floorHeight !== back.floorHeight) {
        const slope = fixedDiv((bottom - eyeZ) | 0, fraction);
        if (slope > bottomSlope) bottomSlope = slope;
      }
      if (front.ceilingHeight !== back.ceilingHeight) {
        const slope = fixedDiv((top - eyeZ) | 0, fraction);
        if (slope < topSlope) topSlope = slope;
      }
      if (topSlope <= bottomSlope) return false;
    }
    return true;
  };
  const pending = [spatial.nodes.length === 0 ? 0x8000 : spatial.nodes.length - 1];
  const visitedNodes = new Set<number>();
  while (pending.length !== 0) {
    const index = pending.pop();
    if (index === undefined) break;
    if ((index & 0x8000) !== 0) {
      if (!crossSubsector(index & ~0x8000)) return false;
      continue;
    }
    // DAG nodes are legal in validated WADs. Their lines are already checked;
    // revisiting shared branches cannot narrow slopes further.
    if (visitedNodes.has(index)) continue;
    visitedNodes.add(index);
    const node = element(spatial.nodes, index);
    const startSide = sightSide(trace.x, trace.y, node);
    const side = startSide === 2 ? 0 : startSide;
    if (side !== sightSide(to.x, to.y, node)) pending.push(node.children[side === 0 ? 1 : 0]);
    pending.push(node.children[side]);
  }
  return true;
}
