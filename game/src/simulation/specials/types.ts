export type DoorType = 'normal' | 'close30ThenOpen' | 'close' | 'open' | 'raiseIn5Mins' |
  'blazeRaise' | 'blazeOpen' | 'blazeClose';
export type FloorType = 'lowerFloor' | 'lowerFloorToLowest' | 'turboLower' | 'raiseFloor' |
  'raiseFloorToNearest' | 'raiseToTexture' | 'lowerAndChange' | 'raiseFloor24' |
  'raiseFloor24AndChange' | 'raiseFloorCrush' | 'raiseFloorTurbo' | 'raiseFloor512' | 'donutRaise' | 'stairs';
export type CeilingType = 'lowerToFloor' | 'raiseToHighest' | 'lowerAndCrush' |
  'crushAndRaise' | 'fastCrushAndRaise' | 'silentCrushAndRaise';
export type PlatformType = 'perpetualRaise' | 'downWaitUpStay' | 'raiseAndChange' |
  'raiseToNearestAndChange' | 'blazeDownWaitUpStay';

interface SectorThinkerBase {
  readonly sector: number;
  removed: boolean;
}

export interface DoorThinker extends SectorThinkerBase {
  readonly kind: 'door';
  type: DoorType;
  speed: number;
  topHeight: number;
  direction: -1 | 0 | 1 | 2;
  topWait: number;
  count: number;
}

export interface FloorThinker extends SectorThinkerBase {
  readonly kind: 'floor';
  type: FloorType;
  speed: number;
  destination: number;
  direction: -1 | 1;
  crush: boolean;
  texture: string;
  newSpecial: number;
}

export interface CeilingThinker extends SectorThinkerBase {
  readonly kind: 'ceiling';
  type: CeilingType;
  speed: number;
  topHeight: number;
  bottomHeight: number;
  direction: -1 | 0 | 1;
  oldDirection: -1 | 1;
  crush: boolean;
  tag: number;
}

export interface PlatformThinker extends SectorThinkerBase {
  readonly kind: 'platform';
  type: PlatformType;
  speed: number;
  low: number;
  high: number;
  wait: number;
  count: number;
  status: 'up' | 'down' | 'waiting' | 'stasis';
  oldStatus: 'up' | 'down' | 'waiting';
  crush: boolean;
  tag: number;
}

export interface LightThinker extends SectorThinkerBase {
  readonly kind: 'light';
  type: 'flash' | 'strobe' | 'glow' | 'fire';
  count: number;
  min: number;
  max: number;
  minTime: number;
  maxTime: number;
  direction: -1 | 1;
}

export type SectorThinker = DoorThinker | FloorThinker | CeilingThinker | PlatformThinker | LightThinker;
// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Serializable native sector thinker records. See ../../../LICENSE.
