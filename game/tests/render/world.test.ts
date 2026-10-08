import { readFileSync } from 'node:fs';
import { InstancedMesh, Matrix4, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { MobjFlag } from '../../src/simulation/data/actors';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';
import { createWorldScene } from '../../src/render/world';
import type { VisibleGeometry } from '../../src/render/visibility';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);

function allVisible(number: number): VisibleGeometry {
  const map = decodeMap(wad, `E1M${number}`);
  return {
    visibleSubsectors: map.subsectors.map((_, index) => index),
    visibleSegs: new Set(map.segs.map((_, index) => index)),
    visibleSectors: new Set(map.sectors.map((_, index) => index)),
  };
}

describe('native Three world batching', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('batches real E1M%i world geometry and sprites by atlas page', number => {
    const world = createWorld(decodeMap(wad, `E1M${number}`), { skill: 2 });
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Map player missing');
    const state = createWorldScene(world, resources);
    state.update({ x: player.x / FRAC_UNIT, y: player.y / FRAC_UNIT, z: 41, angle: player.angle }, allVisible(number));
    const worldMeshes = state.scene.children.filter(object => object instanceof Mesh && !(object instanceof InstancedMesh));
    const spriteMeshes = state.scene.children.filter(object => object instanceof InstancedMesh);
    expect(state.stats.atlasPages).toBe(3);
    expect(worldMeshes.length).toBeLessThanOrEqual(3);
    expect(spriteMeshes.length).toBeLessThanOrEqual(3);
    expect(state.stats.wallTriangles + state.stats.flatTriangles).toBeGreaterThan(0);
    expect(state.stats.drawCalls).toBeLessThanOrEqual(13);
    for (const object of worldMeshes) {
      if (!(object instanceof Mesh)) continue;
      expect(object.geometry.index).toBeNull();
      const positions = object.geometry.getAttribute('position');
      for (let index = 0; index < object.geometry.drawRange.count; index++) {
        expect([positions.getX(index), positions.getY(index), positions.getZ(index)].every(Number.isFinite)).toBe(true);
      }
    }
    state.dispose();
  });

  it('reuses buffers across frames and changes moving-sector geometry at the next tic', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });
    const state = createWorldScene(world, resources);
    const camera = { x: 1056, y: -3616, z: 41, angle: 0 };
    const visibility = allVisible(1);
    state.update(camera, visibility);
    const mesh = state.scene.children.find(object => object instanceof Mesh && !(object instanceof InstancedMesh));
    if (!(mesh instanceof Mesh)) throw new Error('World batch missing');
    const attribute = mesh.geometry.getAttribute('position');
    state.update(camera, visibility);
    expect(mesh.geometry.getAttribute('position')).toBe(attribute);
    const sector = world.sectors[0];
    if (!sector) throw new Error('Sector missing');
    sector.floorHeight += 8 * FRAC_UNIT;
    world.levelTime++;
    state.update(camera, visibility);
    expect(mesh.geometry.getAttribute('position')).toBe(attribute);
    expect(attribute.version).toBeGreaterThan(1);
    state.dispose();
  });

  it('builds camera-facing instances using raw sprite pivots and hides the player body', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });
    const actor = world.actors.find(actor => actor.player === null);
    if (!actor) throw new Error('Map sprite missing');
    for (const other of world.actors) if (other !== actor && other.player === null) other.removed = true;
    const state = createWorldScene(world, resources);
    const camera = { x: 0, y: 0, z: 41, angle: 0 };
    state.update(camera, allVisible(1));
    const mesh = state.scene.children.find(object => object instanceof InstancedMesh && object.count === 1);
    if (!(mesh instanceof InstancedMesh)) throw new Error('Sprite instance missing');
    const rect = mesh.geometry.getAttribute('atlasRect');
    const frame = [...state.atlas.regions.values()].find(region => region.page === state.spritePages.get(mesh) && region.x === rect.getX(0) && region.y === rect.getY(0));
    if (!frame) throw new Error('Sprite atlas region missing');
    const matrix = new Matrix4();
    mesh.getMatrixAt(0, matrix);
    const bottomLeft = new Vector3(0, 0, 0).applyMatrix4(matrix);
    expect(bottomLeft.x).toBeCloseTo(actor.x / FRAC_UNIT);
    expect(bottomLeft.y).toBeCloseTo(actor.z / FRAC_UNIT + frame.topOffset - frame.height);
    expect(bottomLeft.z).toBeCloseTo(-actor.y / FRAC_UNIT - frame.leftOffset);
    expect(state.stats.spriteTriangles).toBe(2);
    state.dispose();
  });

  it('routes shadow actors to separate indexed fuzz glyph instances', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });
    const actor = world.actors.find(actor => actor.player === null);
    if (!actor) throw new Error('Map sprite missing');
    for (const other of world.actors) if (other !== actor && other.player === null) other.removed = true;
    actor.flags |= MobjFlag.MF_SHADOW;
    const state = createWorldScene(world, resources);
    state.update({ x: 0, y: 0, z: 41, angle: 0 }, allVisible(1));
    const glyph = state.fuzzScene.children.find(object => object instanceof InstancedMesh && object.count === 1);
    if (!(glyph instanceof InstancedMesh)) throw new Error('Fuzz glyph instance missing');
    expect(glyph.geometry.index).toBeNull();
    expect(glyph.geometry.getAttribute('atlasRect').getZ(0)).toBeGreaterThan(0);
    expect(state.stats.fuzzTriangles).toBe(2);
    expect(state.stats.spriteTriangles).toBe(0);
    expect(state.scene.children.filter(object => object instanceof InstancedMesh).every(object => object.count === 0)).toBe(true);
    state.dispose();
  });

  it('records only discovered visible linedefs without changing immutable map flags', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });
    const seg = world.spatial.map.segs[0];
    if (!seg) throw new Error('Map segment missing');
    const before = [...world.lineFlags], source = world.spatial.map.lines[seg.line];
    if (!source) throw new Error('Map line missing');
    world.lineFlags[seg.line] = (before[seg.line] ?? 0) | 128;
    const state = createWorldScene(world, resources);
    state.update({ x: 0, y: 0, z: 41, angle: 0 }, {
      visibleSegs: new Set([0]), visibleSubsectors: [], visibleSectors: new Set(),
    });
    expect(world.lineFlags[seg.line]).toBe((before[seg.line] ?? 0) | 128 | 256);
    expect(world.spatial.map.lines[seg.line]?.flags).toBe(source.flags);
    expect([...world.lineFlags].every((flags, index) => index === seg.line || flags === before[index])).toBe(true);
    state.dispose();
  });

  it('changes animated atlas bindings while retaining sector and sidedef texture names', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });
    for (const side of world.sides) side.middleTexture = side.upperTexture = side.lowerTexture = 'SLADRIP1';
    for (const sector of world.sectors) sector.floorTexture = 'NUKAGE1';
    const state = createWorldScene(world, resources), camera = { x: 1056, y: -3616, z: 41, angle: 0 }, visibility = allVisible(1);
    const hasBinding = (key: string): boolean => {
      const expected = state.atlas.regions.get(key);
      if (!expected) throw new Error('Animated atlas region missing');
      for (const object of state.scene.children) {
        if (!(object instanceof Mesh) || object instanceof InstancedMesh) continue;
        const attribute = object.geometry.getAttribute('atlasRect');
        for (let index = 0; index < object.geometry.drawRange.count; index++) {
          if (attribute.getX(index) === expected.x && attribute.getY(index) === expected.y) return true;
        }
      }
      return false;
    };
    state.update(camera, visibility);
    expect(hasBinding('wall:SLADRIP2')).toBe(true);
    expect(hasBinding('flat:NUKAGE1')).toBe(true);
    world.levelTime = 8;
    state.update(camera, visibility);
    expect(hasBinding('wall:SLADRIP3')).toBe(true);
    expect(hasBinding('wall:SLADRIP2')).toBe(false);
    expect(hasBinding('flat:NUKAGE2')).toBe(true);
    expect(hasBinding('flat:NUKAGE1')).toBe(false);
    expect(world.sides.every(side => side.middleTexture === 'SLADRIP1')).toBe(true);
    expect(world.sectors.every(sector => sector.floorTexture === 'NUKAGE1')).toBe(true);
    state.dispose();
  });

  it('fills E1M5 floor and ceiling spans shared across BSP leaves of a visible sector', () => {
    const world = createWorld(decodeMap(wad, 'E1M5'), { skill: 2 }), state = createWorldScene(world, resources);
    state.update({ x: -16.2177, y: 11.418, z: 41.176, angle: 16777216 });
    const drawnPlaneContains = (height: number): boolean => {
      for (const object of state.scene.children) {
        if (!(object instanceof Mesh) || object instanceof InstancedMesh) continue;
        const positions = object.geometry.getAttribute('position'), flat = object.geometry.getAttribute('flatSurface');
        for (let index = 0; index < object.geometry.drawRange.count; index += 3) {
          if (flat.getX(index) !== 1 || positions.getY(index) !== height) continue;
          const signs: number[] = [];
          for (let edge = 0; edge < 3; edge++) {
            const first = index + edge, second = index + (edge + 1) % 3;
            const x1 = positions.getX(first), y1 = -positions.getZ(first), x2 = positions.getX(second), y2 = -positions.getZ(second);
            signs.push((x2 - x1) * (40 - y1) - (y2 - y1) * (80 - x1));
          }
          if (signs.every(sign => sign >= -0.001) || signs.every(sign => sign <= 0.001)) return true;
        }
      }
      return false;
    };
    expect(drawnPlaneContains(0)).toBe(true);
    expect(drawnPlaneContains(72)).toBe(true);
    state.dispose();
  });
});
