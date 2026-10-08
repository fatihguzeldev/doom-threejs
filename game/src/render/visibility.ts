// Copyright (C) 1993-1996 id Software, Inc.
// Native TypeScript adaptation of r_bsp.c, under GPL-2.0-only.
// See ../../LICENSE.
import { FRAC_UNIT } from '../simulation/fixed';
import { pointOnNodeSide } from '../simulation/spatial';
import type { World } from '../simulation/world';
import type { BBox } from '../wad/map';

export interface VisibilityCamera {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly horizontalFov?: number;
}

export interface VisibleGeometry {
  readonly visibleSubsectors: readonly number[];
  readonly visibleSegs: ReadonlySet<number>;
  readonly visibleSectors: ReadonlySet<number>;
}

interface AngularSpan {
  readonly start: number;
  readonly end: number;
}

interface BspVisit {
  readonly index: number;
  readonly box: BBox | null;
}

const TAU = 2 * Math.PI;
const SUBSECTOR = 0x8000;
const TWO_SIDED = 4;
// R_CheckBBox corners, indexed TOP, BOTTOM, LEFT, RIGHT.
const CHECK_COORD: readonly (readonly [number, number, number, number])[] = [
  [3, 0, 2, 1], [3, 0, 2, 0], [3, 1, 2, 0], [0, 0, 0, 0],
  [2, 0, 2, 1], [0, 0, 0, 0], [3, 1, 3, 0], [0, 0, 0, 0],
  [2, 0, 3, 1], [2, 1, 3, 1], [2, 1, 3, 0], [0, 0, 0, 0],
];

function element<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Invalid visibility map reference ${index}`);
  return value;
}

function positiveAngle(angle: number): number {
  return ((angle % TAU) + TAU) % TAU;
}

function signedAngle(angle: number): number {
  return angle > Math.PI ? angle - TAU : angle;
}

// The native unsigned BAM clipping comparisons expressed in render-only radians.
// Continuous spans retain subpixel geometry instead of rounding to 320 columns.
function clipSpan(first: number, second: number, span: number, halfFov: number): AngularSpan | null {
  const fov = halfFov * 2;
  let clipped = positiveAngle(first + halfFov);
  if (clipped > fov) {
    clipped -= fov;
    if (clipped >= span) return null;
    first = halfFov;
  }
  clipped = positiveAngle(halfFov - second);
  if (clipped > fov) {
    clipped -= fov;
    if (clipped >= span) return null;
    second = positiveAngle(-halfFov);
  }
  const start = signedAngle(second), end = signedAngle(first);
  return start < end ? { start, end } : null;
}

function hasVisibleSpan(span: AngularSpan, solid: readonly AngularSpan[]): boolean {
  for (const covered of solid) {
    if (covered.end < span.start) continue;
    if (covered.start > span.start) return true;
    return covered.end < span.end;
  }
  return true;
}

function addSolidSpan(span: AngularSpan, solid: AngularSpan[]): void {
  let start = span.start, end = span.end, first = 0;
  while (first < solid.length && element(solid, first).end < start) first++;
  let last = first;
  while (last < solid.length && element(solid, last).start <= end) {
    const covered = element(solid, last++);
    start = Math.min(start, covered.start);
    end = Math.max(end, covered.end);
  }
  solid.splice(first, last - first, { start, end });
}

function bboxVisible(box: BBox, camera: VisibilityCamera, viewAngle: number, halfFov: number, solid: readonly AngularSpan[]): boolean {
  const boxX = camera.x <= box.left ? 0 : camera.x < box.right ? 1 : 2;
  const boxY = camera.y >= box.top ? 0 : camera.y > box.bottom ? 1 : 2;
  const position = (boxY << 2) + boxX;
  if (position === 5) return true;
  const corners = element(CHECK_COORD, position);
  const bounds = [box.top, box.bottom, box.left, box.right];
  const first = positiveAngle(Math.atan2(element(bounds, corners[1]) - camera.y, element(bounds, corners[0]) - camera.x) - viewAngle);
  const second = positiveAngle(Math.atan2(element(bounds, corners[3]) - camera.y, element(bounds, corners[2]) - camera.x) - viewAngle);
  const span = positiveAngle(first - second);
  // The camera can lie on a box edge; R_CheckBBox keeps the ambiguous half-plane.
  if (span >= Math.PI) return true;
  const clipped = clipSpan(first, second, span, halfFov);
  return clipped !== null && hasVisibleSpan(clipped, solid);
}

export function visibleGeometry(world: World, camera: VisibilityCamera): VisibleGeometry {
  const fov = camera.horizontalFov ?? Math.PI / 2;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= Math.PI) {
    throw new Error('Visibility field of view must be between zero and PI radians');
  }
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.angle)) {
    throw new Error('Visibility camera coordinates and angle must be finite');
  }
  const map = world.spatial.map;
  const viewAngle = (camera.angle >>> 0) / 0x100000000 * TAU;
  const halfFov = fov / 2;
  const fixedX = Math.trunc(camera.x * FRAC_UNIT) | 0;
  const fixedY = Math.trunc(camera.y * FRAC_UNIT) | 0;
  const solid: AngularSpan[] = [];
  const vertexAngles = new Map<number, number>();
  const visibleSubsectors: number[] = [];
  const visibleSegs = new Set<number>();
  const visibleSectors = new Set<number>();
  const visitedNodes = new Set<number>();
  const visitedSubsectors = new Set<number>();
  const angleToVertex = (index: number): number => {
    const cached = vertexAngles.get(index);
    if (cached !== undefined) return cached;
    const vertex = element(map.vertices, index);
    const angle = positiveAngle(Math.atan2(vertex.y - camera.y, vertex.x - camera.x) - viewAngle);
    vertexAngles.set(index, angle);
    return angle;
  };

  const visitSubsector = (index: number): void => {
    if (visitedSubsectors.has(index)) return;
    visitedSubsectors.add(index);
    const subsector = element(map.subsectors, index);
    visibleSubsectors.push(index);
    visibleSectors.add(subsector.sector);
    const front = element(world.sectors, subsector.sector);
    for (let index = subsector.firstSeg; index < subsector.firstSeg + subsector.segCount; index++) {
      const seg = element(map.segs, index);
      const first = angleToVertex(seg.v1), second = angleToVertex(seg.v2);
      const span = positiveAngle(first - second);
      if (span >= Math.PI) continue;
      const clipped = clipSpan(first, second, span, halfFov);
      if (clipped === null || !hasVisibleSpan(clipped, solid)) continue;
      const line = element(map.lines, seg.line);
      const fixedLine = element(world.spatial.lines, seg.line);
      const sideIndex = seg.side === 0 ? line.frontSide : line.backSide;
      if (sideIndex === null) throw new Error('Visibility segment has no side');
      const side = element(world.sides, sideIndex);
      const opposite = seg.side === 0 ? fixedLine.backSector : fixedLine.frontSector;
      const backIndex = ((world.lineFlags[seg.line] ?? 0) & TWO_SIDED) !== 0 ? opposite : null;
      const back = backIndex === null ? null : element(world.sectors, backIndex);
      if (back === null || back.ceilingHeight <= front.floorHeight || back.floorHeight >= front.ceilingHeight) {
        visibleSegs.add(index);
        addSolidSpan(clipped, solid);
        continue;
      }
      if (back.ceilingHeight === front.ceilingHeight && back.floorHeight === front.floorHeight &&
        back.ceilingTexture === front.ceilingTexture && back.floorTexture === front.floorTexture &&
        back.lightLevel === front.lightLevel && (side.middleTexture === '-' || side.middleTexture === '')) continue;
      visibleSegs.add(index);
    }
  };

  const stack: BspVisit[] = [{ index: map.nodes.length === 0 ? SUBSECTOR : map.nodes.length - 1, box: null }];
  while (stack.length !== 0) {
    const visit = stack.pop();
    if (!visit) break;
    if (visit.box !== null && !bboxVisible(visit.box, camera, viewAngle, halfFov, solid)) continue;
    if ((visit.index & SUBSECTOR) !== 0) {
      visitSubsector(visit.index & ~SUBSECTOR);
      continue;
    }
    if (visitedNodes.has(visit.index)) continue;
    visitedNodes.add(visit.index);
    const node = element(map.nodes, visit.index);
    const side = pointOnNodeSide(fixedX, fixedY, element(world.spatial.nodes, visit.index));
    const far = side === 0 ? 1 : 0;
    // The far bbox is tested only after its near sibling contributes solid spans.
    stack.push({ index: node.children[far], box: node.boxes[far] });
    stack.push({ index: node.children[side], box: null });
  }
  return { visibleSubsectors, visibleSegs, visibleSectors };
}
