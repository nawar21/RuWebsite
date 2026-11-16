// UR5e kinematics for the digital twin: forward kinematics from the MuJoCo Menagerie body tree (the same
// tree public/models/ur5e.glb is built from) and a damped-least-squares IK for a downward-facing vacuum tool.
// Everything is in the twin's world frame (Y up, metres); the robot base sits at the origin.
import { Matrix4, Quaternion, Vector3 } from 'three';

export type Joints = [number, number, number, number, number, number];

/** Body names in public/models/ur5e.glb, one per joint, base to wrist. */
export const JOINT_NODES = [
  'shoulder_link', 'upper_arm_link', 'forearm_link', 'wrist_1_link', 'wrist_2_link', 'wrist_3_link',
] as const;

const Y90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
const ID = new Quaternion();
/** MJCF body offsets, rest rotations and joint axes (ur5e.xml). */
const BODY_POS = [[0, 0, 0.163], [0, 0.138, 0], [0, -0.131, 0.425], [0, 0, 0.392], [0, 0.127, 0], [0, 0, 0.1]]
  .map(([x, y, z]) => new Vector3(x, y, z));
export const REST = [ID, Y90, ID, Y90, ID, ID];
export const AXES = [[0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 1, 0]]
  .map(([x, y, z]) => new Vector3(x, y, z));
/** The pose the GLB was exported in (its node rotations include it). */
export const GLB_HOME: Joints = [-1.5708, -1.5708, 1.5708, -1.5708, -1.5708, 0];

/** Flange (attachment_site) offset in the wrist_3 frame, plus the vacuum tool length to the cup lip. */
export const FLANGE_Y = 0.1;
export const TOOL_LEN = 0.145;

// glTF root: MuJoCo Z-up to Y-up (-90° about X), then the base body's quat "0 0 0 -1" (180° about Z).
const ROOT = new Matrix4()
  .makeRotationX(-Math.PI / 2)
  .multiply(new Matrix4().makeRotationZ(Math.PI));
// Tool frame in wrist_3: z along wrist_3 +y (the flange normal), x along wrist_3 +x.
const TOOL = new Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, FLANGE_Y + TOOL_LEN, 0);

const _m = new Matrix4();
const _q = new Quaternion();
const _qa = new Quaternion();

/** Local rotation of joint j's node at angle q (rest * axis-angle). */
export function jointQuat(j: number, q: number, out = new Quaternion()) {
  return out.copy(REST[j]).multiply(_qa.setFromAxisAngle(AXES[j], q));
}

/** World transform of the tool centre point (cup lip), tool z pointing out of the cup. */
export function fk(q: ArrayLike<number>, out = new Matrix4()) {
  out.copy(ROOT);
  for (let j = 0; j < 6; j++) {
    jointQuat(j, q[j], _q);
    _m.compose(BODY_POS[j], _q, ONE);
    out.multiply(_m);
  }
  return out.multiply(TOOL);
}
const ONE = new Vector3(1, 1, 1);

/** Target rotation: tool z straight down, tool x at `yaw` about world +Y. */
export function downRotation(yaw: number, out = new Matrix4()) {
  // columns: x = (cos, 0, -sin), y = (sin, 0, cos)... chosen so yaw is a right-handed turn about +Y
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(
    c, s, 0, 0,
    0, 0, -1, 0,
    -s, c, 0, 0,
    0, 0, 0, 1,
  );
}

export interface Target { p: Vector3; yaw: number }

// ---------------------------------------------------------------------------------------------- IK
const LIM = [2 * Math.PI, 2 * Math.PI, Math.PI, 2 * Math.PI, 2 * Math.PI, 2 * Math.PI];
const J = new Float64Array(36);
const A = new Float64Array(36);
const e = new Float64Array(6);
const x = new Float64Array(6);
const T0 = new Matrix4();
const T1 = new Matrix4();
const Rt = new Matrix4();
const P0 = new Vector3();
const P1 = new Vector3();
const Q0 = new Quaternion();
const Q1 = new Quaternion();
const Qt = new Quaternion();
const _d = new Quaternion();
const _v = new Vector3();

/** Rotation vector (axis * angle) of qa * qb^-1, written into out[o..o+2]. */
function rotErr(qa: Quaternion, qb: Quaternion, out: Float64Array, o: number, scale = 1) {
  _d.copy(qb).invert().premultiply(qa);
  if (_d.w < 0) { _d.x = -_d.x; _d.y = -_d.y; _d.z = -_d.z; _d.w = -_d.w; }
  const s = Math.hypot(_d.x, _d.y, _d.z);
  const ang = 2 * Math.atan2(s, _d.w);
  const k = s < 1e-9 ? 2 : ang / s;
  out[o] = _d.x * k * scale; out[o + 1] = _d.y * k * scale; out[o + 2] = _d.z * k * scale;
}

/** Solve (J J^T + λ²I) x = e in place (6x6, Gaussian elimination with partial pivoting). */
function solve6(lambda2: number) {
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    let s = r === c ? lambda2 : 0;
    for (let k = 0; k < 6; k++) s += J[r * 6 + k] * J[c * 6 + k];
    A[r * 6 + c] = s;
  }
  for (let i = 0; i < 6; i++) x[i] = e[i];
  for (let c = 0; c < 6; c++) {
    let p = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(A[r * 6 + c]) > Math.abs(A[p * 6 + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < 6; k++) { const t = A[c * 6 + k]; A[c * 6 + k] = A[p * 6 + k]; A[p * 6 + k] = t; }
      const t = x[c]; x[c] = x[p]; x[p] = t;
    }
    const d = A[c * 6 + c];
    for (let r = c + 1; r < 6; r++) {
      const f = A[r * 6 + c] / d;
      if (!f) continue;
      for (let k = c; k < 6; k++) A[r * 6 + k] -= f * A[c * 6 + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = 5; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < 6; k++) s -= A[r * 6 + k] * x[k];
    x[r] = s / A[r * 6 + r];
  }
}

/**
 * Damped least squares from the seed `q` (modified in place). Returns the remaining error
 * (metres + radians/4). A warm start from the previous frame converges in 2-4 iterations.
 */
export function ik(target: Target, q: number[], iters = 60, tol = 2e-4) {
  downRotation(target.yaw, Rt);
  Qt.setFromRotationMatrix(Rt);
  const eps = 1e-5;
  let err = Infinity;
  for (let it = 0; it < iters; it++) {
    fk(q, T0);
    P0.setFromMatrixPosition(T0);
    Q0.setFromRotationMatrix(T0);
    _v.subVectors(target.p, P0);
    e[0] = _v.x; e[1] = _v.y; e[2] = _v.z;
    rotErr(Qt, Q0, e, 3, 0.25);              // orientation weighted: 1 rad ≈ 25 cm
    err = Math.hypot(e[0], e[1], e[2], e[3], e[4], e[5]);
    if (err < tol) break;
    for (let j = 0; j < 6; j++) {
      const keep = q[j];
      q[j] = keep + eps;
      fk(q, T1);
      q[j] = keep;
      P1.setFromMatrixPosition(T1);
      Q1.setFromRotationMatrix(T1);
      J[0 * 6 + j] = (P1.x - P0.x) / eps;
      J[1 * 6 + j] = (P1.y - P0.y) / eps;
      J[2 * 6 + j] = (P1.z - P0.z) / eps;
      _d.copy(Q0).invert().premultiply(Q1);
      const s = Math.hypot(_d.x, _d.y, _d.z);
      const k = s < 1e-12 ? 2 : (2 * Math.atan2(s, _d.w)) / s;
      J[3 * 6 + j] = (_d.x * k * 0.25) / eps;
      J[4 * 6 + j] = (_d.y * k * 0.25) / eps;
      J[5 * 6 + j] = (_d.z * k * 0.25) / eps;
    }
    solve6(err > 0.05 ? 4e-3 : 2.5e-4);
    // dq = J^T x, step-limited
    let max = 0;
    const dq = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let r = 0; r < 6; r++) s += J[r * 6 + j] * x[r];
      dq[j] = s;
      max = Math.max(max, Math.abs(s));
    }
    const k = max > 0.35 ? 0.35 / max : 1;
    for (let j = 0; j < 6; j++) q[j] = Math.max(-LIM[j], Math.min(LIM[j], q[j] + dq[j] * k));
  }
  return err;
}

const TAU = Math.PI * 2;
/** Shift an angle by whole turns so it lands nearest `ref`. */
export function nearest(a: number, ref: number) {
  return a + Math.round((ref - a) / TAU) * TAU;
}

/**
 * IK for a point-to-point move: seed an elbow-up, tool-down configuration facing the target (pan from the
 * geometry, shoulder/elbow from a typical overhead pick, wrist 1 keeping the tool vertical), solve, then keep
 * wrist 3 within half a turn of where it starts so the tool never unwinds a full turn.
 */
export function solveFrom(target: Target, from: ArrayLike<number>): { q: number[]; err: number } {
  // At pan = -90° the arm reaches towards world -Z; pan turns it about +Y.
  const pan = -Math.PI / 2 + Math.atan2(-target.p.x, -target.p.z);
  const q2 = -1.75, q3 = 1.95;
  const q = [nearest(pan, from[0]), q2, q3, -Math.PI / 2 - q2 - q3, -Math.PI / 2, from[5]];
  let err = ik(target, q, 120);
  q[5] = nearest(q[5], from[5]);
  return { q, err };
}
