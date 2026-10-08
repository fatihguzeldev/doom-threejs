import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, OrthographicCamera, Scene, ShaderMaterial } from 'three';
import { StateId, states } from '../simulation/data/states';
import { FRAC_UNIT } from '../simulation/fixed';
import { PowerType } from '../simulation/player';
import type { World } from '../simulation/world';
import type { DoomResources } from '../wad/resources';
import type { IndexedAtlas } from './atlas';
import type { NativeMaterials } from './materials';

export interface WeaponSlot {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly page: number;
}
export interface WeaponPass {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly slots: readonly [WeaponSlot, WeaponSlot];
  readonly activeSlots: number;
  readonly invisible: boolean;
  setView(width: number, height: number): void;
  update(world: World): void;
  useMaterials(pages: readonly ShaderMaterial[]): void;
  dispose(): void;
}

export function createWeaponPass(atlas: IndexedAtlas, materials: NativeMaterials, resources: DoomResources): WeaponPass {
  const pages = materials.pages.map((base, page) => {
    const material = new ShaderMaterial({
      name: `Doom indexed weapon atlas ${page}`, vertexShader: base.vertexShader, fragmentShader: base.fragmentShader,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { ...base.uniforms, uWeaponSurface: { value: 1 } },
    });
    Object.assign(material.defaultAttributeValues, base.defaultAttributeValues);
    return material;
  });
  const initial = pages[0];
  if (!initial) throw new Error('Weapon pass requires an indexed atlas page');
  const scene = new Scene(), camera = new OrthographicCamera(0, 320, 168, 0, 0.1, 10);
  camera.position.z = 1;
  const createSlot = (index: number): { readonly mesh: Mesh<BufferGeometry, ShaderMaterial>; page: number } => {
    const geometry = new BufferGeometry();
    for (const [name, size] of [['position', 3], ['uv', 2], ['atlasRect', 4], ['lightLevel', 1], ['fullbright', 1], ['spriteFlip', 1]] as const) {
      geometry.setAttribute(name, new BufferAttribute(new Float32Array(6 * size), size).setUsage(DynamicDrawUsage));
    }
    const mesh = new Mesh(geometry, initial); mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = index;
    scene.add(mesh);
    return { mesh, page: 0 };
  };
  const slots: readonly [ReturnType<typeof createSlot>, ReturnType<typeof createSlot>] = [createSlot(0), createSlot(1)];
  let activeSlots = 0, invisible = false, disposed = false, logicalHeight = 168;
  const useMaterials = (selected: readonly ShaderMaterial[]): void => {
    for (const slot of slots) {
      const material = selected[slot.page];
      if (!material) throw new Error(`Weapon atlas material ${slot.page} is unavailable`);
      slot.mesh.material = material;
    }
  };
  return {
    scene, camera, slots,
    get activeSlots(): number { return activeSlots; },
    get invisible(): boolean { return invisible; },
    setView(width, height): void {
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error('Invalid weapon viewport');
      logicalHeight = height * 320 / width;
      camera.top = logicalHeight; camera.updateProjectionMatrix();
    },
    update(world): void {
      if (disposed) throw new Error('Weapon pass is disposed');
      activeSlots = 0;
      const power = world.player.powers[PowerType.pw_invisibility] ?? 0;
      invisible = power > 128 || (power & 8) !== 0;
      const actor = world.actorsById.get(world.player.actorId), sector = actor ? world.sectors[actor.sector] : undefined;
      if (!sector) throw new Error('Weapon player sector is unavailable');
      for (const [index, slot] of slots.entries()) {
        const psprite = world.player.psprites[index];
        if (!psprite) throw new Error('Native player weapon slot is unavailable');
        slot.mesh.visible = false;
        if (psprite.state === StateId.S_NULL) continue;
        const state = states[psprite.state];
        if (!state) throw new Error(`Native weapon state ${psprite.state} is unavailable`);
        const sprite = resources.sprite(state.sprite, state.frame & 32767, 1), rect = atlas.regions.get(`sprite:${sprite.name}`);
        if (!rect) throw new Error(`Weapon atlas region ${sprite.name} is unavailable`);
        slot.page = rect.page;
        const left = psprite.sx / FRAC_UNIT - rect.leftOffset, top = logicalHeight / 2 - 100.5 + psprite.sy / FRAC_UNIT - rect.topOffset;
        if (left > 320 || left + rect.width < 0 || top > logicalHeight || top + rect.height < 0) continue;
        const bottom = top + rect.height;
        const points = [[left, bottom, 0, rect.height], [left + rect.width, bottom, rect.width, rect.height], [left + rect.width, top, rect.width, 0],
          [left, bottom, 0, rect.height], [left + rect.width, top, rect.width, 0], [left, top, 0, 0]] as const;
        const geometry = slot.mesh.geometry;
        for (const [vertex, point] of points.entries()) {
          geometry.getAttribute('position').setXYZ(vertex, point[0], logicalHeight - point[1], 0);
          geometry.getAttribute('uv').setXY(vertex, point[2], point[3]);
          geometry.getAttribute('atlasRect').setXYZW(vertex, rect.x, rect.y, rect.width, rect.height);
          geometry.getAttribute('lightLevel').setX(vertex, sector.lightLevel);
          geometry.getAttribute('fullbright').setX(vertex, (state.frame & 32768) !== 0 ? 1 : 0);
          geometry.getAttribute('spriteFlip').setX(vertex, sprite.flip ? 1 : 0);
        }
        for (const attribute of Object.values(geometry.attributes)) attribute.needsUpdate = true;
        slot.mesh.visible = true; activeSlots++;
      }
      useMaterials(pages);
    },
    useMaterials,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const slot of slots) slot.mesh.geometry.dispose();
      for (const material of pages) material.dispose();
    },
  };
}
