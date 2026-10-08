// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only; see ../../LICENSE.
// Native rules and S_sfx metadata from pinned original s_sound.c / sounds.c.
import { SfxId } from '../simulation/data/actors';
import { fineSin, pointToAngle } from '../simulation/angle';
import { fixedMul, FRAC_UNIT } from '../simulation/fixed';

export interface AudioPosition { readonly x: number; readonly y: number }
export interface AudioListener extends AudioPosition { readonly actor: number; readonly angle: number }
export interface SoundDefinition { readonly name: string; readonly priority: number; readonly pitch: number }
export interface SoundParameters { readonly volume: number; readonly separation: number }

export const soundDefinitions: readonly SoundDefinition[] = [
  { name: 'none', priority: 0, pitch: 128 },
  { name: 'pistol', priority: 64, pitch: 128 },
  { name: 'shotgn', priority: 64, pitch: 128 },
  { name: 'sgcock', priority: 64, pitch: 128 },
  { name: 'dshtgn', priority: 64, pitch: 128 },
  { name: 'dbopn', priority: 64, pitch: 128 },
  { name: 'dbcls', priority: 64, pitch: 128 },
  { name: 'dbload', priority: 64, pitch: 128 },
  { name: 'plasma', priority: 64, pitch: 128 },
  { name: 'bfg', priority: 64, pitch: 128 },
  { name: 'sawup', priority: 64, pitch: 128 },
  { name: 'sawidl', priority: 118, pitch: 128 },
  { name: 'sawful', priority: 64, pitch: 128 },
  { name: 'sawhit', priority: 64, pitch: 128 },
  { name: 'rlaunc', priority: 64, pitch: 128 },
  { name: 'rxplod', priority: 70, pitch: 128 },
  { name: 'firsht', priority: 70, pitch: 128 },
  { name: 'firxpl', priority: 70, pitch: 128 },
  { name: 'pstart', priority: 100, pitch: 128 },
  { name: 'pstop', priority: 100, pitch: 128 },
  { name: 'doropn', priority: 100, pitch: 128 },
  { name: 'dorcls', priority: 100, pitch: 128 },
  { name: 'stnmov', priority: 119, pitch: 128 },
  { name: 'swtchn', priority: 78, pitch: 128 },
  { name: 'swtchx', priority: 78, pitch: 128 },
  { name: 'plpain', priority: 96, pitch: 128 },
  { name: 'dmpain', priority: 96, pitch: 128 },
  { name: 'popain', priority: 96, pitch: 128 },
  { name: 'vipain', priority: 96, pitch: 128 },
  { name: 'mnpain', priority: 96, pitch: 128 },
  { name: 'pepain', priority: 96, pitch: 128 },
  { name: 'slop', priority: 78, pitch: 128 },
  { name: 'itemup', priority: 78, pitch: 128 },
  { name: 'wpnup', priority: 78, pitch: 128 },
  { name: 'oof', priority: 96, pitch: 128 },
  { name: 'telept', priority: 32, pitch: 128 },
  { name: 'posit1', priority: 98, pitch: 128 },
  { name: 'posit2', priority: 98, pitch: 128 },
  { name: 'posit3', priority: 98, pitch: 128 },
  { name: 'bgsit1', priority: 98, pitch: 128 },
  { name: 'bgsit2', priority: 98, pitch: 128 },
  { name: 'sgtsit', priority: 98, pitch: 128 },
  { name: 'cacsit', priority: 98, pitch: 128 },
  { name: 'brssit', priority: 94, pitch: 128 },
  { name: 'cybsit', priority: 92, pitch: 128 },
  { name: 'spisit', priority: 90, pitch: 128 },
  { name: 'bspsit', priority: 90, pitch: 128 },
  { name: 'kntsit', priority: 90, pitch: 128 },
  { name: 'vilsit', priority: 90, pitch: 128 },
  { name: 'mansit', priority: 90, pitch: 128 },
  { name: 'pesit', priority: 90, pitch: 128 },
  { name: 'sklatk', priority: 70, pitch: 128 },
  { name: 'sgtatk', priority: 70, pitch: 128 },
  { name: 'skepch', priority: 70, pitch: 128 },
  { name: 'vilatk', priority: 70, pitch: 128 },
  { name: 'claw', priority: 70, pitch: 128 },
  { name: 'skeswg', priority: 70, pitch: 128 },
  { name: 'pldeth', priority: 32, pitch: 128 },
  { name: 'pdiehi', priority: 32, pitch: 128 },
  { name: 'podth1', priority: 70, pitch: 128 },
  { name: 'podth2', priority: 70, pitch: 128 },
  { name: 'podth3', priority: 70, pitch: 128 },
  { name: 'bgdth1', priority: 70, pitch: 128 },
  { name: 'bgdth2', priority: 70, pitch: 128 },
  { name: 'sgtdth', priority: 70, pitch: 128 },
  { name: 'cacdth', priority: 70, pitch: 128 },
  { name: 'skldth', priority: 70, pitch: 128 },
  { name: 'brsdth', priority: 32, pitch: 128 },
  { name: 'cybdth', priority: 32, pitch: 128 },
  { name: 'spidth', priority: 32, pitch: 128 },
  { name: 'bspdth', priority: 32, pitch: 128 },
  { name: 'vildth', priority: 32, pitch: 128 },
  { name: 'kntdth', priority: 32, pitch: 128 },
  { name: 'pedth', priority: 32, pitch: 128 },
  { name: 'skedth', priority: 32, pitch: 128 },
  { name: 'posact', priority: 120, pitch: 128 },
  { name: 'bgact', priority: 120, pitch: 128 },
  { name: 'dmact', priority: 120, pitch: 128 },
  { name: 'bspact', priority: 100, pitch: 128 },
  { name: 'bspwlk', priority: 100, pitch: 128 },
  { name: 'vilact', priority: 100, pitch: 128 },
  { name: 'noway', priority: 78, pitch: 128 },
  { name: 'barexp', priority: 60, pitch: 128 },
  { name: 'punch', priority: 64, pitch: 128 },
  { name: 'hoof', priority: 70, pitch: 128 },
  { name: 'metal', priority: 70, pitch: 128 },
  { name: 'pistol', priority: 64, pitch: 150 },
  { name: 'tink', priority: 60, pitch: 128 },
  { name: 'bdopn', priority: 100, pitch: 128 },
  { name: 'bdcls', priority: 100, pitch: 128 },
  { name: 'itmbk', priority: 100, pitch: 128 },
  { name: 'flame', priority: 32, pitch: 128 },
  { name: 'flamst', priority: 32, pitch: 128 },
  { name: 'getpow', priority: 60, pitch: 128 },
  { name: 'bospit', priority: 70, pitch: 128 },
  { name: 'boscub', priority: 70, pitch: 128 },
  { name: 'bossit', priority: 70, pitch: 128 },
  { name: 'bospn', priority: 70, pitch: 128 },
  { name: 'bosdth', priority: 70, pitch: 128 },
  { name: 'manatk', priority: 70, pitch: 128 },
  { name: 'mandth', priority: 70, pitch: 128 },
  { name: 'sssit', priority: 70, pitch: 128 },
  { name: 'ssdth', priority: 70, pitch: 128 },
  { name: 'keenpn', priority: 70, pitch: 128 },
  { name: 'keendt', priority: 70, pitch: 128 },
  { name: 'skeact', priority: 70, pitch: 128 },
  { name: 'skesit', priority: 70, pitch: 128 },
  { name: 'skeatk', priority: 70, pitch: 128 },
  { name: 'radio', priority: 60, pitch: 128 },
];

export function soundParameters(listener: AudioListener, source: AudioPosition | null,
  mapNumber: number): SoundParameters | null {
  if (!source || (source.x === listener.x && source.y === listener.y)) {
    return { volume: 127, separation: 128 };
  }
  const dx = Math.abs(listener.x - source.x);
  const dy = Math.abs(listener.y - source.y);
  let distance = dx + dy - (Math.min(dx, dy) >> 1);
  const clip = 1200 * FRAC_UNIT;
  if (mapNumber !== 8 && distance > clip) return null;
  const angle = pointToAngle(listener.x, listener.y, source.x, source.y);
  const relative = (angle > listener.angle ? angle - listener.angle :
    angle + (0xffffffff - listener.angle)) >>> 0;
  const separation = 128 - (fixedMul(96 * FRAC_UNIT, fineSin(relative)) >> 16);
  let volume = 127;
  if (distance >= 160 * FRAC_UNIT) {
    if (mapNumber === 8) {
      distance = Math.min(distance, clip);
      volume = 15 + Math.trunc(112 * ((clip - distance) >> 16) / 1040);
    } else volume = Math.trunc(127 * ((clip - distance) >> 16) / 1040);
  }
  return volume > 0 ? { volume, separation } : null;
}

export function selectSoundChannel(channels: readonly ({ readonly priority: number } | null)[],
  priority: number): number {
  const empty = channels.findIndex(channel => channel === null);
  if (empty >= 0) return empty;
  return channels.findIndex(channel => channel !== null && channel.priority >= priority);
}

export function soundPitch(sound: SfxId, random: () => number): number {
  let pitch = soundDefinitions[sound]?.pitch ?? 128;
  if (sound >= SfxId.sfx_sawup && sound <= SfxId.sfx_sawhit) pitch += 8 - (random() & 15);
  else if (sound !== SfxId.sfx_itemup && sound !== SfxId.sfx_tink) pitch += 16 - (random() & 31);
  return Math.max(0, Math.min(255, pitch));
}

export function soundStereo({ volume, separation }: SoundParameters): readonly [number, number] {
  // I_StartSound/I_UpdateSoundParams use quadratic, integer stereo attenuation.
  const leftSeparation = separation + 1;
  const rightSeparation = leftSeparation - 257;
  return [
    (volume - ((volume * leftSeparation * leftSeparation) >> 16)) / 127,
    (volume - ((volume * rightSeparation * rightSeparation) >> 16)) / 127,
  ];
}
