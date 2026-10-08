import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWeaponPass } from '../../src/render/weapon';
import { createWorldScene } from '../../src/render/world';
import { StateId, states } from '../../src/simulation/data/states';
import { weapons } from '../../src/simulation/data/weapons';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { PowerType } from '../../src/simulation/player';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);

function scene() {
  const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });
  const rendered = createWorldScene(world, resources);
  const weapon = createWeaponPass(rendered.atlas, rendered.materials, resources);
  return { world, rendered, weapon, dispose: (): void => { weapon.dispose(); rendered.dispose(); } };
}

describe('native indexed weapon pass', () => {
  it.each([0, 1, 2, 3, 4, 7])('places original shareware weapon %i using native patch pivots', index => {
    const state = scene(), definition = weapons[index];
    if (!definition) throw new Error('Weapon definition missing');
    state.world.player.psprites[0] = { state: definition.readystate, tics: 1, sx: 160 * FRAC_UNIT, sy: 32 * FRAC_UNIT };
    state.weapon.update(state.world);
    const native = states[definition.readystate];
    if (!native) throw new Error('Weapon state missing');
    const image = resources.sprite(native.sprite, native.frame & 32767, 1).image;
    const positions = state.weapon.slots[0].mesh.geometry.getAttribute('position');
    expect(positions.getX(0)).toBe(160 - image.leftOffset);
    expect(168 - positions.getY(2)).toBe(84 - 100.5 + 32 - image.topOffset);
    expect(positions.getX(1) - positions.getX(0)).toBe(image.width);
    expect(state.weapon.activeSlots).toBe(1);
    expect(state.weapon.slots[1].mesh.visible).toBe(false);
    state.dispose();
  });

  it('routes all eight original Doom1 weapon states through their native sprite and frame', () => {
    const state = scene(), requested: { id: number; frame: number }[] = [], fallback = resources.sprite(states[StateId.S_PISTOL]?.sprite ?? 0, 0, 1);
    const weapon = createWeaponPass(state.rendered.atlas, state.rendered.materials, {
      ...resources, sprite(id, frame, rotation) { requested.push({ id, frame }); expect(rotation).toBe(1); return fallback; },
    });
    for (const definition of weapons.slice(0, 8)) {
      state.world.player.psprites[0] = { state: definition.readystate, tics: 1, sx: 160 * FRAC_UNIT, sy: 32 * FRAC_UNIT };
      weapon.update(state.world);
    }
    expect(requested).toEqual(weapons.slice(0, 8).map(definition => ({ id: states[definition.readystate]?.sprite, frame: (states[definition.readystate]?.frame ?? 0) & 32767 })));
    weapon.dispose(); state.dispose();
  });

  it('uses nearest-distance sector lighting and shared player palette/fixed-colormap uniforms', () => {
    const state = scene(), playerActor = state.world.actorsById.get(state.world.player.actorId);
    if (!playerActor) throw new Error('Player actor missing');
    const sector = state.world.sectors[playerActor.sector];
    if (!sector) throw new Error('Player sector missing');
    sector.lightLevel = 96;
    state.world.player.psprites[0].state = StateId.S_PISTOL;
    state.world.player.psprites[0].sx = 160 * FRAC_UNIT;
    state.world.player.psprites[0].sy = 32 * FRAC_UNIT;
    state.world.player.fixedColormap = 32;
    state.world.player.damageCount = 8;
    state.rendered.materials.updatePlayer(state.world.player);
    state.weapon.update(state.world);
    const mesh = state.weapon.slots[0].mesh;
    expect(mesh.geometry.getAttribute('lightLevel').getX(0)).toBe(96);
    expect(mesh.material.uniforms.uWeaponSurface?.value).toBe(1);
    expect(mesh.material.uniforms.uFixedColormap).toBe(state.rendered.materials.uniforms.uFixedColormap);
    expect(mesh.material.uniforms.uPaletteIndex).toBe(state.rendered.materials.uniforms.uPaletteIndex);
    expect(mesh.material.depthTest).toBe(false);
    expect(mesh.material.depthWrite).toBe(false);
    state.dispose();
  });

  it('renders fullbright muzzle flashes after the weapon and hides inactive slots', () => {
    const state = scene();
    state.world.player.psprites[0] = { state: StateId.S_PISTOL, tics: 1, sx: 160 * FRAC_UNIT, sy: 32 * FRAC_UNIT };
    state.world.player.psprites[1] = { state: StateId.S_PISTOLFLASH, tics: 1, sx: 160 * FRAC_UNIT, sy: 32 * FRAC_UNIT };
    state.weapon.update(state.world);
    expect(state.weapon.activeSlots).toBe(2);
    expect(state.weapon.slots[1].mesh.renderOrder).toBeGreaterThan(state.weapon.slots[0].mesh.renderOrder);
    expect(state.weapon.slots[1].mesh.geometry.getAttribute('fullbright').getX(0)).toBe(1);
    state.world.player.psprites[1].state = StateId.S_NULL;
    state.weapon.update(state.world);
    expect(state.weapon.activeSlots).toBe(1);
    expect(state.weapon.slots[1].mesh.visible).toBe(false);
    state.dispose();
  });

  it.each([[129, true], [128, false], [8, true], [7, false], [0, false]] as const)('uses native invisibility blinking at power %i', (power, invisible) => {
    const state = scene();
    state.world.player.powers[PowerType.pw_invisibility] = power;
    state.weapon.update(state.world);
    expect(state.weapon.invisible).toBe(invisible);
    state.dispose();
  });

  it('scales with viewport width while retaining native placement and reusable geometry', () => {
    const state = scene();
    state.world.player.psprites[0] = { state: StateId.S_PISTOL, tics: 1, sx: 160 * FRAC_UNIT, sy: 32 * FRAC_UNIT };
    state.weapon.update(state.world);
    const geometry = state.weapon.slots[0].mesh.geometry, positions = geometry.getAttribute('position'), before = [...positions.array];
    state.weapon.setView(640, 336); state.weapon.update(state.world);
    expect(state.weapon.slots[0].mesh.geometry).toBe(geometry);
    expect([...positions.array]).toEqual(before);
    expect(state.weapon.camera.right).toBe(320);
    expect(state.weapon.camera.top).toBe(168);
    state.dispose();
  });
});
