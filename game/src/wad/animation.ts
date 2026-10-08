// Original p_spec.c ranges. Directory order, including unused entries, sets the phase.
const flatCycles = [
  ['NUKAGE1', 'NUKAGE3'], ['FWATER1', 'FWATER4'], ['SWATER1', 'SWATER4'],
  ['LAVA1', 'LAVA4'], ['BLOOD1', 'BLOOD3'], ['RROCK05', 'RROCK08'],
  ['SLIME01', 'SLIME04'], ['SLIME05', 'SLIME08'], ['SLIME09', 'SLIME12'],
] as const;
const wallCycles = [
  ['BLODGR1', 'BLODGR4'], ['SLADRIP1', 'SLADRIP3'], ['BLODRIP1', 'BLODRIP4'],
  ['FIREWALA', 'FIREWALL'], ['GSTFONT1', 'GSTFONT3'], ['FIRELAV3', 'FIRELAVA'],
  ['FIREMAG1', 'FIREMAG3'], ['FIREBLU1', 'FIREBLU2'], ['ROCKRED1', 'ROCKRED3'],
  ['BFALL1', 'BFALL4'], ['SFALL1', 'SFALL4'], ['WFALL1', 'WFALL4'], ['DBRAIN1', 'DBRAIN4'],
] as const;

export function createPictureAnimation(names: readonly string[], kind: 'wall' | 'flat'): (name: string, levelTime: number) => string {
  const indices = new Map<string, number>();
  names.forEach((name, index) => {
    const key = name.toUpperCase();
    // R_TextureNumForName scans forward; W_GetNumForName scans backward for flats.
    if (kind === 'flat' || !indices.has(key)) indices.set(key, index);
  });
  const cycles = new Map<number, { readonly base: number; readonly count: number }>();
  for (const [start, end] of kind === 'wall' ? wallCycles : flatCycles) {
    const base = indices.get(start);
    if (base === undefined) continue;
    const last = indices.get(end);
    if (last === undefined || last - base + 1 < 2) throw new Error(`Invalid Doom ${kind} animation ${start} to ${end}`);
    const count = last - base + 1;
    for (let index = base; index <= last; index++) cycles.set(index, { base, count });
  }
  return (name, levelTime): string => {
    if (!Number.isSafeInteger(levelTime) || levelTime < 0) throw new Error('Invalid Doom animation level time');
    const key = name.toUpperCase(), index = indices.get(key);
    const cycle = index === undefined ? undefined : cycles.get(index);
    if (!cycle || index === undefined) return key;
    const frame = names[cycle.base + (Math.floor(levelTime / 8) + index) % cycle.count];
    if (frame === undefined) throw new Error('Doom animation picture is outside the original range');
    return frame.toUpperCase();
  };
}
