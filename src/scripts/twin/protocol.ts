// What the physics worker sends the page each frame: a flat state array (layout S) and HUD events.
import { POOL } from './layout.ts';

export type Tone = 'run' | 'hold' | 'stop' | 'edge' | 'ok' | 'info';
export type Sku = 'A' | 'B';
export interface Stats { placed: number; rejected: number; sorted: number; onPallet: number; generation: number; edges: number }
export type HudEvent =
  | { k: 'log'; t: number; text: string; tone: Tone }
  | { k: 'edge'; t: number; n: number; detail: string }
  | { k: 'reset' }
  | { k: 'status'; label: string; tone: Tone }
  | { k: 'stats'; s: Stats }
  | { k: 'tool'; vac: number; payload: number; speed: number }
  | { k: 'kind'; i: number; sku: Sku; damaged: boolean };

/** Layout of the per-frame state array the worker posts to the renderer. */
export const S = {
  time: 0, q: 1, beltOffset: 7, beam: 8, beacon: 9, field: 10, scan: 11, puff: 12, pallet: 13, fade: 16,
  person: 17, placing: 25, boxes: 32, stride: 9, // per box: x y z, qx qy qz qw, visible (0/1), exiting (0/1)
} as const;
export const STATE_LEN = S.boxes + POOL * S.stride;
