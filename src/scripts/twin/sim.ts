// The cell controller, running against a MuJoCo model of the cell (mjcf.ts) inside a Web Worker.
//
// Physics: MuJoCo steps at 500 Hz. Cartons are free bodies; the belt drives them with a friction-limited force and
// accumulates them in zones; the vacuum cup grips with a weld; the pallet is a kinematic body. Nothing teleports
// once it is in play: a slipped carton falls, a released one settles on the stack, a dropped one lands in the bin.
//
// Control: the program (generators, 100 Hz) plans joint targets with the UR5e IK in kinematics.ts; each physics
// step interpolates them and adds velocity feedforward for Menagerie's position servos. The robot clock is scaled
// by the area scanner (30 %, then 0 %). The scenario is deterministic: fixed steps, no randomness.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { CASES } from './cases.ts';
import { GLB_HOME, fk, ik, nearest, solveFrom } from './kinematics.ts';
import { BELT, BOX, FLOOR_Y, PALLET, POOL, REJECT, SLOT_DX, SLOT_DZ, TOTE_B, ZONES, park } from './layout.ts';
import { S, type HudEvent, type Sku, type Stats, type Tone } from './protocol.ts';

export { S, STATE_LEN } from './protocol.ts';
export type { HudEvent, Sku, Stats, Tone } from './protocol.ts';

type Proc = Generator<void, void, number>;
interface Spec { sku: Sku; yaw?: number; damaged?: boolean; touching?: boolean; afterPick?: boolean; edge?: number }
type BoxState = 'parked' | 'belt' | 'held' | 'free' | 'hand' | 'placed' | 'binned';
interface Box { i: number; id: number; spec: Spec; state: BoxState; exiting: boolean; gap: number }

const DEG = Math.PI / 180;
const DT = 0.002;            // physics step
const CTRL_EVERY = 5;        // controller at 100 Hz
const PLAN: Spec[] = [
  { sku: 'A' },
  { sku: 'A', yaw: 35 * DEG, edge: 1 },
  { sku: 'A' },
  { sku: 'A', edge: 2 },
  { sku: 'A', touching: true },
  { sku: 'A', edge: 3 },
  { sku: 'A', damaged: true, edge: 4 },
  { sku: 'A', edge: 5 },
  { sku: 'B', edge: 6 },
  { sku: 'A', edge: 7, afterPick: true },
  { sku: 'A', edge: 8 },
  { sku: 'A', edge: 10 },
  { sku: 'A' },
];
const SLOTS = 12;
const READY = new Vector3(BELT.stopX - BOX.L / 2, 0.3, BELT.z);
const SAFE_Y = 0.14;
const PERSON_FROM = new Vector3(3.9, FLOOR_Y, -0.82);
const PERSON_WAIT = new Vector3(2.0, FLOOR_Y, -0.72);
const PERSON_AT = new Vector3(0.96, FLOOR_Y, -0.34);
const PERSON_TO = new Vector3(4.4, FLOOR_Y, -0.5);

const ease = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const halfTurn = (a: number, ref: number) => a + Math.round((ref - a) / Math.PI) * Math.PI;
const square = (a: number) => Math.round(a / Math.PI) * Math.PI;
const reach = (yaw: number) => (BOX.L / 2) * Math.abs(Math.cos(yaw)) + (BOX.W / 2) * Math.abs(Math.sin(yaw));
const yawOfQ = (q: Quaternion) => Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));

/** Slot k (0..11): each layer fills the back row (nearest the robot) left to right, then the front row. */
export function slotPose(k: number) {
  const layer = Math.floor(k / 6), i = k % 6;
  const row = i < 3 ? -1 : 1;
  return new Vector3(PALLET.x + ((i % 3) - 1) * SLOT_DX, PALLET.top + BOX.H * (layer + 1), PALLET.z + row * SLOT_DZ / 2);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface MuJoCo { mj: any; model: any; data: any }

export class Sim {
  time = 0;
  speed = 1;
  personPlacing = false;
  private mj: any;
  private model: any;
  private data: any;
  private emit: (e: HudEvent) => void;
  private q = [...GLB_HOME];
  private qPrev = [...GLB_HOME];
  private T = new Matrix4();
  private held: Box | null = null;
  private vac = 0;
  private vacTarget = 0;
  private boxes: Box[] = [];
  private nextId = 1;
  private spawnIdx = 0;
  private running = true;
  private jammed = false;
  private waiting = 0;
  private slotBook: ('empty' | 'occupied')[] = Array(SLOTS).fill('empty');
  private stats: Stats = { placed: 0, rejected: 0, sorted: 0, onPallet: 0, generation: 1, edges: 0 };
  private seen = new Set<number>();
  private robot: Proc;
  private side: Proc[] = [];
  private field = 0;
  private hold = 0;
  private scanT = -1;
  private puffT = -1;
  private toolTick = 0;
  private slow = 1;
  private beltOffset = 0;
  private stepCount = 0;
  private acc = 0;
  private fade = 1;
  private pallet = new Vector3(PALLET.x, PALLET.top, PALLET.z);
  private person = { visible: false, x: 0, z: 0, rot: 0, phase: 0, walk: 0, carry: 0, reach: 0 };
  private carried: Box | null = null;
  private readyQ: number[] = [...GLB_HOME];
  // model indices
  private boxBody: number[] = [];
  private boxQ: number[] = [];
  private boxV: number[] = [];
  private toolBody: number;

  constructor(m: MuJoCo, emit: (e: HudEvent) => void) {
    this.mj = m.mj; this.model = m.model; this.data = m.data; this.emit = emit;
    const id = (type: string, name: string) => this.mj.mj_name2id(this.model, this.mj.mjtObj[type].value, name);
    this.toolBody = id('mjOBJ_BODY', 'tool');
    for (let i = 0; i < POOL; i++) {
      this.boxBody.push(id('mjOBJ_BODY', `box${i}`));
      const j = id('mjOBJ_JOINT', `box${i}`);
      this.boxQ.push(this.model.jnt_qposadr[j]);
      this.boxV.push(this.model.jnt_dofadr[j]);
    }
    // start: arm at the ready pose, three cartons already on the belt
    this.readyQ = solveFrom({ p: READY, yaw: 0 }, GLB_HOME).q;
    this.q = [...this.readyQ];
    this.qPrev = [...this.q];
    const qpos = this.data.qpos, ctrl = this.data.ctrl;
    for (let j = 0; j < 6; j++) { qpos[j] = this.q[j]; ctrl[j] = this.q[j]; }
    for (const [k, s] of [[0, BELT.stopX], [1, -0.55], [2, -0.95]] as const) {
      const b = this.spawn(PLAN[k]);
      this.setPose(b, new Vector3(s - reach(b.spec.yaw ?? 0), BELT.top + BOX.H / 2 + 0.001, BELT.z), b.spec.yaw ?? 0);
    }
    this.spawnIdx = 3;
    this.mj.mj_forward(this.model, this.data);
    fk(this.q, this.T);
    this.robot = this.program();
    this.robot.next();
    this.status('RUNNING', 'run');
    this.publish();
  }

  // ------------------------------------------------------------------------------------ stepping
  /** Advance real time `dt` (seconds), in fixed physics steps; at most 0.1 s per call. */
  advance(dt: number) {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= DT) { this.acc -= DT; this.physicsStep(); }
  }

  private physicsStep() {
    if (this.stepCount % CTRL_EVERY === 0) this.control(DT * CTRL_EVERY);
    const k = (this.stepCount % CTRL_EVERY) + 1;
    const ctrl = this.data.ctrl;
    for (let j = 0; j < 6; j++) {
      const v = (this.q[j] - this.qPrev[j]) / (DT * CTRL_EVERY);
      ctrl[j] = this.qPrev[j] + (this.q[j] - this.qPrev[j]) * (k / CTRL_EVERY) + 0.2 * v;   // kv/kp = 0.2 s
    }
    this.beltDrive();
    this.carryOperatorBox();
    this.mj.mj_step(this.model, this.data);
    this.stepCount++;
    this.time = this.data.time;
  }

  /** 100 Hz: scanner, conveyor logic, the robot program and the operator. */
  private control(dt: number) {
    this.qPrev = [...this.q];
    this.safety(dt);
    this.classify();
    this.spawner();
    this.line();
    this.effects(dt);
    if (this.running) this.beltOffset += BELT.speed * dt;
    this.robot.next(dt * this.speed);
    this.side = this.side.filter((p) => !p.next(dt).done);
    this.vac += (this.vacTarget - this.vac) * Math.min(1, dt * 14);
    this.toolTick -= dt;
    if (this.toolTick <= 0) {
      this.toolTick = 0.12;
      this.emit({ k: 'tool', vac: Math.round(this.vac), payload: this.held ? BOX.mass + 0.2 : 0, speed: Math.round(this.speed * 100) });
    }
  }

  // ------------------------------------------------------------------------------------ physics access
  private pos(b: Box) {
    const x = this.data.xpos, o = this.boxBody[b.i] * 3;
    return new Vector3(x[o], x[o + 2], -x[o + 1]);
  }

  private quat(b: Box) {
    const x = this.data.xquat, o = this.boxBody[b.i] * 4;
    return new Quaternion(x[o + 1], x[o + 3], -x[o + 2], x[o]);   // MuJoCo (w x y z), Z-up -> three, Y-up
  }

  private vel(b: Box) {
    const v = this.data.qvel, o = this.boxV[b.i];
    return new Vector3(v[o], v[o + 2], -v[o + 1]);
  }

  private yaw(b: Box) { return yawOfQ(this.quat(b)); }

  /** Centre of the carton's top face. */
  private top(b: Box) { return this.pos(b).add(new Vector3(0, BOX.H / 2, 0)); }

  private setPose(b: Box, p: Vector3, yaw: number) {
    const qp = this.data.qpos, qv = this.data.qvel, a = this.boxQ[b.i], v = this.boxV[b.i];
    qp[a] = p.x; qp[a + 1] = -p.z; qp[a + 2] = p.y;
    qp[a + 3] = Math.cos(yaw / 2); qp[a + 4] = 0; qp[a + 5] = 0; qp[a + 6] = Math.sin(yaw / 2);   // yaw about +Z
    for (let k = 0; k < 6; k++) qv[v + k] = 0;
  }

  private force(b: Box, fx: number, fz: number, torque = 0) {
    const f = this.data.xfrc_applied, o = this.boxBody[b.i] * 6;
    f[o] = fx; f[o + 1] = -fz; f[o + 2] = 0; f[o + 3] = 0; f[o + 4] = 0; f[o + 5] = torque;
  }

  /** Suction on: weld the carton to the cup where it is now. */
  private grip(b: Box) {
    const xp = this.data.xpos, xq = this.data.xquat;
    const t = this.toolBody * 3, o = this.boxBody[b.i] * 3, tq = this.toolBody * 4, bq = this.boxBody[b.i] * 4;
    const inv = new Quaternion(xq[tq + 1], xq[tq + 2], xq[tq + 3], xq[tq]).invert();   // MuJoCo frame throughout
    const rel = new Vector3(xp[o] - xp[t], xp[o + 1] - xp[t + 1], xp[o + 2] - xp[t + 2]).applyQuaternion(inv);
    const rq = inv.multiply(new Quaternion(xq[bq + 1], xq[bq + 2], xq[bq + 3], xq[bq]));
    const e = this.model.eq_data, k = b.i * this.mj.mjNEQDATA;   // anchor 0-2, relpos 3-5, relquat 6-9, torquescale 10
    e[k] = 0; e[k + 1] = 0; e[k + 2] = 0;
    e[k + 3] = rel.x; e[k + 4] = rel.y; e[k + 5] = rel.z;
    e[k + 6] = rq.w; e[k + 7] = rq.x; e[k + 8] = rq.y; e[k + 9] = rq.z; e[k + 10] = 1;
    this.data.eq_active[b.i] = 1;
    this.held = b;
    b.state = 'held';
  }

  private ungrip(b: Box, state: BoxState) {
    this.data.eq_active[b.i] = 0;
    if (this.held === b) this.held = null;
    b.state = state;
  }

  // ------------------------------------------------------------------------------------ conveyor
  private onBelt() {
    return this.boxes.filter((b) => b.state === 'belt').map((b) => ({ b, p: this.pos(b), yaw: this.yaw(b) }))
      .filter(({ p }) => p.x > BELT.x0 - 0.1 && p.x < BELT.x1 + 0.05 && Math.abs(p.z - BELT.z) < BELT.width / 2 && p.y > BELT.top)
      .map(({ b, p, yaw }) => ({ b, x: p.x, yaw }))
      .sort((a, b) => b.x - a.x);
  }

  private lead() { return this.onBelt()[0]?.b; }

  private partPresent() {
    const l = this.onBelt()[0];
    return !!l && l.x + reach(l.yaw) >= BELT.stopX - 0.004 && Math.abs(this.vel(l.b).x) < 0.03;
  }

  /** A carton that fell back onto the belt rejoins the queue once it has settled. */
  private classify() {
    for (const b of this.boxes) {
      if (b.state !== 'free' || b === this.carried) continue;
      const p = this.pos(b), v = this.vel(b);
      if (v.length() < 0.05 && p.x > BELT.x0 && p.x < BELT.x1 && Math.abs(p.z - BELT.z) < BELT.width / 2
        && Math.abs(p.y - (BELT.top + BOX.H / 2)) < 0.015) b.state = 'belt';
    }
  }

  /** Friction-limited belt drive with zone accumulation: each carton keeps its gap to the one ahead (or the stop). */
  private beltDrive() {
    for (const b of this.boxes) this.force(b, 0, 0);
    // the escapement: a carton the robot has not yet carried clear of the pick window still blocks it
    let front = BELT.stopX;
    let first = true;
    for (const b of this.boxes) {
      if (b.state !== 'held' && b.state !== 'free') continue;
      const p = this.pos(b);
      if (p.x > BELT.x0 && p.x < BELT.x1 && Math.abs(p.z - BELT.z) < 0.2 && p.y < BELT.top + BOX.H + 0.2) {
        front = Math.min(front, p.x - reach(this.yaw(b)) - 0.05);
        first = false;
      }
    }
    const mu = 0.8 * BOX.mass * 9.81;
    for (const { b, x, yaw } of this.onBelt()) {
      const gap = front - (x + reach(yaw)) - (first ? 0 : b.gap);
      const target = this.running ? clamp(gap * 6, 0, BELT.speed) : 0;
      const v = this.vel(b);
      const fx = clamp((BOX.mass * (target - v.x)) / 0.08, -mu, mu);
      const fz = clamp((BOX.mass * -v.z) / 0.1 + (BELT.z - this.pos(b).z) * 20, -mu, mu);
      // the belt's friction also resists the carton turning on it
      const wz = this.data.qvel[this.boxV[b.i] + 5];
      this.force(b, fx, fz, clamp(-0.4 * wz, -0.4, 0.4));
      front = x - reach(yaw);
      first = false;
    }
  }

  private spawn(spec: Spec, onBelt = true): Box {
    const used = new Set(this.boxes.map((b) => b.i));
    let i = 0;
    while (used.has(i) && i < POOL) i++;
    if (i >= POOL) throw new Error('carton pool exhausted');
    const b: Box = { i, id: onBelt ? this.nextId++ : 0, spec, state: onBelt ? 'belt' : 'hand', exiting: false, gap: spec.touching ? 0 : 0.05 };
    this.boxes.push(b);
    this.emit({ k: 'kind', i, sku: spec.sku, damaged: !!spec.damaged });
    return b;
  }

  private parkBox(b: Box) {
    this.data.eq_active[b.i] = 0;
    if (this.held === b) this.held = null;
    const q = park(b.i);
    this.setPose(b, new Vector3(q.x, q.y, q.z), 0);
    this.mj.mj_forward(this.model, this.data);
    this.boxes = this.boxes.filter((x) => x !== b);
  }

  private spawner() {
    if (!this.running) return;
    const spec = PLAN[this.spawnIdx % PLAN.length];
    const belt = this.onBelt();
    if (belt.length >= 3 || this.boxes.length >= POOL - 1) return;
    const last = belt[belt.length - 1];
    const hx = reach(spec.yaw ?? 0);
    if (last && last.x - reach(last.yaw) < BELT.spawnX + hx + (spec.touching ? 0 : 0.12)) return;
    if (spec.afterPick) {
      const prev = this.boxes.find((b) => b.spec === PLAN[(this.spawnIdx - 1) % PLAN.length]);
      if (prev && prev.state === 'belt') return;
    }
    const b = this.spawn(spec);
    const x = spec.touching && last ? last.x - reach(last.yaw) - hx : BELT.spawnX;
    this.setPose(b, new Vector3(x, BELT.top + BOX.H / 2 + 0.001, BELT.z), spec.yaw ?? 0);
    this.mj.mj_forward(this.model, this.data);               // world poses are stale after a teleport until recomputed
    this.spawnIdx++;
  }

  /** Case 7: the infeed stops upstream with the next carton mid-belt, and restarts once the cell has waited. */
  private line() {
    const b = this.onBelt().find((x) => x.b.spec.edge === 7);
    if (b && !this.jammed && this.running && b.x > -0.85 && !this.seen.has(7)) {
      this.running = false;
      this.jammed = true;
      this.log('Line: infeed stopped upstream', 'info');
    }
    if (this.jammed && this.waiting > 3.2) {
      this.running = true;
      this.jammed = false;
      this.log('Line: infeed running again', 'info');
    }
  }

  // ------------------------------------------------------------------------------------ robot primitives
  private toolYaw() {
    const e = this.T.elements;
    return Math.atan2(-e[2], e[0]);
  }

  private here() { return new Vector3().setFromMatrixPosition(this.T); }

  private solve(p: Vector3, yaw: number, from: number[] = this.q) {
    const cost = (s: { q: number[]; err: number }) => Math.abs(s.q[5] - from[5]) + Math.abs(s.q[0] - from[0]) * 0.5 + s.err * 1e3;
    let best: { q: number[]; err: number } | null = null;
    // both half-turn yaws (a carton is symmetric), from the current pose and, if that fails, from the ready pose
    for (const seed of [from, this.readyQ]) {
      for (const y of [yaw, yaw + Math.PI]) {
        const s = solveFrom({ p, yaw: y }, seed);
        s.q[5] = nearest(s.q[5], from[5]);
        if (!best || cost(s) < cost(best)) best = s;
      }
      if (best && best.err < 2e-3) break;
    }
    return best!.q;
  }

  private setQ(q: number[]) {
    for (let j = 0; j < 6; j++) this.q[j] = q[j];
    fk(this.q, this.T);
  }

  /** Blended move through via points (UR blend radii): no stop at a via point, easing only at the ends. */
  private *moveP(targets: { p: Vector3; yaw: number }[], scale = 1): Proc {
    const pts: number[][] = [[...this.q]];
    for (const tg of targets) pts.push(this.solve(tg.p, tg.yaw, pts[pts.length - 1]));
    const seg = pts.slice(1).map((q, i) => Math.max(...q.map((v, j) => Math.abs(v - pts[i][j]))) + 1e-6);
    const D = seg.reduce((a, b) => a + b, 0);
    const T = clamp(D / 2.6 + 0.35, 0.55, 1.8) / scale;
    const at = (i: number) => pts[clamp(i, 0, pts.length - 1)];
    const q = [0, 0, 0, 0, 0, 0];
    for (let t = 0; t < T;) {
      t = Math.min(T, t + (yield));
      let d = ease(t / T) * D, i = 0;
      while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
      const u = clamp(d / seg[i], 0, 1), u2 = u * u, u3 = u2 * u;
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      for (let j = 0; j < 6; j++) {
        q[j] = 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * u + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * u2
          + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * u3);
      }
      this.setQ(q);
    }
  }

  /** Lift straight up off what was just gripped or placed, carry high, come down over the target. */
  private *transfer(to: Vector3, yaw: number, scale = 1): Proc {
    const via = [{ p: this.here().add(new Vector3(0, 0.1, 0)), yaw: this.toolYaw() }];
    if (to.y < SAFE_Y) via.push({ p: new Vector3(to.x, SAFE_Y, to.z), yaw });
    yield* this.moveP([...via, { p: to, yaw }], scale);
  }

  private *moveL(p1: Vector3, yaw: number | null, T: number): Proc {
    const p0 = this.here();
    const y0 = this.toolYaw();
    const y1 = yaw === null ? y0 : halfTurn(nearest(yaw, y0), y0);
    const p = new Vector3();
    const q = [...this.q];
    for (let t = 0; t < T;) {
      t = Math.min(T, t + (yield));
      const s = ease(t / T);
      p.lerpVectors(p0, p1, s);
      ik({ p, yaw: y0 + (y1 - y0) * s }, q, 6, 5e-5);
      this.setQ(q);
    }
  }

  private *wait(sec: number): Proc {
    for (let t = 0; t < sec;) t += yield;
  }

  private *observe(): Proc {
    this.scanT = 0;
    yield* this.wait(0.38);
  }

  // ------------------------------------------------------------------------------------ the program
  private *program(): Proc {
    for (;;) {
      for (let i = 0; i < PLAN.length; i++) yield* this.cycle(PLAN[i]);
      yield* this.palletChange();
    }
  }

  private *cycle(spec: Spec): Proc {
    let flagged = false;
    for (this.waiting = 0; !this.partPresent();) {
      this.waiting += yield;
      if (!flagged && this.waiting > 2) {
        flagged = true;
        this.edge(7, 'No part at the photo-eye for 2.0 s. Holding at the ready pose, no fault raised.');
        this.status('HOLD · WAITING FOR PARTS', 'hold');
      }
    }
    this.waiting = 0;
    if (flagged) { this.log('Part at the photo-eye, cycle resumes', 'ok'); this.status('RUNNING', 'run'); }

    const box = this.lead()!;
    yield* this.observe();
    if (spec.edge === 2) {
      this.edge(2, 'One 0.30 m blob where a box is 0.15 m. Re-observing.');
      yield* this.wait(0.15);
      yield* this.observe();
      this.log('Depth edge splits it into 2 boxes, picking the lead box first', 'info');
    }
    if (spec.edge === 1) this.edge(1, `Yaw measured at ${Math.round(Math.abs(this.yaw(box)) / DEG)}° off the guide. Grasp re-planned.`);
    if (spec.edge === 4) this.edge(4, 'Depth shows one corner 18 mm low. Routed to the reject bin.');
    if (spec.edge === 6) this.edge(6, 'Label reads SKU-B on an SKU-A pallet. Routed to the SKU-B tote.');

    yield* this.pick(box, spec.edge === 3, spec.edge === 5);
    if (spec.damaged) yield* this.toBin(box, REJECT, 'rejected');
    else if (spec.sku === 'B') yield* this.toBin(box, TOTE_B, 'sorted');
    else yield* this.toPallet(box, spec.edge === 10);
    if (spec.edge === 7) this.side.push(this.operator());
    this.slow = 1;
    yield* this.transfer(READY, 0);
  }

  private *pick(box: Box, noSeal: boolean, slips: boolean): Proc {
    const top = this.top(box);
    const at = (dy: number) => top.clone().add(new Vector3(0, dy, 0));
    yield* this.moveL(at(0.07), this.yaw(box), 0.4);
    yield* this.moveL(at(-0.003), null, 0.28);              // press 3 mm into the carton top
    this.vacTarget = noSeal ? 9 : 66;
    yield* this.wait(0.2);
    if (noSeal) {
      this.edge(3, 'Vacuum 9 kPa after the press, 55 needed. Venting and pressing again.');
      this.vacTarget = 0;
      yield* this.moveL(at(0.04), null, 0.25);
      yield* this.wait(0.15);
      yield* this.moveL(at(-0.004), null, 0.28);
      this.vacTarget = 64;
      yield* this.wait(0.45);
      this.log('Seal confirmed at 64 kPa with +0.25 s dwell', 'ok');
    }
    this.grip(box);
    if (slips) {
      yield* this.moveL(at(0.06), null, 0.2);
      this.vacTarget = 14;
      this.ungrip(box, 'free');                              // the carton falls on its own
      this.edge(5, 'Vacuum fell from 62 to 14 kPa in the lift. Motion held, re-locating the box.');
      yield* this.moveL(this.here().add(new Vector3(0, 0.06, 0)), null, 0.3);
      for (let t = 0; (box.state !== 'belt' || !this.partPresent()) && t < 6;) t += yield;
      yield* this.wait(0.2);
      yield* this.observe();
      this.log(`Box found at ${Math.round(Math.abs(this.yaw(box)) / DEG)}° yaw, regrasping`, 'info');
      yield* this.pick(box, false, false);
      this.slow = 0.7;
      this.log('Transfer at 70% speed after the slip', 'info');
      return;
    }
    yield* this.moveL(at(0.05), null, 0.2);
  }

  private placeYaw(box: Box, target: number) {
    return target - (this.yaw(box) - this.toolYaw());
  }

  /** Whether a carton the robot is not holding is resting in slot k right now. */
  private occupied(k: number) {
    const s = slotPose(k).add(new Vector3(0, -BOX.H / 2, 0));
    return this.boxes.some((b) => b !== this.held && b.state !== 'parked' && this.pos(b).distanceTo(s) < 0.05);
  }

  private *toPallet(box: Box, sticks: boolean): Proc {
    let k = this.slotBook.indexOf('empty');
    const yaw = this.placeYaw(box, 0);
    const above = (s: number) => slotPose(s).add(new Vector3(0, 0.13, 0));
    yield* this.transfer(above(k), yaw, this.slow);
    if (this.occupied(k)) {
      yield* this.observe();
      this.slotBook[k] = 'occupied';
      this.edge(9, `Slot ${k + 1} holds a box the robot did not place. Reconciled as occupied, not counted.`);
      k = this.slotBook.indexOf('empty');
      this.log(`Place re-planned to slot ${k + 1}`, 'info');
      yield* this.transfer(above(k), yaw);
    }
    const at = slotPose(k);
    yield* this.moveL(at.clone().add(new Vector3(0, -0.001, 0)), null, 0.34);
    this.vacTarget = 0;
    if (sticks) {
      yield* this.wait(0.12);
      yield* this.moveL(at.clone().add(new Vector3(0, 0.045, 0)), null, 0.22);   // still welded: it lifts with the cup
      this.edge(10, 'Box still on the cup after venting. Setting down and pulsing blow-off.');
      yield* this.moveL(at.clone().add(new Vector3(0, -0.001, 0)), null, 0.22);
      this.puffT = 0;
    }
    this.ungrip(box, 'placed');
    yield* this.wait(sticks ? 0.3 : 0.12);
    if (sticks) this.log('Release verified by the depth check', 'ok');
    this.slotBook[k] = 'occupied';
    this.stats.placed++;
    this.publish();
    yield* this.moveL(at.clone().add(new Vector3(0, 0.04, 0)), null, 0.16);
    this.log(`#${box.id} placed in slot ${k + 1}, verified`, 'ok');
  }

  private *toBin(box: Box, bin: { x: number; z: number; floor: number }, kind: 'rejected' | 'sorted'): Proc {
    const over = new Vector3(bin.x, bin.floor + 0.3, bin.z);
    yield* this.transfer(over, this.placeYaw(box, 0), this.slow);
    yield* this.moveL(new Vector3(bin.x, bin.floor + 0.2, bin.z), null, 0.28);
    this.vacTarget = 0;
    this.ungrip(box, 'binned');                              // dropped: it lands in the bin under gravity
    yield* this.wait(0.14);
    this.stats[kind]++;
    this.publish();
    yield* this.moveL(over, null, 0.26);
    this.log(`#${box.id} ${kind === 'rejected' ? 'in the reject bin' : 'in the SKU-B tote'}`, 'ok');
  }

  private *palletChange(): Proc {
    this.status('PALLET CHANGE', 'hold');
    this.log(`Pallet full, 12/12. Generation ${this.stats.generation} released downstream`, 'info');
    const gone = this.boxes.filter((b) => b.state === 'placed' || b.state === 'binned');
    for (const b of gone) b.exiting = true;
    // the pallet rolls out with its load riding on it
    for (let t = 0; t < 2.2;) {
      t = Math.min(2.2, t + (yield));
      this.setPallet(PALLET.x + 0.8 * ease(t / 2.2), PALLET.top);
      this.fade = 1 - clamp((t - 0.6) / 1.5, 0, 1);
    }
    for (const b of gone) this.parkBox(b);
    for (let t = 0; t < 1.1;) {
      t = Math.min(1.1, t + (yield));
      this.setPallet(PALLET.x, PALLET.top - 0.14 * (1 - ease(t / 1.1)));
      this.fade = clamp(t / 0.6, 0, 1);
    }
    this.fade = 1;
    this.slotBook.fill('empty');
    this.stats.generation++;
    this.seen.clear();
    this.emit({ k: 'reset' });
    this.publish();
    this.log(`Empty pallet in place. Generation ${this.stats.generation}`, 'info');
    this.status('RUNNING', 'run');
  }

  private setPallet(x: number, y: number) {
    this.pallet.set(x, y, PALLET.z);
    const m = this.data.mocap_pos;
    m[0] = x; m[1] = -PALLET.z; m[2] = y;
  }

  // ------------------------------------------------------------------------------------ the operator (cases 8 + 9)
  /** Where the operator's hands are (matches the figure's pose in world.ts). */
  private hands() {
    const P = this.person;
    const local = new Vector3(0, 0.97 + 0.1 + 0.2 + 0.065 * P.reach, 0.36 + 0.12 * P.reach);
    return local.applyAxisAngle(new Vector3(0, 1, 0), P.rot).add(new Vector3(P.x, FLOOR_Y, P.z));
  }

  private carryOperatorBox() {
    const b = this.carried;
    if (!b || b.state !== 'hand') return;
    this.setPose(b, this.hands().add(new Vector3(0, 0.05 - BOX.H / 2, 0)), this.person.rot + Math.PI / 2);
  }

  private *operator(): Proc {
    const P = this.person;
    const carried = this.spawn({ sku: 'A' }, false);
    this.carried = carried;
    P.visible = true;
    const walk = function* (from: Vector3, to: Vector3, v: number): Proc {
      const d = to.distanceTo(from);
      P.rot = Math.atan2(to.x - from.x, to.z - from.z);
      for (let s = 0; s < d;) {
        const dt: number = yield;
        s = Math.min(d, s + v * dt);
        P.phase += dt * 7.2;
        const at = from.clone().lerp(to, s / d);
        P.x = at.x; P.z = at.z;
        P.walk = 1; P.carry = carried.state === 'hand' ? 1 : 0; P.reach = 0;
      }
      P.walk = 0;
    };
    const turn = function* (to: number, carry: number): Proc {
      const from = P.rot, target = nearest(to, from);
      for (let t = 0; t < 0.4;) {
        t = Math.min(0.4, t + (yield));
        P.rot = from + (target - from) * ease(t / 0.4);
        P.walk = 0; P.carry = carry;
      }
    };
    P.x = PERSON_FROM.x; P.z = PERSON_FROM.z;
    yield* walk(PERSON_FROM, PERSON_WAIT, 1.15);
    for (let t = 0; !(this.held && this.held.spec.edge === 8) && t < 12;) t += yield;
    yield* walk(PERSON_WAIT, PERSON_AT, 1.15);
    const k = this.slotBook.indexOf('empty');
    const slot = slotPose(k).add(new Vector3(0, -BOX.H / 2 + 0.002, 0));
    yield* turn(Math.atan2(slot.x - PERSON_AT.x, slot.z - PERSON_AT.z), 1);
    this.personPlacing = true;
    for (let t = 0; t < 0.45;) { t = Math.min(0.45, t + (yield)); P.reach = ease(t / 0.45); }
    // hand the carton across to the slot, then let go: it settles under gravity
    const p0 = this.pos(carried), r0 = this.yaw(carried), r1 = square(r0);
    carried.state = 'free';
    for (let t = 0; t < 0.7;) {
      t = Math.min(0.7, t + (yield));
      const s = ease(t / 0.7);
      const p = p0.clone().lerp(slot, s);
      p.y += Math.sin(s * Math.PI) * 0.04;
      this.setPose(carried, p, r0 + (r1 - r0) * s);
    }
    carried.state = 'placed';
    this.carried = null;
    this.publish();
    this.log(`Operator put a box in slot ${k + 1} by hand`, 'info');
    for (let t = 0; t < 0.45;) { t = Math.min(0.45, t + (yield)); const s = 1 - ease(t / 0.45); P.reach = s; P.carry = s; }
    this.personPlacing = false;
    yield* turn(Math.atan2(PERSON_TO.x - PERSON_AT.x, PERSON_TO.z - PERSON_AT.z), 0);
    yield* walk(PERSON_AT, PERSON_TO, 1.25);
    P.visible = false;
  }

  private safety(dt: number) {
    const P = this.person;
    const r = P.visible ? Math.hypot(P.x, P.z) : Infinity;
    const field = r < ZONES.stop ? 2 : r < ZONES.warn ? 1 : 0;
    if (field !== this.field) {
      if (field === 1 && this.field === 0) {
        this.edge(8, 'Person in the warning field. Speed scaled to 30%.');
        this.status('REDUCED SPEED · 30%', 'hold');
      } else if (field === 2) {
        this.log(`Protective field: safeguard stop, ${this.held ? 'part held on vacuum' : 'arm holding position'}`, 'edge');
        this.status('SAFEGUARD STOP', 'stop');
      } else if (field === 1) {
        this.log('Protective field clear, resuming at 30%', 'info');
        this.status('REDUCED SPEED · 30%', 'hold');
      } else {
        this.log('Zone clear, full speed', 'ok');
        this.status('RUNNING', 'run');
      }
      this.field = field;
    }
    if (field === 2) this.hold = 0.9; else this.hold = Math.max(0, this.hold - dt);
    const target = field === 2 || this.hold > 0 ? 0 : field === 1 ? 0.3 : 1;
    this.speed += clamp(target - this.speed, -dt * 3.5, dt * 1.6);
  }

  private effects(dt: number) {
    if (this.scanT >= 0) { this.scanT += dt; if (this.scanT > 0.36) this.scanT = -1; }
    if (this.puffT >= 0) { this.puffT += dt; if (this.puffT > 0.45) this.puffT = -1; }
  }

  // ------------------------------------------------------------------------------------ output
  get operatorInCell() { return this.person.visible; }

  /** Fill the per-frame state for the renderer (see S). */
  write(out: Float32Array) {
    out[S.time] = this.time;
    const qpos = this.data.qpos;
    for (let j = 0; j < 6; j++) out[S.q + j] = qpos[j];
    out[S.beltOffset] = this.beltOffset;
    out[S.beam] = this.partPresent() ? 1 : 0;
    out[S.beacon] = this.jammed && Math.sin(this.time * 10) > 0 ? 1 : 0;
    out[S.field] = this.field;
    const t = this.scanT;
    out[S.scan] = t < 0 ? 0 : t < 0.1 ? t / 0.1 : t < 0.24 ? 1 : Math.max(0, 1 - (t - 0.24) / 0.12);
    out[S.puff] = this.puffT < 0 ? -1 : this.puffT / 0.45;
    out[S.pallet] = this.pallet.x; out[S.pallet + 1] = this.pallet.y; out[S.pallet + 2] = this.pallet.z;
    out[S.fade] = this.fade;
    const P = this.person;
    out.set([P.visible ? 1 : 0, P.x, P.z, P.rot, P.phase, P.walk, P.carry, P.reach], S.person);
    out[S.placing] = this.personPlacing ? 1 : 0;
    const live = new Map(this.boxes.map((b) => [b.i, b]));
    const xp = this.data.xpos, xq = this.data.xquat;
    for (let i = 0; i < POOL; i++) {
      const o = S.boxes + i * S.stride, bp = this.boxBody[i] * 3, bq = this.boxBody[i] * 4;
      const b = live.get(i);
      out[o] = xp[bp]; out[o + 1] = xp[bp + 2]; out[o + 2] = -xp[bp + 1];
      out[o + 3] = xq[bq + 1]; out[o + 4] = xq[bq + 3]; out[o + 5] = -xq[bq + 2]; out[o + 6] = xq[bq];
      out[o + 7] = b ? 1 : 0;
      out[o + 8] = b?.exiting ? 1 : 0;
    }
  }

  private log(text: string, tone: Tone) { this.emit({ k: 'log', t: this.time, text, tone }); }

  private edge(n: number, detail: string) {
    if (!this.seen.has(n)) { this.seen.add(n); this.stats.edges = this.seen.size; this.publish(); }
    this.emit({ k: 'edge', t: this.time, n, detail });
    this.emit({ k: 'log', t: this.time, text: `Edge ${n}/10 · ${CASES[n - 1].code} · ${detail}`, tone: 'edge' });
  }

  private status(label: string, tone: Tone) { this.emit({ k: 'status', label, tone }); }

  private publish() {
    this.stats.onPallet = this.boxes.filter((b) => b.state === 'placed' && !b.exiting).length;
    this.emit({ k: 'stats', s: { ...this.stats } });
  }
}
