// Cell layout in the twin's world frame (three.js: Y up, metres; the robot base is the origin).
// Shared by the renderer (world.ts) and the physics worker (mjcf.ts, sim.ts), so it imports nothing.

export const FLOOR_Y = -0.82;
export const BOX = { L: 0.15, W: 0.11, H: 0.10, mass: 1.2 };
export const BELT = { top: -0.04, z: 0.40, x0: -1.45, x1: -0.06, width: 0.30, stopX: -0.10, speed: 0.30, spawnX: -1.36 };
export const PALLET = { x: 0.47, z: 0.08, top: -0.28 };
export const SLOT_DX = 0.16;
export const SLOT_DZ = 0.12;
export const REJECT = { x: -0.56, z: -0.06, floor: -0.47 };
export const TOTE_B = { x: 0.14, z: -0.46, floor: -0.47 };
export const TOTE = { w: 0.3, d: 0.24, h: 0.16, t: 0.012 };
export const ZONES = { warn: 1.75, stop: 1.15 };
/** Number of carton bodies in the physics model; spare ones wait off stage. */
export const POOL = 18;
/** Where spare cartons wait (three.js coords), far outside the hall. */
export const park = (i: number) => ({ x: 14 + (i % 6) * 0.4, y: FLOOR_Y + BOX.H / 2, z: 10 + Math.floor(i / 6) * 0.4 });
