import {
  BufferAttribute, BufferGeometry, Camera, Color, DataTexture, DepthStencilFormat, DepthTexture, DynamicDrawUsage,
  InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, NearestFilter, NoColorSpace, PerspectiveCamera,
  RedFormat, RGBAFormat, Scene, ShaderMaterial, UnsignedByteType, UnsignedInt248Type, Vector2, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import type { Object3D } from 'three';
import { ANG45, angleToRadians, pointToAngle } from '../simulation/angle';
import { MobjFlag } from '../simulation/data/actors';
import { FRAC_UNIT } from '../simulation/fixed';
import type { World } from '../simulation/world';
import type { DoomResources } from '../wad/resources';
import type { Vertex } from '../wad/map';
import { packIndexedAtlas } from './atlas';
import type { AtlasRegion, IndexedAtlas } from './atlas';
import { buildSubsectorPolygons, wallQuads } from './geometry';
import type { Vertex3, WallQuad } from './geometry';
import { createNativeMaterials } from './materials';
import type { NativeMaterials } from './materials';
import { createSkyPass } from './sky';
import type { SkyPass } from './sky';
import { visibleGeometry } from './visibility';
import type { VisibleGeometry } from './visibility';
import { createWeaponPass } from './weapon';
import type { WeaponPass } from './weapon';

export interface RenderCamera { readonly x: number; readonly y: number; readonly z: number; readonly angle: number }
export interface WorldFrameStats {
  atlasPages: number;
  wallTriangles: number;
  flatTriangles: number;
  spriteTriangles: number;
  fuzzTriangles: number;
  skyTriangles: number;
  weaponTriangles: number;
  drawCalls: number;
}
export interface WorldScene {
  readonly scene: Scene;
  readonly skyMaskScene: Scene;
  readonly fuzzScene: Scene;
  readonly sky: SkyPass;
  readonly atlas: IndexedAtlas;
  readonly materials: NativeMaterials;
  readonly stats: WorldFrameStats;
  readonly spritePages: ReadonlyMap<InstancedMesh, number>;
  update(camera: RenderCamera, visibility?: VisibleGeometry): void;
  dispose(): void;
}
export interface WorldRenderer {
  readonly stats: WorldFrameStats | null;
  setWorld(world: World): void;
  resize(width: number, height: number): void;
  prepare(): Promise<void>;
  render(camera: RenderCamera): void;
  dispose(): void;
}

interface VertexData {
  position: Float32Array; uv: Float32Array; atlasRect: Float32Array;
  lightLevel: Float32Array; lightOffset: Float32Array; flatSurface: Float32Array; repeatTexture: Float32Array;
}
interface Batch { readonly mesh: Mesh<BufferGeometry, ShaderMaterial>; data: VertexData; capacity: number; count: number }
interface SpritePool { mesh: InstancedMesh<BufferGeometry, ShaderMaterial>; capacity: number; count: number; readonly page: number }

function element<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Invalid world rendering reference ${index}`);
  return value;
}
function region(atlas: IndexedAtlas, key: string): AtlasRegion {
  const value = atlas.regions.get(key);
  if (!value) throw new Error(`Missing world atlas region ${key}`);
  return value;
}
function vertexData(capacity: number): VertexData {
  return { position: new Float32Array(capacity * 3), uv: new Float32Array(capacity * 2), atlasRect: new Float32Array(capacity * 4),
    lightLevel: new Float32Array(capacity), lightOffset: new Float32Array(capacity), flatSurface: new Float32Array(capacity), repeatTexture: new Float32Array(capacity) };
}
function batch(material: ShaderMaterial, capacity = 4096): Batch {
  const data = vertexData(capacity), geometry = new BufferGeometry();
  for (const [name, array] of Object.entries(data)) {
    const size = name === 'position' ? 3 : name === 'uv' ? 2 : name === 'atlasRect' ? 4 : 1;
    geometry.setAttribute(name, new BufferAttribute(array, size).setUsage(DynamicDrawUsage));
  }
  geometry.setDrawRange(0, 0);
  const mesh = new Mesh(geometry, material); mesh.frustumCulled = false;
  return { mesh, data, capacity, count: 0 };
}
function reserve(target: Batch, count: number): void {
  if (target.count + count <= target.capacity) return;
  const grown = batch(target.mesh.material, Math.max(target.capacity * 2, target.count + count));
  for (const name of Object.keys(target.data) as (keyof VertexData)[]) grown.data[name].set(target.data[name]);
  target.mesh.geometry.dispose(); target.mesh.geometry = grown.mesh.geometry;
  target.data = grown.data; target.capacity = grown.capacity;
}
function append(target: Batch, point: Vertex3, u: number, v: number, rect: AtlasRegion, light: number, offset: number, flat: boolean, repeat = true): void {
  reserve(target, 1);
  const index = target.count++, data = target.data;
  data.position[index * 3] = point.x; data.position[index * 3 + 1] = point.z; data.position[index * 3 + 2] = -point.y;
  data.uv[index * 2] = u; data.uv[index * 2 + 1] = v;
  data.atlasRect[index * 4] = rect.x; data.atlasRect[index * 4 + 1] = rect.y;
  data.atlasRect[index * 4 + 2] = rect.width; data.atlasRect[index * 4 + 3] = rect.height;
  data.lightLevel[index] = light; data.lightOffset[index] = offset;
  data.flatSurface[index] = flat ? 1 : 0; data.repeatTexture[index] = repeat ? 1 : 0;
}
function finish(target: Batch): void {
  target.mesh.geometry.setDrawRange(0, target.count); target.mesh.visible = target.count !== 0;
  for (const attribute of Object.values(target.mesh.geometry.attributes)) {
    if (!(attribute instanceof BufferAttribute)) throw new Error('World batch must use contiguous vertex attributes');
    attribute.clearUpdateRanges(); attribute.addUpdateRange(0, target.count * attribute.itemSize); attribute.needsUpdate = target.count !== 0;
  }
}
function spritePool(material: ShaderMaterial, page: number, capacity: number): SpritePool {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]), 2));
  for (const name of ['atlasRect', 'lightLevel', 'fullbright', 'spriteSurface', 'spriteFlip']) {
    const size = name === 'atlasRect' ? 4 : 1;
    const array = new Float32Array(capacity * size);
    if (name === 'spriteSurface') array.fill(1);
    geometry.setAttribute(name, new InstancedBufferAttribute(array, size).setUsage(DynamicDrawUsage));
  }
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage); mesh.count = 0; mesh.frustumCulled = false;
  return { mesh, page, capacity, count: 0 };
}

export function createWorldScene(world: World, resources: DoomResources): WorldScene {
  const entries = resources.wallNames.map(name => ({ key: `wall:${name}`, image: resources.wall(name) }));
  for (const name of resources.flatNames) entries.push({ key: `flat:${name}`, image: resources.flat(name) });
  for (const id of resources.spriteIds) for (const frame of resources.spriteFrames(id)) entries.push({ key: `sprite:${frame.name}`, image: frame.image });
  const atlas = packIndexedAtlas(entries), materials = createNativeMaterials(atlas, resources);
  const scene = new Scene(), skyMaskScene = new Scene(), fuzzScene = new Scene();
  const sky = createSkyPass(atlas, materials, world.episode);
  const batches = materials.pages.map(material => batch(material));
  const skyBatch = batch(sky.maskMaterial);
  scene.add(...batches.map(batch => batch.mesh)); skyMaskScene.add(skyBatch.mesh);
  const pools = materials.pages.map((material, page) => spritePool(material, page, Math.max(64, world.actors.length)));
  const fuzzPools = materials.pages.map((material, page) => spritePool(material, page, Math.max(64, world.actors.length)));
  const spritePages = new Map<InstancedMesh, number>();
  for (const pool of pools) { scene.add(pool.mesh); spritePages.set(pool.mesh, pool.page); }
  for (const pool of fuzzPools) fuzzScene.add(pool.mesh);
  const polygons = buildSubsectorPolygons(world.spatial.map);
  const sectorLeaves: number[][] = Array.from({ length: world.sectors.length }, () => []);
  world.spatial.map.subsectors.forEach((leaf, index) => element(sectorLeaves, leaf.sector).push(index));
  const stats: WorldFrameStats = { atlasPages: atlas.pages.length, wallTriangles: 0, flatTriangles: 0, spriteTriangles: 0, fuzzTriangles: 0, skyTriangles: 0, weaponTriangles: 0, drawCalls: 0 };
  let wallTic = -1, walls: readonly WallQuad[] = [];
  const matrix = new Matrix4();
  const growPool = (pool: SpritePool, parent: Scene): void => {
    if (pool.count < pool.capacity) return;
    const grown = spritePool(pool.mesh.material, pool.page, pool.capacity * 2);
    grown.mesh.instanceMatrix.array.set(pool.mesh.instanceMatrix.array);
    for (const name of ['atlasRect', 'lightLevel', 'fullbright', 'spriteSurface', 'spriteFlip']) {
      const before = pool.mesh.geometry.getAttribute(name), after = grown.mesh.geometry.getAttribute(name);
      (after.array as Float32Array).set(before.array);
    }
    parent.remove(pool.mesh); spritePages.delete(pool.mesh);
    pool.mesh.geometry.dispose(); pool.mesh.dispose(); pool.mesh = grown.mesh; pool.capacity = grown.capacity;
    parent.add(pool.mesh); if (parent === scene) spritePages.set(pool.mesh, pool.page);
  };
  let disposed = false;
  return {
    scene, skyMaskScene, fuzzScene, sky, atlas, materials, stats, spritePages,
    update(camera, visibility = visibleGeometry(world, camera)): void {
      if (disposed) throw new Error('World scene is disposed');
      materials.updatePlayer(world.player);
      for (const segIndex of visibility.visibleSegs) {
        const seg = element(world.spatial.map.segs, segIndex), line = element(world.spatial.map.lines, seg.line);
        world.lineFlags[seg.line] = (world.lineFlags[seg.line] ?? line.flags) | 256;
      }
      if (wallTic !== world.levelTime) { walls = wallQuads(world, resources.textureHeight); wallTic = world.levelTime; }
      for (const target of batches) target.count = 0;
      skyBatch.count = 0; stats.wallTriangles = stats.flatTriangles = stats.spriteTriangles = stats.fuzzTriangles = 0;
      for (const wall of walls) {
        if (!visibility.visibleSegs.has(wall.seg)) continue;
        const rect = region(atlas, `wall:${resources.animatedWall(wall.texture, world.levelTime)}`), target = element(batches, rect.page);
        const offset = wall.vertices[0].y === wall.vertices[1].y ? -1 : wall.vertices[0].x === wall.vertices[1].x ? 1 : 0;
        for (const index of [0, 1, 2, 0, 2, 3]) {
          append(target, wall.vertices[index as 0 | 1 | 2 | 3], index === 0 || index === 3 ? wall.u1 : wall.u2, index < 2 ? wall.v1 : wall.v2, rect, wall.lightLevel, offset, false, !wall.masked);
        }
        stats.wallTriangles += 2;
      }
      // Native visplanes merge a sector across leaves. SEG-only BSP bboxes can
      // omit a leaf whose reconstructed flat polygon still spans the view.
      // Keep wall occlusion native; submit planes for visible sectors to depth-test.
      for (const sectorIndex of visibility.visibleSectors) for (const index of element(sectorLeaves, sectorIndex)) {
        const leaf = element(world.spatial.map.subsectors, index), sector = element(world.sectors, leaf.sector), polygon = element(polygons, index);
        for (const ceiling of [false, true]) {
          const name = ceiling ? sector.ceilingTexture : sector.floorTexture, height = (ceiling ? sector.ceilingHeight : sector.floorHeight) / FRAC_UNIT;
          const isSky = name === 'F_SKY1', rect = region(atlas, `flat:${resources.animatedFlat(name, world.levelTime)}`), target = isSky ? skyBatch : element(batches, rect.page);
          for (let triangle = 1; triangle < polygon.length - 1; triangle++) {
            const points: readonly Vertex[] = [element(polygon, 0), element(polygon, ceiling ? triangle + 1 : triangle), element(polygon, ceiling ? triangle : triangle + 1)];
            for (const point of points) append(target, { ...point, z: height }, point.x, -point.y, rect, sector.lightLevel, 0, true);
            if (!isSky) stats.flatTriangles++;
          }
        }
      }
      // The native sky-sky hack also exposes the vertical gap between unequal ceilings.
      for (const segIndex of visibility.visibleSegs) {
        const map = world.spatial.map, seg = element(map.segs, segIndex), line = element(map.lines, seg.line);
        if (line.backSide === null || ((world.lineFlags[seg.line] ?? line.flags) & 4) === 0) continue;
        const frontSide = seg.side === 0 ? line.frontSide : line.backSide, backSide = seg.side === 0 ? line.backSide : line.frontSide;
        const front = element(world.sectors, element(map.sides, frontSide).sector), back = element(world.sectors, element(map.sides, backSide).sector);
        if (front.ceilingTexture !== 'F_SKY1' || back.ceilingTexture !== 'F_SKY1' || front.ceilingHeight <= back.ceilingHeight) continue;
        const start = element(map.vertices, seg.v1), end = element(map.vertices, seg.v2), bottom = back.ceilingHeight / FRAC_UNIT, top = front.ceilingHeight / FRAC_UNIT;
        const points = [{ ...start, z: bottom }, { ...end, z: bottom }, { ...end, z: top }, { ...start, z: top }], rect = region(atlas, 'flat:F_SKY1');
        for (const index of [0, 1, 2, 0, 2, 3]) append(skyBatch, element(points, index), 0, 0, rect, 255, 0, false);
      }
      for (const pool of [...pools, ...fuzzPools]) pool.count = 0;
      const radians = angleToRadians(camera.angle), rightX = Math.sin(radians), rightZ = Math.cos(radians);
      for (const actor of world.actors) {
        if (actor.removed || actor.player !== null || !visibility.visibleSectors.has(actor.sector)) continue;
        const angle = pointToAngle(Math.round(camera.x * FRAC_UNIT), Math.round(camera.y * FRAC_UNIT), actor.x, actor.y);
        const rotation = ((angle - actor.angle + ANG45 / 2 * 9) >>> 29) + 1;
        const sprite = resources.sprite(actor.sprite, actor.frame & 32767, rotation), rect = region(atlas, `sprite:${sprite.name}`);
        const shadow = (actor.flags & MobjFlag.MF_SHADOW) !== 0, pool = element(shadow ? fuzzPools : pools, rect.page);
        growPool(pool, shadow ? fuzzScene : scene);
        const instance = pool.count++;
        const x = actor.x / FRAC_UNIT - rect.leftOffset * rightX, y = actor.z / FRAC_UNIT + rect.topOffset - rect.height, z = -actor.y / FRAC_UNIT - rect.leftOffset * rightZ;
        matrix.set(rightX * rect.width, 0, -rightZ, x, 0, rect.height, 0, y, rightZ * rect.width, 0, rightX, z, 0, 0, 0, 1);
        pool.mesh.setMatrixAt(instance, matrix);
        pool.mesh.geometry.getAttribute('atlasRect').setXYZW(instance, rect.x, rect.y, rect.width, rect.height);
        pool.mesh.geometry.getAttribute('lightLevel').setX(instance, element(world.sectors, actor.sector).lightLevel);
        pool.mesh.geometry.getAttribute('fullbright').setX(instance, (actor.frame & 32768) !== 0 ? 1 : 0);
        pool.mesh.geometry.getAttribute('spriteFlip').setX(instance, sprite.flip ? 1 : 0);
        if (shadow) stats.fuzzTriangles += 2; else stats.spriteTriangles += 2;
      }
      for (const pool of [...pools, ...fuzzPools]) {
        pool.mesh.count = pool.count; pool.mesh.visible = pool.count !== 0;
        pool.mesh.instanceMatrix.needsUpdate = pool.count !== 0;
        for (const name of ['atlasRect', 'lightLevel', 'fullbright', 'spriteFlip']) pool.mesh.geometry.getAttribute(name).needsUpdate = pool.count !== 0;
      }
      for (const target of [...batches, skyBatch]) finish(target);
      stats.skyTriangles = skyBatch.count / 3;
      stats.drawCalls = batches.filter(batch => batch.count !== 0).length + pools.filter(pool => pool.count !== 0).length + fuzzPools.filter(pool => pool.count !== 0).length + (skyBatch.count ? 2 : 0) + (stats.fuzzTriangles ? 2 : 1);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const target of [...batches, skyBatch]) target.mesh.geometry.dispose();
      for (const pool of [...pools, ...fuzzPools]) { pool.mesh.geometry.dispose(); pool.mesh.dispose(); }
      sky.dispose(); materials.dispose();
    },
  };
}

const fuzzPattern = [1, -1, 1, -1, 1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, -1, -1, -1,
  1, -1, -1, 1, 1, 1, 1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1, -1, 1, 1, -1, 1];

const fuzzFragmentShader = `
uniform sampler2D uAtlas;
uniform sampler2D uBackground;
#ifndef FUZZ_SCREENSPACE
uniform sampler2D uDepth;
#endif
uniform sampler2D uPattern;
uniform sampler2D uPalette;
uniform sampler2D uColormap;
uniform vec2 uAtlasSize;
uniform vec2 uResolution;
uniform float uPaletteIndex;
uniform float uFuzzPhase;
varying vec2 vTexel;
varying vec4 vAtlasRect;
void main() {
  vec2 pixelUV = gl_FragCoord.xy / uResolution;
#ifndef FUZZ_SCREENSPACE
  if (gl_FragCoord.z > texture2D(uDepth, pixelUV).r + 0.000001) discard;
#endif
  if (gl_FragCoord.y < 1.0 || gl_FragCoord.y > uResolution.y - 1.0) discard;
  vec2 localTexel = clamp(vTexel, vec2(0.0), vAtlasRect.zw - vec2(0.001));
  vec2 glyphUV = (vAtlasRect.xy + floor(localTexel) + vec2(0.5)) / uAtlasSize;
  if (texture2D(uAtlas, glyphUV).g < 0.5) discard;
  // GPU pixels sample the opaque frame simultaneously; native columns read prior writes.
  float phase = mod(floor(gl_FragCoord.x) * uResolution.y + floor(uResolution.y - gl_FragCoord.y) + uFuzzPhase, 50.0);
  float direction = 1.0 - 2.0 * texture2D(uPattern, vec2((phase + 0.5) / 50.0, 0.5)).r;
  float index = floor(texture2D(uBackground, pixelUV + vec2(0.0, direction / uResolution.y)).a * 255.0 + 0.5);
  float mapped = floor(texture2D(uColormap, vec2((index + 0.5) / 256.0, 6.5 / 34.0)).r * 255.0 + 0.5);
  vec3 color = texture2D(uPalette, vec2((mapped + 0.5) / 256.0, (uPaletteIndex + 0.5) / 14.0)).rgb;
  gl_FragColor = vec4(color, mapped / 255.0);
}
`;

export function createWorldRenderer(canvas: HTMLCanvasElement, resources: DoomResources): WorldRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, premultipliedAlpha: false, stencil: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.autoClear = false; renderer.info.autoReset = false;
  const camera = new PerspectiveCamera(60, 1.6, 0.1, 65536);
  const depth = new DepthTexture(320, 200, UnsignedInt248Type); depth.format = DepthStencilFormat;
  const opaque = new WebGLRenderTarget(320, 200, { format: RGBAFormat, depthBuffer: true, stencilBuffer: true, depthTexture: depth, minFilter: NearestFilter, magFilter: NearestFilter });
  const composed = new WebGLRenderTarget(320, 200, { format: RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
  opaque.texture.colorSpace = composed.texture.colorSpace = NoColorSpace;
  const pattern = new DataTexture(Uint8Array.from(fuzzPattern, value => value > 0 ? 255 : 0), 50, 1, RedFormat, UnsignedByteType);
  pattern.minFilter = pattern.magFilter = NearestFilter; pattern.colorSpace = NoColorSpace; pattern.needsUpdate = true;
  const resolution = new Vector2(320, 200), phase = { value: 0 };
  const copyGeometry = new BufferGeometry();
  copyGeometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const copyUniforms = { uSource: { value: opaque.texture }, uFinal: { value: 0 } };
  const copyMaterial = new ShaderMaterial({
    name: 'Doom frame copy',
    uniforms: copyUniforms, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec2 vUV; void main() { vUV = (position.xy + vec2(1.0)) * 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D uSource; uniform float uFinal; varying vec2 vUV; void main() { vec4 color = texture2D(uSource, vUV); gl_FragColor = vec4(color.rgb, mix(color.a, 1.0, uFinal)); }',
  });
  const copyMesh = new Mesh(copyGeometry, copyMaterial); copyMesh.frustumCulled = false;
  const copyScene = new Scene(); copyScene.add(copyMesh); const copyCamera = new Camera();
  const clearColor = new Color(), palette = new DataView(resources.palettes.buffer, resources.palettes.byteOffset, resources.palettes.byteLength);
  let current: WorldScene | null = null, currentWorld: World | null = null, weapon: WeaponPass | null = null;
  let fuzzMaterials: ShaderMaterial[] = [], weaponFuzzMaterials: ShaderMaterial[] = [], disposed = false;
  let generation = 0, preparation: Promise<void> | null = null;
  const createFuzzMaterials = (state: WorldScene, screenspace: boolean): ShaderMaterial[] => state.materials.pages.map((base, page) => {
    const texture = element(state.materials.atlasTextures, page), atlasPage = element(state.atlas.pages, page);
    const material = new ShaderMaterial({
      name: `Doom native ${screenspace ? 'weapon' : 'actor'} fuzz ${page}`,
      vertexShader: base.vertexShader, fragmentShader: fuzzFragmentShader,
      defines: screenspace ? { FUZZ_SCREENSPACE: 1 } : {}, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { ...state.materials.uniforms, uAtlas: { value: texture }, uAtlasSize: { value: new Vector2(atlasPage.width, atlasPage.height) },
        uBackground: { value: opaque.texture }, ...(screenspace ? {} : { uDepth: { value: depth } }),
        uPattern: { value: pattern }, uResolution: { value: resolution }, uFuzzPhase: phase },
    });
    Object.assign(material.defaultAttributeValues, base.defaultAttributeValues);
    return material;
  });
  const resize = (width: number, height: number): void => {
    if (disposed) throw new Error('World renderer is disposed');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid world renderer resolution');
    generation++; preparation = null;
    renderer.setSize(width, height, false); opaque.setSize(width, height); composed.setSize(width, height); resolution.set(width, height);
    camera.aspect = width / height;
    // Vanilla projects with half the screen width: a fixed 90-degree horizontal FOV.
    camera.fov = 2 * Math.atan(height / width) * 180 / Math.PI; camera.updateProjectionMatrix();
    current?.materials.setView(width, width / 2);
    weapon?.setView(width, height);
  };
  resize(320, 168);
  return {
    get stats(): WorldFrameStats | null { return current?.stats ?? null; },
    setWorld(world): void {
      if (disposed) throw new Error('World renderer is disposed');
      const next = createWorldScene(world, resources);
      generation++; preparation = null;
      weapon?.dispose(); current?.dispose(); for (const material of [...fuzzMaterials, ...weaponFuzzMaterials]) material.dispose();
      current = next; currentWorld = world;
      next.materials.setView(resolution.x, resolution.x / 2);
      weapon = createWeaponPass(next.atlas, next.materials, resources); weapon.setView(resolution.x, resolution.y);
      fuzzMaterials = createFuzzMaterials(next, false); weaponFuzzMaterials = createFuzzMaterials(next, true);
      for (const [page, object] of next.fuzzScene.children.entries()) {
        if (object instanceof InstancedMesh) object.material = element(fuzzMaterials, page);
      }
    },
    resize,
    prepare(): Promise<void> {
      if (disposed) return Promise.reject(new Error('World renderer is disposed'));
      if (!current || !weapon) return Promise.reject(new Error('Set a world before preparing its renderer'));
      if (preparation) return preparation;
      const state = current, preparedWeapon = weapon, version = generation;
      const ensureCurrent = (): void => {
        if (disposed) throw new Error('World renderer is disposed');
        if (version !== generation) throw new Error('World renderer changed during preparation');
      };
      // Borrow existing geometry: shader compilation does not draw or allocate
      // additional weapon buffers, and includes even pages not visible yet.
      const weaponScene = new Scene(), weaponFuzzScene = new Scene();
      weaponScene.add(new Mesh(preparedWeapon.slots[0].mesh.geometry, [...preparedWeapon.materials]));
      weaponFuzzScene.add(new Mesh(preparedWeapon.slots[0].mesh.geometry, [...weaponFuzzMaterials]));
      const compile = (scene: Object3D, viewCamera: Camera, target: WebGLRenderTarget | null, targetScene?: Scene) => {
        ensureCurrent();
        const previousTarget = renderer.getRenderTarget();
        try {
          // Three's shader cache distinguishes render-target and canvas color
          // spaces, so compile each variant under its actual destination.
          renderer.setRenderTarget(target);
          return renderer.compileAsync(scene, viewCamera, targetScene);
        } finally { renderer.setRenderTarget(previousTarget); }
      };
      const prepare = async (): Promise<void> => {
        try {
          renderer.initRenderTarget(opaque); renderer.initRenderTarget(composed);
          for (const texture of [...state.materials.atlasTextures, state.materials.paletteTexture, state.materials.colormapTexture, pattern]) renderer.initTexture(texture);
          // Batches and instanced sprites share materials. Three waits on each
          // material's currentProgram, so finish one object variant at a time.
          for (const object of state.scene.children) { await compile(object, camera, opaque, state.scene); ensureCurrent(); }
          const passes: readonly (readonly [Scene, Camera, WebGLRenderTarget | null])[] = [
            [state.fuzzScene, camera, composed],
            [state.skyMaskScene, camera, opaque], [state.sky.scene, state.sky.camera, opaque],
            [weaponScene, preparedWeapon.camera, opaque], [weaponFuzzScene, preparedWeapon.camera, composed],
            [copyScene, copyCamera, composed], [copyScene, copyCamera, null],
          ];
          for (const [scene, viewCamera, target] of passes) { await compile(scene, viewCamera, target); ensureCurrent(); }
        } finally { weaponScene.clear(); weaponFuzzScene.clear(); }
      };
      // Three compileAsync also waits for completion when parallel shader
      // compilation is unavailable; no extension-specific fallback is needed.
      preparation = prepare().catch((error: unknown) => {
        if (version === generation) preparation = null;
        throw error;
      });
      return preparation;
    },
    render(view): void {
      if (disposed) throw new Error('World renderer is disposed');
      if (!current || !currentWorld) return;
      current.update(view);
      weapon?.update(currentWorld);
      current.stats.weaponTriangles = (weapon?.activeSlots ?? 0) * 2;
      const angle = angleToRadians(view.angle);
      camera.position.set(view.x, view.z, -view.y); camera.lookAt(view.x + Math.cos(angle), view.z, -view.y - Math.sin(angle));
      current.sky.setView(resolution.x, resolution.y, view.angle, resolution.x / 2);
      const index = current.materials.uniforms.uPaletteIndex.value * 768;
      clearColor.setRGB(palette.getUint8(index) / 255, palette.getUint8(index + 1) / 255, palette.getUint8(index + 2) / 255);
      renderer.setRenderTarget(opaque); renderer.setClearColor(clearColor, 0); renderer.info.reset(); renderer.clear(true, true, true);
      renderer.render(current.scene, camera);
      if (current.stats.skyTriangles !== 0) {
        // Opaque depth must exist before the stencil mask, or sky could overwrite walls.
        renderer.render(current.skyMaskScene, camera); renderer.render(current.sky.scene, current.sky.camera);
      }
      let frame = opaque;
      if (current.stats.fuzzTriangles !== 0) {
        renderer.setRenderTarget(composed); renderer.clear(true, false, false);
        copyUniforms.uSource.value = opaque.texture; copyUniforms.uFinal.value = 0; renderer.render(copyScene, copyCamera);
        phase.value = currentWorld.levelTime % 50; renderer.render(current.fuzzScene, camera);
        frame = composed;
      }
      if (weapon && weapon.activeSlots !== 0) {
        if (weapon.invisible) {
          const destination = frame === opaque ? composed : opaque;
          renderer.setRenderTarget(destination);
          copyUniforms.uSource.value = frame.texture; copyUniforms.uFinal.value = 0; renderer.render(copyScene, copyCamera);
          for (const material of weaponFuzzMaterials) {
            const background = material.uniforms.uBackground;
            if (!background) throw new Error('Weapon fuzz background sampler is unavailable');
            background.value = frame.texture;
          }
          phase.value = currentWorld.levelTime % 50; weapon.useMaterials(weaponFuzzMaterials);
          renderer.render(weapon.scene, weapon.camera); frame = destination;
        } else {
          renderer.setRenderTarget(frame); renderer.render(weapon.scene, weapon.camera);
        }
      }
      copyUniforms.uSource.value = frame.texture;
      renderer.setRenderTarget(null); copyUniforms.uFinal.value = 1; renderer.render(copyScene, copyCamera);
      current.stats.drawCalls = renderer.info.render.calls;
    },
    dispose(): void {
      if (disposed) return;
      generation++; preparation = null;
      disposed = true; weapon?.dispose(); current?.dispose(); for (const material of [...fuzzMaterials, ...weaponFuzzMaterials]) material.dispose();
      // The opaque target owns its depth texture; Three disposes that attachment with it.
      opaque.dispose(); composed.dispose(); pattern.dispose(); copyGeometry.dispose(); copyMaterial.dispose(); renderer.dispose();
    },
  };
}
