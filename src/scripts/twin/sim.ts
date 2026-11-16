// The scripted production loop. One pallet per loop: 13 boxes come down the infeed, the UR5e palletizes them and
// meets the ten edge cases in cases.ts on the way. The script is deterministic (no randomness, no physics engine):
// generators advance on the robot clock, which the safety scanner slows or stops, and on the cell clock.
import { Group, Material, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import { CASES } from './cases';
import { GLB_HOME, fk, ik, nearest, solveFrom } from './kinematics';
import { BELT, BOX, PALLET, REJECT, SLOT_DX, SLOT_DZ, TOTE_B, ZONES, FLOOR_Y, makeBox, type Cell, type Sku } from './world';

export type Tone = 'run' | 'hold' | 'stop' | 'edge' | 'ok' | 'info';
export interface Stats { placed: number; rejected: number; sorted: number; onPallet: number; generation: number; edges: number }
export interface Hud {
  log(time: number, text: string, tone: Tone): void;
  edge(time: number, n: number, detail: string): void;
  resetEdges(): void;
  status(label: string, tone: Tone): void;
  stats(s: Stats): void;
  tool(vacuum: number, payload: number, speed: number): void;
}

type Proc = Generator<void, void, number>;
interface Spec { sku: Sku; yaw?: number; damaged?: boolean; touching?: boolean; afterPick?: boolean; edge?: number }
type BoxState = 'belt' | 'held' | 'falling' | 'placed' | 'binned' | 'hand';
interface Box {
  id: number; spec: Spec; obj: Group; state: BoxState;
  s: number; z: number; yaw: number; gap: number; vy: number; landY: number; spin: number; onLand: BoxState;
}

const DEG = Math.PI / 180;
/** One pallet's worth of infeed, in arrival order. `edge` marks the box that triggers that case. */
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
const PERSON_FROM = new Vector3(2.35, FLOOR_Y, -1.55);
const PERSON_AT = new Vector3(0.96, FLOOR_Y, -0.34);

const ease = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const halfTurn = (a: number, ref: number) => a + Math.round((ref - a) / Math.PI) * Math.PI;
/** Yaw about +Y of an object's x axis, read from its matrix (Euler angles flip past ±90°). */
const yawOf = (o: Object3D) => { o.updateMatrix(); const e = o.matrix.elements; return Math.atan2(-e[2], e[0]); };
const square = (a: number) => Math.round(a / Math.PI) * Math.PI;
const reach = (yaw: number) => (BOX.L / 2) * Math.abs(Math.cos(yaw)) + (BOX.W / 2) * Math.abs(Math.sin(yaw));

/** Slot k (0..11): each layer fills the back row (nearest the robot) left to right, then the front row. */
export function slotPose(k: number) {
  const layer = Math.floor(k / 6), i = k % 6;
  const row = i < 3 ? -1 : 1;
  return new Vector3(PALLET.x + ((i % 3) - 1) * SLOT_DX, PALLET.top + BOX.H * (layer + 1), PALLET.z + row * SLOT_DZ / 2);
}

/** Swap an object tree onto transparent clones of its materials so it can fade, and back. */
class Fade {
  private clones = new Map<Material, Material>();
  private meshes: Mesh[] = [];
  constructor(roots: Object3D[]) {
    for (const r of roots) r.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.userData.orig = m.material;
      const swap = (mat: Material) => {
        let c = this.clones.get(mat);
        if (!c) { c = mat.clone(); c.transparent = true; this.clones.set(mat, c); }
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
      this.meshes.push(m);
    });
  }
  set(opacity: number) { for (const c of this.clones.values()) { c.opacity = opacity; c.depthWrite = opacity > 0.98; } }
  restore() {
    for (const m of this.meshes) m.material = m.userData.orig;
    for (const c of this.clones.values()) c.dispose();
  }
}

export class Sim {
  time = 0;
  speed = 1;
  private q = [...GLB_HOME];
  private T = new Matrix4();
  private held: Box | null = null;
  private rel = new Matrix4();
  private vac = 0;
  private vacTarget = 0;
  private boxes: Box[] = [];
  private nextId = 1;
  private spawnIdx = 0;
  private running = true;
  private jammed = false;
  private waiting = 0;
  private slotTruth: (Box | null)[] = Array(SLOTS).fill(null);
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
  /** True while the operator is reaching into the pallet: the moment the reduced-motion still shows. */
  personPlacing = false;
  /** True while the operator is in view, so the camera can pull back to fit them. */
  get operatorInCell() { return this.cell.person.root.visible; }

  constructor(private cell: Cell, private hud: Hud) {
    for (const [i, s] of [[0, BELT.stopX], [1, -0.55], [2, -0.95]] as const) {
      const b = this.spawn(PLAN[i]);
      b.s = s - reach(b.yaw);
      this.place(b);
    }
    this.spawnIdx = 3;
    this.apply();
    this.q = this.solve(READY, 0);
    this.apply();
    this.robot = this.program();
    this.robot.next();
    this.status('RUNNING', 'run');
    this.publish();
  }

  // ------------------------------------------------------------------------------------ tick
  step(dt: number) {
    this.time += dt;
    this.safety(dt);
    this.belt(dt);
    this.spawner();
    this.line();
    this.falling(dt);
    this.effects(dt);
    this.robot.next(dt * this.speed);
    this.side = this.side.filter((p) => !p.next(dt).done);
    this.vac += (this.vacTarget - this.vac) * Math.min(1, dt * 14);
    this.toolTick -= dt;
    if (this.toolTick <= 0) {
      this.toolTick = 0.12;
      this.hud.tool(Math.round(this.vac), this.held ? 1.4 : 0, Math.round(this.speed * 100));
    }
  }

  // ------------------------------------------------------------------------------------ robot primitives
  private apply() {
    this.cell.setJoints(this.q);
    fk(this.q, this.T);
    if (this.held) {
      const m = new Matrix4().multiplyMatrices(this.T, this.rel);
      m.decompose(this.held.obj.position, this.held.obj.quaternion, this.held.obj.scale);
    }
  }

  private toolYaw() {
    const e = this.T.elements;
    return Math.atan2(-e[2], e[0]);
  }

  /** IK for a point-to-point goal; a box is symmetric under a half turn, so take the yaw that turns wrist 3 least. */
  private solve(p: Vector3, yaw: number) {
    const a = solveFrom({ p, yaw }, this.q);
    const b = solveFrom({ p, yaw: yaw + Math.PI }, this.q);
    const cost = (s: { q: number[]; err: number }) => Math.abs(s.q[5] - this.q[5]) + Math.abs(s.q[0] - this.q[0]) * 0.5 + s.err * 50;
    return cost(a) <= cost(b) ? a.q : b.q;
  }

  private *moveJ(p: Vector3, yaw: number, scale = 1): Proc {
    const q0 = [...this.q];
    const q1 = this.solve(p, yaw);
    const dq = Math.max(...q1.map((v, i) => Math.abs(v - q0[i])));
    const T = clamp(dq / 2.9 + 0.32, 0.5, 1.35) / scale;
    for (let t = 0; t < T;) {
      t = Math.min(T, t + (yield));
      const s = ease(t / T);
      for (let j = 0; j < 6; j++) this.q[j] = q0[j] + (q1[j] - q0[j]) * s;
      this.apply();
    }
  }

  private *moveL(p1: Vector3, yaw: number | null, T: number): Proc {
    const p0 = new Vector3().setFromMatrixPosition(this.T);
    const y0 = this.toolYaw();
    const y1 = yaw === null ? y0 : halfTurn(nearest(yaw, y0), y0);
    const p = new Vector3();
    for (let t = 0; t < T;) {
      t = Math.min(T, t + (yield));
      const s = ease(t / T);
      p.lerpVectors(p0, p1, s);
      ik({ p, yaw: y0 + (y1 - y0) * s }, this.q, 8, 5e-5);
      this.apply();
    }
  }

  private *wait(sec: number): Proc {
    for (let t = 0; t < sec;) t += yield;
  }

  private *observe(): Proc {
    this.scanT = 0;
    yield* this.wait(0.38);
  }

  private here() { return new Vector3().setFromMatrixPosition(this.T); }

  private attach(b: Box) {
    this.held = b;
    b.state = 'held';
    b.obj.updateMatrix();
    this.rel.copy(this.T).invert().multiply(b.obj.matrix);
  }

  private release(b: Box, state: BoxState) {
    if (this.held === b) this.held = null;
    b.yaw = yawOf(b.obj);
    b.obj.rotation.set(0, b.yaw, 0);
    b.state = state;
  }

  // ------------------------------------------------------------------------------------ the program
  private *program(): Proc {
    yield* this.moveJ(READY, 0);
    for (let loop = 0; ; loop++) {
      for (let i = 0; i < PLAN.length; i++) yield* this.cycle(PLAN[i]);
      yield* this.palletChange();
    }
  }

  private *cycle(spec: Spec): Proc {
    // wait for a part at the photo-eye
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
    if (spec.edge === 1) this.edge(1, `Yaw measured at ${Math.round(box.yaw / DEG)}° off the guide. Grasp re-planned.`);
    if (spec.edge === 4) this.edge(4, 'Depth shows one corner 18 mm low. Routed to the reject bin.');
    if (spec.edge === 6) this.edge(6, 'Label reads SKU-B on an SKU-A pallet. Routed to the SKU-B tote.');
    if (spec.edge === 8) this.side.push(this.operator());

    yield* this.pick(box, spec.edge === 3, spec.edge === 5);
    if (spec.damaged) yield* this.toBin(box, REJECT, 'rejected');
    else if (spec.sku === 'B') yield* this.toBin(box, TOTE_B, 'sorted');
    else yield* this.toPallet(box, spec.edge === 10);
    this.slow = 1;
    yield* this.moveJ(READY, 0);
  }

  private *pick(box: Box, noSeal: boolean, slips: boolean): Proc {
    const top = () => new Vector3(box.s, BELT.top + BOX.H, box.z);
    yield* this.moveL(top().add(new Vector3(0, 0.07, 0)), box.yaw, 0.4);
    yield* this.moveL(top().add(new Vector3(0, -0.004, 0)), null, 0.28);
    this.vacTarget = noSeal ? 9 : 66;
    yield* this.wait(0.2);
    if (noSeal) {
      this.edge(3, 'Vacuum 9 kPa after the press, 55 needed. Venting and pressing again.');
      this.vacTarget = 0;
      yield* this.moveL(top().add(new Vector3(0, 0.04, 0)), null, 0.25);
      yield* this.wait(0.15);
      yield* this.moveL(top().add(new Vector3(0, -0.006, 0)), null, 0.28);
      this.vacTarget = 64;
      yield* this.wait(0.45);
      this.log('Seal confirmed at 64 kPa with +0.25 s dwell', 'ok');
    }
    this.attach(box);
    if (slips) {
      yield* this.moveL(top().add(new Vector3(0, 0.06, 0)), null, 0.2);
      this.vacTarget = 14;
      this.release(box, 'falling');
      box.vy = 0; box.landY = BELT.top + BOX.H; box.spin = 12 * DEG; box.onLand = 'belt';
      this.edge(5, 'Vacuum fell from 62 to 14 kPa in the lift. Motion held, re-locating the box.');
      yield* this.moveL(this.here().add(new Vector3(0, 0.06, 0)), null, 0.3);
      for (; box.state !== 'belt' || !this.partPresent();) yield;
      yield* this.wait(0.2);
      yield* this.observe();
      this.log(`Box found at ${Math.round(box.yaw / DEG)}° yaw, regrasping`, 'info');
      yield* this.pick(box, false, false);
      this.slow = 0.7;
      this.log('Transfer at 70% speed after the slip', 'info');
      return;
    }
    yield* this.moveL(top().add(new Vector3(0, 0.14, 0)), null, 0.3);
  }

  private placeYaw(box: Box, target: number) {
    // keep the box's yaw relative to the tool: tool yaw = target - (box yaw - tool yaw)
    const rel = yawOf(box.obj) - this.toolYaw();
    return target - rel;
  }

  private *toPallet(box: Box, sticks: boolean): Proc {
    let k = this.slotBook.indexOf('empty');
    const yaw = this.placeYaw(box, 0);
    const above = (s: number) => slotPose(s).add(new Vector3(0, 0.13, 0));
    yield* this.moveJ(above(k), yaw, this.slow);
    if (this.slotTruth[k]) {
      yield* this.observe();
      this.slotBook[k] = 'occupied';
      this.edge(9, `Slot ${k + 1} holds a box the robot did not place. Reconciled as occupied, not counted.`);
      k = this.slotBook.indexOf('empty');
      this.log(`Place re-planned to slot ${k + 1}`, 'info');
      yield* this.moveJ(above(k), yaw);
    }
    const at = slotPose(k);
    yield* this.moveL(at.clone().add(new Vector3(0, 0.003, 0)), null, 0.34);
    this.vacTarget = 0;
    yield* this.wait(0.12);
    if (sticks) {
      yield* this.moveL(at.clone().add(new Vector3(0, 0.045, 0)), null, 0.22);
      this.edge(10, 'Box still on the cup after venting. Setting down and pulsing blow-off.');
      yield* this.moveL(at.clone().add(new Vector3(0, 0.003, 0)), null, 0.22);
      this.puffT = 0;
      yield* this.wait(0.3);
      this.log('Release verified by the depth check', 'ok');
    }
    this.release(box, 'placed');
    box.obj.position.copy(at);
    box.obj.rotation.set(0, square(box.yaw), 0);
    this.slotTruth[k] = box;
    this.slotBook[k] = 'occupied';
    this.stats.placed++;
    this.publish();
    yield* this.moveL(at.clone().add(new Vector3(0, 0.12, 0)), null, 0.26);
    this.log(`#${box.id} placed in slot ${k + 1}, verified`, 'ok');
  }

  private *toBin(box: Box, bin: { x: number; z: number; floor: number }, kind: 'rejected' | 'sorted'): Proc {
    const over = new Vector3(bin.x, bin.floor + 0.3, bin.z);
    yield* this.moveJ(over, this.placeYaw(box, 0), this.slow);
    yield* this.moveL(new Vector3(bin.x, bin.floor + 0.2, bin.z), null, 0.28);
    this.vacTarget = 0;
    this.release(box, 'falling');
    box.vy = 0; box.landY = bin.floor + 0.01 + BOX.H; box.spin = 9 * DEG; box.onLand = 'binned';
    yield* this.wait(0.14);
    this.stats[kind]++;
    this.publish();
    yield* this.moveL(over, null, 0.26);
    this.log(`#${box.id} ${kind === 'rejected' ? 'in the reject bin' : 'in the SKU-B tote'}`, 'ok');
  }

  private *palletChange(): Proc {
    this.status('PALLET CHANGE', 'hold');
    this.log(`Pallet full, 12/12. Generation ${this.stats.generation} released downstream`, 'info');
    const exiting = new Group();
    this.cell.scene.add(exiting);
    exiting.attach(this.cell.pallet);
    const gone = this.boxes.filter((b) => b.state === 'placed' || b.state === 'binned' || b.state === 'hand');
    for (const b of gone) if (b.state !== 'binned') exiting.attach(b.obj);
    const fade = new Fade([exiting, ...gone.filter((b) => b.state === 'binned').map((b) => b.obj)]);
    for (let t = 0; t < 2.2;) {
      t = Math.min(2.2, t + (yield));
      exiting.position.x = 0.8 * ease(t / 2.2);
      fade.set(1 - clamp((t - 0.6) / 1.5, 0, 1));
    }
    fade.restore();
    for (const b of gone) b.obj.removeFromParent();
    this.boxes = this.boxes.filter((b) => !gone.includes(b));
    const p = this.cell.pallet;
    this.cell.scene.attach(p);
    exiting.removeFromParent();
    p.position.set(PALLET.x, PALLET.top - 0.14, PALLET.z);
    const fadeIn = new Fade([p]);
    for (let t = 0; t < 1.1;) {
      t = Math.min(1.1, t + (yield));
      p.position.y = PALLET.top - 0.14 * (1 - ease(t / 1.1));
      fadeIn.set(clamp(t / 0.6, 0, 1));
    }
    fadeIn.restore();
    this.slotTruth.fill(null);
    this.slotBook.fill('empty');
    this.stats.generation++;
    this.stats.onPallet = 0;
    this.seen.clear();
    this.hud.resetEdges();
    this.publish();
    this.log(`Empty pallet in place. Generation ${this.stats.generation}`, 'info');
    this.status('RUNNING', 'run');
  }

  // ------------------------------------------------------------------------------------ the operator (case 8 + 9)
  private *operator(): Proc {
    const P = this.cell.person;
    const carried = this.spawn({ sku: 'A' }, false);
    carried.state = 'hand';
    P.hands.add(carried.obj);
    carried.obj.position.set(0, 0.05, 0);
    carried.obj.rotation.set(0, Math.PI / 2, 0);
    P.root.visible = true;
    let phase = 0;
    const walk = function* (from: Vector3, to: Vector3, v: number): Proc {
      const d = to.distanceTo(from);
      P.root.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
      for (let s = 0; s < d;) {
        const dt: number = yield;
        s = Math.min(d, s + v * dt);
        phase += dt * 7.2;
        P.root.position.lerpVectors(from, to, s / d);
        P.pose(phase, 1, carried.state === 'hand' ? 1 : 0, 0);
      }
    };
    const turn = function* (to: number, carry: number): Proc {
      const from = P.root.rotation.y;
      const target = nearest(to, from);
      for (let t = 0; t < 0.4;) {
        t = Math.min(0.4, t + (yield));
        P.root.rotation.y = from + (target - from) * ease(t / 0.4);
        P.pose(phase, 0, carry, 0);
      }
    };
    P.root.position.copy(PERSON_FROM);
    yield* walk(PERSON_FROM, PERSON_AT, 1.15);
    // hand the box onto the next empty slot, the one the robot is about to use
    const k = this.slotBook.indexOf('empty');
    const at = slotPose(k);
    yield* turn(Math.atan2(at.x - PERSON_AT.x, at.z - PERSON_AT.z), 1);
    this.personPlacing = true;
    for (let t = 0; t < 0.45;) { t = Math.min(0.45, t + (yield)); P.pose(phase, 0, 1, ease(t / 0.45)); }
    this.cell.scene.attach(carried.obj);
    const p0 = carried.obj.position.clone();
    const r0 = yawOf(carried.obj);
    const r1 = square(r0);
    for (let t = 0; t < 0.7;) {
      t = Math.min(0.7, t + (yield));
      const s = ease(t / 0.7);
      carried.obj.position.lerpVectors(p0, at, s);
      carried.obj.position.y += Math.sin(s * Math.PI) * 0.04;
      carried.obj.rotation.set(0, r0 + (r1 - r0) * s, 0);
    }
    carried.obj.position.copy(at);
    carried.obj.rotation.set(0, r1, 0);
    carried.state = 'placed';
    this.slotTruth[k] = carried;
    this.publish();
    this.log(`Operator put a box in slot ${k + 1} by hand`, 'info');
    for (let t = 0; t < 0.45;) { t = Math.min(0.45, t + (yield)); P.pose(phase, 0, 1 - ease(t / 0.45), 1 - ease(t / 0.45)); }
    this.personPlacing = false;
    yield* turn(Math.atan2(PERSON_FROM.x - PERSON_AT.x, PERSON_FROM.z - PERSON_AT.z), 0);
    yield* walk(PERSON_AT, PERSON_FROM, 1.25);
    P.root.visible = false;
  }

  private safety(dt: number) {
    const P = this.cell.person.root;
    const r = P.visible ? Math.hypot(P.position.x, P.position.z) : Infinity;
    const field = r < ZONES.stop ? 2 : r < ZONES.warn ? 1 : 0;
    if (field !== this.field) {
      if (field === 1 && this.field === 0) {
        this.edge(8, 'Person in the warning field. Speed scaled to 30%.');
        this.status('REDUCED SPEED · 30%', 'hold');
      } else if (field === 2) {
        this.log('Protective field: safeguard stop, part held on vacuum', 'edge');
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
    const z = this.cell.zones;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 9);
    z.warn.opacity = field >= 1 ? 0.75 + 0.25 * pulse : 0.5;
    z.stop.opacity = field === 2 ? 0.75 + 0.25 * pulse : 0.45;
    z.warnFill.opacity = field === 1 ? 0.1 : 0;
    z.stopFill.opacity = field === 2 ? 0.12 : 0;
  }

  // ------------------------------------------------------------------------------------ conveyor + boxes
  private spawn(spec: Spec, onBelt = true): Box {
    const obj = makeBox({ sku: spec.sku, damaged: spec.damaged });
    const b: Box = {
      id: onBelt ? this.nextId++ : 0, spec, obj, state: onBelt ? 'belt' : 'hand', s: BELT.spawnX, z: BELT.z, yaw: spec.yaw ?? 0,
      gap: spec.touching ? 0 : 0.05, vy: 0, landY: 0, spin: 0, onLand: 'belt',
    };
    this.boxes.push(b);
    this.cell.scene.add(obj);
    return b;
  }

  private place(b: Box) {
    b.obj.position.set(b.s, BELT.top + BOX.H, b.z);
    b.obj.rotation.set(0, b.yaw, 0);
  }

  private onBelt() {
    return this.boxes.filter((b) => b.state === 'belt').sort((a, b) => b.s - a.s);
  }

  private lead() { return this.onBelt()[0]; }

  private partPresent() {
    const b = this.lead();
    return !!b && b.s + reach(b.yaw) >= BELT.stopX - 0.003;
  }

  private belt(dt: number) {
    const v = this.running ? BELT.speed : 0;
    this.cell.beltTex.offset.x -= (v * dt) / 0.12;
    let front = BELT.stopX;
    let first = true;
    // a box the robot has not yet carried clear of the pick window still blocks it (the escapement holds the next)
    for (const b of this.boxes) {
      if (b.state !== 'held' && b.state !== 'falling') continue;
      const p = b.obj.position;
      if (p.x > BELT.x0 && p.x < BELT.x1 && Math.abs(p.z - BELT.z) < 0.2 && p.y < BELT.top + BOX.H + 0.2) {
        front = Math.min(front, p.x - reach(yawOf(b.obj)) - 0.05);
        first = false;
      }
    }
    for (const b of this.onBelt()) {
      const limit = front - (first ? 0 : b.gap) - reach(b.yaw);
      b.s = Math.min(b.s + v * dt, limit);
      this.place(b);
      front = b.s - reach(b.yaw);
      first = false;
    }
    this.cell.eyeBeam.color.set(this.partPresent() ? '#30d158' : '#ff3b30');
  }

  private spawner() {
    if (!this.running) return;
    const spec = PLAN[this.spawnIdx % PLAN.length];
    const belt = this.onBelt();
    if (belt.length >= 3) return;
    const last = belt[belt.length - 1];
    const hx = reach(spec.yaw ?? 0);
    if (last && last.s - reach(last.yaw) < BELT.spawnX + hx + (spec.touching ? 0 : 0.12)) return;
    if (spec.afterPick) {
      const prev = this.boxes.filter((b) => b.spec === PLAN[(this.spawnIdx - 1) % PLAN.length]).pop();
      if (prev && prev.state === 'belt') return;
    }
    const b = this.spawn(spec);
    b.s = spec.touching && last ? last.s - reach(last.yaw) - hx : BELT.spawnX;
    this.place(b);
    this.spawnIdx++;
  }

  /** Case 7: the infeed stops upstream with the next box mid-belt, and restarts once the cell has waited. */
  private line() {
    const b = this.onBelt().find((x) => x.spec.edge === 7);
    if (b && !this.jammed && this.running && b.s > -0.85 && !this.seen.has(7)) {
      this.running = false;
      this.jammed = true;
      this.log('Line: infeed stopped upstream', 'info');
    }
    if (this.jammed && this.waiting > 3.2) {
      this.running = true;
      this.jammed = false;
      this.log('Line: infeed running again', 'info');
    }
    const on = this.jammed && Math.sin(this.time * 10) > 0;
    this.cell.beacon.emissive.set(on ? '#ffb000' : '#000000');
    this.cell.beacon.emissiveIntensity = on ? 2.2 : 0;
  }

  private falling(dt: number) {
    for (const b of this.boxes) {
      if (b.state !== 'falling') continue;
      b.vy -= 9.81 * dt;
      b.obj.position.y += b.vy * dt;
      b.obj.rotation.y += b.spin * dt * 4;
      if (b.obj.position.y <= b.landY) {
        b.obj.position.y = b.landY;
        b.obj.rotation.x = b.obj.rotation.z = 0;
        b.state = b.onLand;
        b.yaw = b.obj.rotation.y;
        if (b.onLand === 'belt') { b.s = b.obj.position.x; b.z = b.obj.position.z; }
        else b.obj.position.y = b.landY;
      }
    }
  }

  private effects(dt: number) {
    const { scan, puff } = this.cell;
    if (this.scanT >= 0) {
      this.scanT += dt;
      const t = this.scanT;
      const a = t < 0.1 ? t / 0.1 : t < 0.24 ? 1 : Math.max(0, 1 - (t - 0.24) / 0.12);
      scan.root.visible = a > 0;
      (scan.mats[0] as Material & { opacity: number }).opacity = 0.16 * a;
      (scan.mats[1] as Material & { opacity: number }).opacity = 0.8 * a;
      if (t > 0.36) { this.scanT = -1; scan.root.visible = false; }
    }
    if (this.puffT >= 0) {
      this.puffT += dt;
      const u = this.puffT / 0.45;
      puff.root.visible = u < 1;
      puff.mat.opacity = 0.85 * (1 - u);
      for (const s of puff.root.children) {
        const [dx, dz] = s.userData.dir as [number, number];
        const r = 0.03 + 0.07 * u;
        s.position.set(dx * r, 0.01 * u, dz * r);
        s.scale.setScalar(1 + u * 1.5);
      }
      if (u >= 1) this.puffT = -1;
    }
  }

  // ------------------------------------------------------------------------------------ HUD plumbing
  private log(text: string, tone: Tone) { this.hud.log(this.time, text, tone); }

  private edge(n: number, detail: string) {
    if (!this.seen.has(n)) { this.seen.add(n); this.stats.edges = this.seen.size; this.publish(); }
    this.hud.edge(this.time, n, detail);
    this.hud.log(this.time, `Edge ${n}/10 · ${CASES[n - 1].code} · ${detail}`, 'edge');
  }

  private status(label: string, tone: Tone) {
    this.hud.status(label, tone);
    const [red, amber, green] = this.cell.stack;
    red.emissiveIntensity = tone === 'stop' ? 2.4 : 0;
    amber.emissiveIntensity = tone === 'hold' ? 2.4 : 0;
    green.emissiveIntensity = tone === 'run' ? 2.0 : 0;
  }

  private publish() {
    this.stats.onPallet = this.slotTruth.filter(Boolean).length;
    this.hud.stats({ ...this.stats });
  }
}

