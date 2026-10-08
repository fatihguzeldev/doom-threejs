export interface TicCommand {
  readonly forwardMove: number;
  readonly sideMove: number;
  readonly angleTurn: number;
  readonly buttons: number;
}

export enum TicButton {
  attack = 1,
  use = 2,
  changeWeapon = 4,
  special = 128,
}

export const WEAPON_SHIFT = 3;
export const WEAPON_MASK = 7 << WEAPON_SHIFT;

export enum SpecialButton {
  pause = 1,
  save = 2,
}

export const idleCommand: TicCommand = {
  forwardMove: 0, sideMove: 0, angleTurn: 0, buttons: 0,
};
