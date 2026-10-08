import { FRAC_UNIT } from '../simulation/fixed';
import type { World } from '../simulation/world';
import type { DoomMap, Vertex } from '../wad/map';

export interface Vertex3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WallQuad {
  // Doom X/Y plane, Z height. Winding faces the SEG's right/front side.
  readonly vertices: readonly [Vertex3, Vertex3, Vertex3, Vertex3];
  readonly texture: string;
  readonly u1: number;
  readonly u2: number;
  // Texel rows at the bottom and top vertices, respectively; rows increase down.
  readonly v1: number;
  readonly v2: number;
  readonly lightLevel: number;
  readonly masked: boolean;
  readonly sector: number;
  readonly seg: number;
}

interface Plane {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
}

const EPSILON = 1e-7;

function element<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Invalid render geometry reference ${index}`);
  return value;
}

function cleanPolygon(vertices: readonly Vertex[]): readonly Vertex[] {
  const distinct = vertices.filter((point, index) => {
    const previous = element(vertices, (index + vertices.length - 1) % vertices.length);
    return Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON;
  });
  if (distinct.length < 3) return [];
  return distinct.filter((point, index) => {
    const previous = element(distinct, (index + distinct.length - 1) % distinct.length);
    const next = element(distinct, (index + 1) % distinct.length);
    const cross = (point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x);
    return Math.abs(cross) > EPSILON * (Math.hypot(point.x - previous.x, point.y - previous.y) + Math.hypot(next.x - point.x, next.y - point.y));
  });
}

function clipPolygon(polygon: readonly Vertex[], plane: Plane, front: boolean): readonly Vertex[] {
  if (polygon.length === 0) return [];
  const length = Math.hypot(plane.dx, plane.dy);
  if (length === 0) return polygon;
  const distance = (point: Vertex): number =>
    (plane.dx * (point.y - plane.y) - plane.dy * (point.x - plane.x)) / length * (front ? 1 : -1);
  const result: Vertex[] = [];
  let previous = element(polygon, polygon.length - 1);
  let previousDistance = distance(previous);
  for (const point of polygon) {
    const currentDistance = distance(point);
    const previousInside = previousDistance <= EPSILON;
    const currentInside = currentDistance <= EPSILON;
    if (previousInside !== currentInside) {
      const fraction = previousDistance / (previousDistance - currentDistance);
      result.push({ x: previous.x + (point.x - previous.x) * fraction, y: previous.y + (point.y - previous.y) * fraction });
    }
    if (currentInside) result.push(point);
    previous = point;
    previousDistance = currentDistance;
  }
  return cleanPolygon(result);
}

export function buildSubsectorPolygons(map: DoomMap): readonly (readonly Vertex[])[] {
  const first = element(map.vertices, 0);
  let left = first.x, right = first.x, bottom = first.y, top = first.y;
  for (const point of map.vertices) {
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    bottom = Math.min(bottom, point.y); top = Math.max(top, point.y);
  }
  const bounds: readonly Vertex[] = [{ x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }];
  const result: (readonly Vertex[])[] = Array.from({ length: map.subsectors.length }, () => []);
  const pending = [{ child: map.nodes.length === 0 ? 0x8000 : map.nodes.length - 1, polygon: bounds }];
  const completedLeaves = new Set<number>();
  const workLimit = (map.nodes.length + map.subsectors.length) * 8 + 64;
  let visited = 0;
  while (pending.length !== 0) {
    if (++visited > workLimit) throw new Error('BSP render geometry exceeds traversal work limits');
    const current = pending.pop();
    if (!current || current.polygon.length < 3) continue;
    if ((current.child & 0x8000) !== 0) {
      const index = current.child & 0x7fff;
      const leaf = element(map.subsectors, index);
      let polygon = current.polygon;
      for (let offset = 0; offset < leaf.segCount; offset++) {
        const seg = element(map.segs, leaf.firstSeg + offset);
        const start = element(map.vertices, seg.v1), end = element(map.vertices, seg.v2);
        polygon = clipPolygon(polygon, { x: start.x, y: start.y, dx: end.x - start.x, dy: end.y - start.y }, true);
      }
      if (polygon.length < 3) continue;
      if (completedLeaves.has(index)) throw new Error(`BSP render leaf ${index} has multiple nonempty regions`);
      completedLeaves.add(index);
      result[index] = polygon;
    } else {
      const node = element(map.nodes, current.child);
      pending.push({ child: node.children[1], polygon: clipPolygon(current.polygon, node, false) });
      pending.push({ child: node.children[0], polygon: clipPolygon(current.polygon, node, true) });
    }
  }
  return result;
}

export function wallQuads(world: World, textureHeight: (name: string) => number): readonly WallQuad[] {
  const map = world.spatial.map;
  const result: WallQuad[] = [];
  for (const [segIndex, seg] of map.segs.entries()) {
    const start = element(map.vertices, seg.v1), end = element(map.vertices, seg.v2);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length <= EPSILON) continue;
    const line = element(map.lines, seg.line);
    const flags = world.lineFlags[seg.line] ?? line.flags;
    const sideIndex = seg.side === 0 ? line.frontSide : line.backSide;
    if (sideIndex === null) throw new Error(`SEG ${segIndex} has no front sidedef`);
    const side = element(world.sides, sideIndex);
    const sectorIndex = element(map.sides, sideIndex).sector;
    const front = element(world.sectors, sectorIndex);
    const frontFloor = front.floorHeight / FRAC_UNIT, frontCeiling = front.ceilingHeight / FRAC_UNIT;
    const oppositeSide = seg.side === 0 ? line.backSide : line.frontSide;
    const back = (flags & 4) === 0 || oppositeSide === null ? null : element(world.sectors, element(map.sides, oppositeSide).sector);
    const u1 = side.textureOffset / FRAC_UNIT + seg.offset;
    const rowOffset = side.rowOffset / FRAC_UNIT;
    const add = (texture: string, bottom: number, top: number, anchor: (height: number) => number, masked = false): void => {
      if (texture === '-' || texture === '' || top <= bottom) return;
      const height = textureHeight(texture);
      if (!Number.isFinite(height) || height <= 0) throw new Error(`Invalid render texture height for ${texture}`);
      const textureTop = anchor(height) + rowOffset;
      if (masked) {
        bottom = Math.max(bottom, textureTop - height);
        top = Math.min(top, textureTop);
      }
      if (top <= bottom) return;
      result.push({
        vertices: [{ ...start, z: bottom }, { ...end, z: bottom }, { ...end, z: top }, { ...start, z: top }],
        texture, u1, u2: u1 + length, v1: textureTop - bottom, v2: textureTop - top,
        lightLevel: front.lightLevel, masked, sector: sectorIndex, seg: segIndex,
      });
    };
    if (back === null) {
      add(side.middleTexture, frontFloor, frontCeiling, height => (flags & 16) !== 0 ? frontFloor + height : frontCeiling);
      continue;
    }
    const backFloor = back.floorHeight / FRAC_UNIT, backCeiling = back.ceilingHeight / FRAC_UNIT;
    const bothSky = front.ceilingTexture === 'F_SKY1' && back.ceilingTexture === 'F_SKY1';
    const worldTop = bothSky ? backCeiling : frontCeiling;
    if (!bothSky && backCeiling < frontCeiling) {
      add(side.upperTexture, Math.max(frontFloor, backCeiling), frontCeiling, height => (flags & 8) !== 0 ? frontCeiling : backCeiling + height);
    }
    if (backFloor > frontFloor) {
      let top = Math.min(frontCeiling, backFloor);
      // Native upper-wall clipping wins when a closed/crushing sector overlaps tiers.
      if (!bothSky && backCeiling < frontCeiling && side.upperTexture !== '-' && side.upperTexture !== '') top = Math.min(top, backCeiling);
      add(side.lowerTexture, frontFloor, top, () => (flags & 16) !== 0 ? worldTop : backFloor);
    }
    const openingBottom = Math.max(frontFloor, backFloor), openingTop = Math.min(frontCeiling, backCeiling);
    add(side.middleTexture, openingBottom, openingTop, height => (flags & 16) !== 0 ? openingBottom + height : openingTop, true);
  }
  return result;
}
