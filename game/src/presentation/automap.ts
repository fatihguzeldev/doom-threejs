import { MobjFlag } from '../simulation/data/actors';
import { PowerType } from '../simulation/player';
import { angleToRadians } from '../simulation/angle';
import { FRAC_UNIT } from '../simulation/fixed';
import type { World } from '../simulation/world';
import type { DoomResources } from '../wad/resources';

export function drawAutomap(context: CanvasRenderingContext2D, world: World, resources: DoomResources, zoom: number, reveal: 0 | 1 | 2 = 0): void {
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) return;
  context.fillStyle = '#000'; context.fillRect(0, 0, 320, 168);
  const x = actor.x / FRAC_UNIT, y = actor.y / FRAC_UNIT, scale = zoom / 8;
  const screenX = (value: number): number => 160 + (value - x) * scale;
  const screenY = (value: number): number => 84 - (value - y) * scale;
  const color = (index: number): string => `rgb(${resources.palettes[index * 3] ?? 0} ${resources.palettes[index * 3 + 1] ?? 0} ${resources.palettes[index * 3 + 2] ?? 0})`;
  context.save(); context.beginPath(); context.rect(0, 0, 320, 168); context.clip();
  context.lineWidth = 1;
  for (const [index, line] of world.spatial.map.lines.entries()) {
    const flags = world.lineFlags[index] ?? 0;
    if (reveal === 0 && ((flags & 128) !== 0 || ((flags & 256) === 0 && !world.player.powers[PowerType.pw_allmap]))) continue;
    const first = world.spatial.map.vertices[line.v1], second = world.spatial.map.vertices[line.v2];
    if (!first || !second) throw new Error('Automap has invalid vertices');
    const fixed = world.spatial.lines[index], front = fixed ? world.sectors[fixed.frontSector] : undefined;
    const back = fixed?.backSector == null ? null : world.sectors[fixed.backSector];
    let shade = 176;
    if (reveal === 0 && (flags & 256) === 0) shade = 99;
    else if (line.special === 39) shade = 184;
    else if ((flags & 32) !== 0 || !back || !front) shade = 176;
    else if (front.floorHeight !== back.floorHeight) shade = 64;
    else if (front.ceilingHeight !== back.ceilingHeight) shade = 231;
    else if (reveal > 0) shade = 96;
    else continue;
    context.strokeStyle = color(shade); context.beginPath();
    context.moveTo(screenX(first.x), screenY(first.y)); context.lineTo(screenX(second.x), screenY(second.y)); context.stroke();
  }
  if (reveal === 2) {
    context.strokeStyle = color(112);
    for (const thing of world.actors) {
      if (thing.id === actor.id || thing.removed) continue;
      const cx = screenX(thing.x / FRAC_UNIT), cy = screenY(thing.y / FRAC_UNIT);
      context.save(); context.translate(cx, cy); context.rotate(-angleToRadians(thing.angle));
      context.beginPath(); context.moveTo(4, 0); context.lineTo(-2, -2); context.lineTo(-2, 2); context.closePath(); context.stroke(); context.restore();
    }
  }
  const angle = angleToRadians(actor.angle);
  context.translate(160, 84); context.rotate(-angle); context.strokeStyle = color((actor.flags & MobjFlag.MF_SHADOW) !== 0 ? 246 : 209);
  context.beginPath(); context.moveTo(-8, 0); context.lineTo(8, 0); context.lineTo(2, -4);
  context.moveTo(8, 0); context.lineTo(2, 4); context.stroke(); context.restore();
}
