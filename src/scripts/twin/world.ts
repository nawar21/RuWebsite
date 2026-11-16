// The palletizing cell the twin runs in: an infeed conveyor, a UR5e on a pedestal with a vacuum tool and wrist
// camera, a pallet on a lift table, a reject bin, an SKU-B tote, floor-marked scanner fields, a stack light and an
// operator. Geometry is procedural (no textures to fetch); only the robot comes from public/models/ur5e.glb.
import {
  BoxGeometry, CanvasTexture, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  EdgesGeometry, Group, LineBasicMaterial, LineSegments, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, PlaneGeometry, RepeatWrapping, RingGeometry, Scene, SphereGeometry, SRGBColorSpace, Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FLANGE_Y, GLB_HOME, JOINT_NODES, TOOL_LEN, jointQuat } from './kinematics';

// ------------------------------------------------------------------------------------------- layout
export const FLOOR_Y = -0.82;
export const BOX = { L: 0.15, W: 0.11, H: 0.10 };
export const BELT = { top: -0.04, z: 0.40, x0: -1.45, x1: -0.06, width: 0.30, stopX: -0.10, speed: 0.30, spawnX: -1.36 };
export const PALLET = { x: 0.47, z: 0.08, top: -0.28 };
export const SLOT_DX = 0.16;
export const SLOT_DZ = 0.12;
export const REJECT = { x: -0.56, z: -0.06, floor: -0.47 };
export const TOTE_B = { x: 0.14, z: -0.46, floor: -0.47 };
export const ZONES = { warn: 1.75, stop: 1.15 };

const ZERO = [0, 0, 0] as const;

// -------------------------------------------------------------------------------------- materials
function std(color: string | Texture, metalness = 0, roughness = 0.7) {
  return typeof color === 'string'
    ? new MeshStandardMaterial({ color, metalness, roughness })
    : new MeshStandardMaterial({ map: color, metalness, roughness });
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

function boxTop(sku: 'A' | 'B', damaged = false) {
  return canvas(272, 200, (g) => {
    g.fillStyle = damaged ? '#b58a55' : '#c99f69';
    g.fillRect(0, 0, 272, 200);
    g.fillStyle = 'rgba(255,255,255,0.22)';             // packing tape along the long side
    g.fillRect(0, 82, 272, 36);
    g.fillStyle = 'rgba(0,0,0,0.06)';
    g.fillRect(0, 82, 272, 2); g.fillRect(0, 116, 272, 2);
    g.fillStyle = '#fbfbf8';                              // shipping label
    g.fillRect(150, 128, 108, 62);
    g.fillStyle = sku === 'A' ? '#0071e3' : '#ff8a00';
    g.fillRect(150, 128, 108, 18);
    g.fillStyle = '#fff';
    g.font = `700 14px ${FONT}`;
    g.fillText(`SKU-${sku}`, 158, 142);
    g.fillStyle = '#1d1d1f';
    for (let i = 0, x = 158; x < 248; i++) {             // barcode
      const w = [2, 1, 3, 1, 2, 2, 1, 3][i % 8];
      g.fillRect(x, 152, w, 30);
      x += w + [1, 2, 1, 2][i % 4];
    }
    if (damaged) {                                        // crushed corner: crease lines and a scuff
      g.strokeStyle = 'rgba(60,35,10,0.55)';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(272, 40); g.lineTo(208, 0); g.moveTo(272, 70); g.lineTo(180, 4); g.stroke();
      g.fillStyle = 'rgba(70,40,10,0.25)';
      g.beginPath(); g.ellipse(250, 22, 30, 18, 0.5, 0, Math.PI * 2); g.fill();
    }
  });
}

function sign(text: string, bg: string, fg = '#fff') {
  return canvas(256, 72, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 256, 72);
    g.fillStyle = fg; g.font = `700 34px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 38);
  });
}

function floorTexture() {
  return canvas(1024, 1024, (g) => {
    const r = 512;
    g.clearRect(0, 0, 1024, 1024);
    g.fillStyle = '#e9ecf1';
    g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = 'rgba(0,60,140,0.07)';
    g.lineWidth = 2;
    for (let i = 0; i <= 1024; i += 64) {                 // 0.5 m grid on an 8 m floor
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(1024, i); g.stroke();
    }
    g.globalCompositeOperation = 'destination-in';        // fade to transparent at the edge
    const fade = g.createRadialGradient(r, r, r * 0.35, r, r, r);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, 1024, 1024);
  });
}

function beltTexture() {
  const t = canvas(64, 64, (g) => {
    g.fillStyle = '#2b2f36'; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#3a3f48'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(8, 0); g.lineTo(32, 32); g.lineTo(8, 64); g.stroke();
  });
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------------------------------- helpers
function mesh(geo: BoxGeometry | CylinderGeometry | CapsuleGeometry | SphereGeometry, mat: Material | Material[],
  p: readonly number[] = ZERO, cast = true, receive = false) {
  const m = new Mesh(geo, mat);
  m.position.set(p[0], p[1], p[2]);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
const bx = (w: number, h: number, d: number, mat: Material | Material[], p: readonly number[], cast = true, receive = false) =>
  mesh(new BoxGeometry(w, h, d), mat, p, cast, receive);

// ------------------------------------------------------------------------------------------- boxes
export type Sku = 'A' | 'B';
export interface BoxKind { sku: Sku; damaged?: boolean }

let boxMats: Record<string, Material[]> | null = null;
let boxGeo: BoxGeometry | null = null;
let dentGeo: BoxGeometry | null = null;

function boxMaterials() {
  if (boxMats) return boxMats;
  const side = std('#c39762', 0, 0.9);
  const sideDark = std('#b4884f', 0, 0.9);
  const top = (sku: Sku, d = false) => std(boxTop(sku, d), 0, 0.8);
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  boxMats = {
    A: [side, side, top('A'), side, sideDark, sideDark],
    B: [side, side, top('B'), side, sideDark, sideDark],
    D: [sideDark, sideDark, top('A', true), sideDark, sideDark, sideDark],
  };
  return boxMats;
}

function boxGeometry(damaged: boolean) {
  if (!boxGeo) {
    boxGeo = new BoxGeometry(BOX.L, BOX.H, BOX.W);
    boxGeo.translate(0, -BOX.H / 2, 0);                   // origin at the top centre, where the cup grips
    dentGeo = boxGeo.clone();
    const pos = dentGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {                 // crush the +x,+z top corner 18 mm
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x > 0 && z > 0 && y > -0.001) pos.setY(i, -0.018);
    }
    dentGeo.computeVertexNormals();
  }
  return damaged ? dentGeo! : boxGeo;
}

export function makeBox(kind: BoxKind) {
  const mats = boxMaterials();
  const g = new Group();
  const m = new Mesh(boxGeometry(!!kind.damaged), kind.damaged ? mats.D : mats[kind.sku]);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return g;
}

// ------------------------------------------------------------------------------------------- person
export interface Person {
  root: Group;
  hands: Object3D;                                         // where a carried box sits
  pose(phase: number, walk: number, carry: number, reach: number): void;
}

function makePerson(): Person {
  const vest = std('#ff7a1a', 0, 0.6);
  const cloth = std('#2c3442', 0, 0.85);
  const skin = std('#d8d2c8', 0, 0.7);
  const hat = std('#ffd60a', 0, 0.35);
  const stripe = std('#e9edf2', 0.2, 0.3);
  const shoe = std('#16181c', 0, 0.6);

  const root = new Group();
  const hips = new Group(); hips.position.y = 0.93; root.add(hips);
  const legs: Group[] = [];
  const arms: Group[] = [];
  for (const s of [-1, 1]) {
    const leg = new Group(); leg.position.set(s * 0.09, 0, 0);
    leg.add(mesh(new CapsuleGeometry(0.068, 0.7, 4, 10), cloth, [0, -0.43, 0]));
    leg.add(bx(0.1, 0.07, 0.24, shoe, [0, -0.89, 0.04]));
    hips.add(leg); legs.push(leg);
    const arm = new Group(); arm.position.set(s * 0.23, 0.52, 0);
    arm.add(mesh(new CapsuleGeometry(0.052, 0.46, 4, 10), vest, [0, -0.27, 0]));
    arm.add(mesh(new SphereGeometry(0.055, 12, 10), skin, [0, -0.56, 0]));
    hips.add(arm); arms.push(arm);
  }
  hips.add(mesh(new CapsuleGeometry(0.17, 0.34, 6, 14), vest, [0, 0.33, 0]));
  for (const y of [0.22, 0.36]) {
    const band = mesh(new CylinderGeometry(0.178, 0.178, 0.025, 20, 1, true), stripe, [0, y, 0], false);
    hips.add(band);
  }
  hips.add(mesh(new SphereGeometry(0.1, 16, 12), skin, [0, 0.76, 0]));
  const helmet = mesh(new SphereGeometry(0.118, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), hat, [0, 0.79, 0]);
  hips.add(helmet);
  hips.add(mesh(new CylinderGeometry(0.15, 0.15, 0.012, 20), hat, [0, 0.79, 0.02]));
  const hands = new Object3D(); hands.position.set(0, 0.36, 0.34); hips.add(hands);

  return {
    root, hands,
    pose(phase, walk, carry, reach) {
      const sw = Math.sin(phase);
      legs[0].rotation.x = sw * 0.5 * walk;
      legs[1].rotation.x = -sw * 0.5 * walk;
      hips.position.y = 0.93 + Math.abs(Math.cos(phase)) * 0.025 * walk;
      const swing = sw * 0.4 * walk * (1 - carry);
      const fwd = -1.25 * carry - 0.35 * reach;              // arms forward to carry, further to reach
      arms[0].rotation.x = fwd - swing;
      arms[1].rotation.x = fwd + swing;
      arms[0].rotation.z = arms[1].rotation.z = 0;
      hands.position.set(0, 0.36 + 0.06 * reach, 0.34 + 0.18 * reach);
    },
  };
}

// ------------------------------------------------------------------------------------------- the cell
export interface Cell {
  scene: Scene;
  joints: Object3D[];
  tcp: Object3D;                                           // follows the cup lip
  scan: { root: Group; mats: Material[] };
  puff: { root: Group; mat: MeshBasicMaterial };
  beltTex: Texture;
  eyeBeam: MeshBasicMaterial;
  beacon: MeshStandardMaterial;
  stack: MeshStandardMaterial[];                           // red, amber, green
  zones: { warn: MeshBasicMaterial; stop: MeshBasicMaterial; warnFill: MeshBasicMaterial; stopFill: MeshBasicMaterial };
  pallet: Group;                                           // pallet deck, slots are relative to PALLET
  lift: Group;                                             // the lift table top (rises with a new pallet)
  person: Person;
  setJoints(q: ArrayLike<number>): void;
}

export async function buildCell(modelUrl: string): Promise<Cell> {
  const scene = new Scene();

  // floor + scanner fields
  const floor = new Mesh(new PlaneGeometry(8, 8), new MeshStandardMaterial({ map: floorTexture(), transparent: true, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0.2, FLOOR_Y, 0.2);
  floor.receiveShadow = true;
  scene.add(floor);
  const ring = (r: number, color: string, width: number) => {
    const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
    const m = new Mesh(new RingGeometry(r - width, r, 128), mat);
    m.rotation.x = -Math.PI / 2; m.position.y = FLOOR_Y + 0.003;
    scene.add(m);
    const fillMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
    const fill = new Mesh(new RingGeometry(r === ZONES.warn ? ZONES.stop : 0.12, r - width, 128), fillMat);
    fill.rotation.x = -Math.PI / 2; fill.position.y = FLOOR_Y + 0.002;
    scene.add(fill);
    return [mat, fillMat] as const;
  };
  const [warn, warnFill] = ring(ZONES.warn, '#f2b600', 0.045);
  const [stop, stopFill] = ring(ZONES.stop, '#ff3b30', 0.045);

  // pedestal + area scanner
  const darkSteel = std('#596069', 0.45, 0.45);
  const steel = std('#a9b0ba', 0.6, 0.35);
  const plate = std('#2f343b', 0.5, 0.45);
  scene.add(bx(0.2, -FLOOR_Y - 0.02, 0.2, darkSteel, [0, (FLOOR_Y - 0.02) / 2, 0], true, true));
  scene.add(bx(0.26, 0.02, 0.26, plate, [0, -0.01, 0], true, true));
  scene.add(bx(0.4, 0.02, 0.4, plate, [0, FLOOR_Y + 0.01, 0], false, true));
  scene.add(mesh(new CylinderGeometry(0.055, 0.06, 0.09, 24), std('#f2c300', 0.1, 0.4), [0.13, FLOOR_Y + 0.2, 0.13]));
  scene.add(mesh(new CylinderGeometry(0.045, 0.045, 0.03, 24), std('#16181c', 0.2, 0.3), [0.13, FLOOR_Y + 0.26, 0.13]));

  // infeed conveyor
  const frame = std('#c4cad2', 0.55, 0.32);
  const len = BELT.x1 - BELT.x0;
  const cx = (BELT.x0 + BELT.x1) / 2;
  const beltTex = beltTexture();
  beltTex.repeat.set(len / 0.12, 1);
  const belt = bx(len, 0.02, BELT.width, [std('#2b2f36'), std('#2b2f36'), std(beltTex, 0, 0.85), std('#2b2f36'), std('#2b2f36'), std('#2b2f36')],
    [cx, BELT.top - 0.01, BELT.z], false, true);
  scene.add(belt);
  for (const s of [-1, 1]) {
    scene.add(bx(len + 0.04, 0.07, 0.025, frame, [cx, BELT.top - 0.02, BELT.z + s * (BELT.width / 2 + 0.0125)], true, true));
    for (const x of [BELT.x0 + 0.08, cx, BELT.x1 - 0.06]) {
      scene.add(bx(0.04, BELT.top - 0.06 - FLOOR_Y, 0.04, steel, [x, (BELT.top - 0.06 + FLOOR_Y) / 2, BELT.z + s * 0.13]));
    }
  }
  for (const x of [BELT.x0, BELT.x1]) {
    const roller = mesh(new CylinderGeometry(0.022, 0.022, BELT.width, 16), steel, [x, BELT.top - 0.022, BELT.z]);
    roller.rotation.x = Math.PI / 2;
    scene.add(roller);
  }
  scene.add(bx(0.02, 0.045, BELT.width, std('#ffcc00', 0.2, 0.5), [BELT.stopX + 0.01, BELT.top + 0.022, BELT.z])); // hard stop
  // infeed hood hides boxes as they come onto the belt
  const hood = std('#eef0f3', 0.1, 0.55);
  const hx = BELT.x0 + 0.14;
  scene.add(bx(0.3, 0.012, BELT.width + 0.08, hood, [hx, BELT.top + 0.22, BELT.z]));
  for (const s of [-1, 1]) scene.add(bx(0.3, 0.24, 0.012, hood, [hx, BELT.top + 0.1, BELT.z + s * (BELT.width / 2 + 0.04)]));
  scene.add(bx(0.012, 0.24, BELT.width + 0.08, hood, [BELT.x0 - 0.01, BELT.top + 0.1, BELT.z]));
  const strip = new MeshBasicMaterial({ color: '#1d1d1f', transparent: true, opacity: 0.35, side: DoubleSide });
  const curtain = new Mesh(new PlaneGeometry(BELT.width + 0.06, 0.2), strip);
  curtain.rotation.y = Math.PI / 2; curtain.position.set(hx + 0.15, BELT.top + 0.11, BELT.z);
  scene.add(curtain);
  // photo-eye at the pick window
  const eyeX = BELT.stopX - BOX.L / 2;
  for (const s of [-1, 1]) scene.add(bx(0.03, 0.09, 0.03, std('#1d1f23', 0.3, 0.4), [eyeX, BELT.top + 0.045, BELT.z + s * (BELT.width / 2 + 0.035)]));
  const eyeBeam = new MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.7 });
  const beam = new Mesh(new CylinderGeometry(0.002, 0.002, BELT.width + 0.07, 6), eyeBeam);
  beam.rotation.x = Math.PI / 2; beam.position.set(eyeX, BELT.top + 0.06, BELT.z);
  scene.add(beam);
  // conveyor beacon (amber when the line stops)
  const beacon = new MeshStandardMaterial({ color: '#c9a64a', emissive: '#000000', roughness: 0.3, transparent: true, opacity: 0.9 });
  scene.add(mesh(new CylinderGeometry(0.004, 0.004, 0.16, 6), steel, [BELT.x0 + 0.35, BELT.top + 0.08, BELT.z - 0.19]));
  scene.add(mesh(new CylinderGeometry(0.022, 0.022, 0.05, 16), beacon, [BELT.x0 + 0.35, BELT.top + 0.18, BELT.z - 0.19]));

  // pallet station: lift table + pallet
  const lift = new Group();
  scene.add(lift);
  const liftTopY = PALLET.top - 0.085;
  const legH = liftTopY - 0.03 - FLOOR_Y;
  for (const dx of [-0.26, 0.31]) for (const dz of [-0.15, 0.15]) {
    scene.add(bx(0.04, legH, 0.04, steel, [PALLET.x + dx, FLOOR_Y + legH / 2, PALLET.z + dz]));
  }
  scene.add(bx(0.62, 0.05, 0.36, std('#7b828c', 0.5, 0.4), [PALLET.x + 0.025, liftTopY - 0.055, PALLET.z], true, true));
  lift.add(bx(0.6, 0.03, 0.38, steel, [PALLET.x + 0.025, liftTopY - 0.015, PALLET.z], true, true));
  const pallet = makePallet();
  pallet.position.set(PALLET.x, PALLET.top, PALLET.z);
  scene.add(pallet);

  // reject bin + SKU-B tote on stands, with signs
  tote(scene, REJECT, '#e5484d', sign('REJECT', '#e5484d'), darkSteel);
  tote(scene, TOTE_B, '#ff9f0a', sign('SKU-B', '#ff9f0a', '#1d1d1f'), darkSteel);

  // stack light
  const stack: MeshStandardMaterial[] = [];
  const sx = -1.15, sz = -0.25, top = FLOOR_Y + 1.05;
  scene.add(mesh(new CylinderGeometry(0.015, 0.015, 1.05, 10), steel, [sx, FLOOR_Y + 0.525, sz]));
  scene.add(mesh(new CylinderGeometry(0.09, 0.1, 0.02, 20), plate, [sx, FLOOR_Y + 0.01, sz], false, true));
  ['#ff3b30', '#ffb000', '#30d158'].forEach((c, i) => {
    const m = new MeshStandardMaterial({ color: new Color(c).multiplyScalar(0.35), emissive: c, emissiveIntensity: 0, roughness: 0.25, metalness: 0 });
    stack.push(m);
    scene.add(mesh(new CylinderGeometry(0.035, 0.035, 0.075, 20), m, [sx, top + 0.04 + (2 - i) * 0.08, sz]));
  });
  scene.add(mesh(new CylinderGeometry(0.036, 0.036, 0.02, 20), plate, [sx, top + 0.27, sz]));

  // robot
  const gltf = await new GLTFLoader().loadAsync(modelUrl);
  const robot = gltf.scene;
  robot.traverse((o) => {
    if ((o as Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  scene.add(robot);
  const joints = JOINT_NODES.map((n) => {
    const node = robot.getObjectByName(n);
    if (!node) throw new Error(`ur5e.glb has no node ${n}`);
    return node;
  });
  const wrist3 = joints[5];
  const tool = makeTool();
  tool.root.position.y = FLANGE_Y;
  wrist3.add(tool.root);
  const tcp = new Object3D();
  tcp.position.y = FLANGE_Y + TOOL_LEN;
  wrist3.add(tcp);

  const person = makePerson();
  person.root.visible = false;
  scene.add(person.root);

  const setJoints = (q: ArrayLike<number>) => {
    for (let j = 0; j < 6; j++) jointQuat(j, q[j], joints[j].quaternion);
  };
  setJoints(GLB_HOME);

  return {
    scene, joints, tcp, scan: tool.scan, puff: tool.puff, beltTex, eyeBeam, beacon, stack,
    zones: { warn, stop, warnFill, stopFill }, pallet, lift, person, setJoints,
  };
}

function makePallet() {
  const wood = std('#dcbc8e', 0, 0.8);
  const woodDark = std('#c9a774', 0, 0.85);
  const p = new Group();
  const w = 0.52, d = 0.34;
  for (let i = 0; i < 5; i++) p.add(bx(w, 0.014, 0.056, wood, [0, -0.007, -d / 2 + 0.028 + i * ((d - 0.056) / 4)], true, true));
  for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) p.add(bx(w, 0.05, 0.05, woodDark, [0, -0.039, z], true, true));
  for (let i = 0; i < 3; i++) p.add(bx(w, 0.012, 0.07, wood, [0, -0.07, -d / 2 + 0.035 + i * ((d - 0.07) / 2)], true, true));
  return p;
}

function tote(scene: Scene, at: { x: number; z: number; floor: number }, color: string, label: Texture, stand: Material) {
  const m = std(color, 0, 0.55);
  const inner = std(new Color(color).multiplyScalar(0.75).getStyle(), 0, 0.7);
  const w = 0.3, d = 0.24, h = 0.16, t = 0.01;
  const y = at.floor;
  const g = new Group();
  g.add(bx(w, t, d, inner, [0, t / 2, 0], false, true));
  g.add(bx(w, h, t, m, [0, h / 2, d / 2 - t / 2]));
  g.add(bx(w, h, t, m, [0, h / 2, -d / 2 + t / 2]));
  g.add(bx(t, h, d, m, [w / 2 - t / 2, h / 2, 0]));
  g.add(bx(t, h, d, m, [-w / 2 + t / 2, h / 2, 0]));
  g.position.set(at.x, y, at.z);
  scene.add(g);
  for (const dx of [-0.11, 0.11]) for (const dz of [-0.08, 0.08]) {
    scene.add(bx(0.03, y - FLOOR_Y, 0.03, stand, [at.x + dx, (y + FLOOR_Y) / 2, at.z + dz]));
  }
  scene.add(bx(0.27, 0.02, 0.21, stand, [at.x, y - 0.01, at.z], true, true));
  const s = new Mesh(new PlaneGeometry(0.2, 0.056), new MeshBasicMaterial({ map: label }));
  s.position.set(at.x, y + h * 0.55, at.z + d / 2 + 0.002);
  scene.add(s);
}

function makeTool() {
  const root = new Group();
  const alu = std('#c9ced6', 0.7, 0.3);
  const black = std('#1b1d21', 0.2, 0.55);
  const rubber = std('#2a2c30', 0, 0.85);
  const cyl = (r0: number, r1: number, h: number, mat: Material, y: number) => {
    const m = mesh(new CylinderGeometry(r1, r0, h, 24), mat, [0, y + h / 2, 0]);
    root.add(m);
  };
  cyl(0.032, 0.032, 0.012, black, 0);                     // flange adapter
  cyl(0.024, 0.024, 0.09, alu, 0.012);                    // vacuum tube
  cyl(0.017, 0.017, 0.012, black, 0.102);
  cyl(0.016, 0.03, 0.031, rubber, 0.114);                 // bellows cup to the lip at TOOL_LEN
  root.add(bx(0.03, 0.05, 0.03, alu, [0.035, 0.045, 0]));  // ejector block
  // wrist camera (D435i-sized bar) looking along the tool axis
  const cam = new Group();
  cam.position.set(0, 0.03, -0.06);
  cam.add(bx(0.09, 0.025, 0.025, std('#2b2e33', 0.3, 0.4), ZERO));
  cam.add(bx(0.02, 0.02, 0.025, alu, [0, 0, 0.02]));
  root.add(cam);
  const scanMat = new MeshBasicMaterial({ color: '#0a84ff', transparent: true, opacity: 0, depthWrite: false, side: DoubleSide });
  const cone = new ConeGeometry(0.2, 0.36, 4, 1, true);
  cone.rotateX(Math.PI);
  cone.rotateY(Math.PI / 4);
  cone.translate(0, 0.18, 0);
  const scan = new Group();
  scan.add(new Mesh(cone, scanMat));
  const edgeMat = new LineBasicMaterial({ color: '#0a84ff', transparent: true, opacity: 0 });
  scan.add(new LineSegments(new EdgesGeometry(cone), edgeMat));
  scan.position.set(0, 0.012, 0);
  scan.visible = false;
  cam.add(scan);
  // blow-off puff
  const puffMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
  const puff = new Group();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const s = new Mesh(new SphereGeometry(0.012, 8, 6), puffMat);
    s.position.set(Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03);
    s.userData.dir = [Math.cos(a), Math.sin(a)];
    puff.add(s);
  }
  puff.position.y = TOOL_LEN - 0.01;
  puff.visible = false;
  root.add(puff);
  return { root, scan: { root: scan, mats: [scanMat, edgeMat] as Material[] }, puff: { root: puff, mat: puffMat } };
}

