// The palletizing cell the twin runs in, inside a factory hall: an infeed conveyor, a UR5e on a pedestal with a
// vacuum tool and wrist camera, a pallet on a lift table, a reject bin, an SKU-B tote, perimeter guarding with a
// scanner-guarded opening, a stack light, an operator, and a running line and pallet racking behind the fence.
// Everything is procedural (canvas textures, no files to fetch) except the robot, public/models/ur5e.glb.
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CapsuleGeometry, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  EdgesGeometry, Fog, Group, InstancedMesh, LineBasicMaterial, LineSegments, Material, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, RepeatWrapping, RingGeometry, Scene,
  SphereGeometry, SRGBColorSpace, Texture, TorusGeometry, TubeGeometry, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
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
export const HALL = '#dde1e6';                              // background + fog colour of the hall

const ZERO = [0, 0, 0] as const;

// -------------------------------------------------------------------------------------- textures
/** Seeded PRNG so every visitor gets the same textures. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

/** Scatter n soft specks: concrete aggregate, cardboard fibre, wood grain flecks. */
function speckle(g: CanvasRenderingContext2D, w: number, h: number, n: number, seed: number, colors: string[], size: [number, number]) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = size[0] + r() * (size[1] - size[0]);
    g.fillRect(r() * w, r() * h, s, s * (0.4 + r()));
  }
}

const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

function concrete() {
  // 512 px = 3 m: light polished concrete with aggregate, trowel clouds and a saw-cut joint on two edges
  return canvas(512, 512, (g) => {
    g.fillStyle = '#cfd2d6'; g.fillRect(0, 0, 512, 512);
    const r = rng(7);
    for (let i = 0; i < 70; i++) {
      const x = r() * 512, y = r() * 512, rad = 30 + r() * 110;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      const tone = r() > 0.5 ? '255,255,255' : '120,124,130';
      grad.addColorStop(0, `rgba(${tone},${0.05 + r() * 0.06})`);
      grad.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grad; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    speckle(g, 512, 512, 5000, 11, ['rgba(90,94,100,0.18)', 'rgba(255,255,255,0.22)', 'rgba(140,130,120,0.15)'], [0.6, 1.8]);
    g.fillStyle = 'rgba(70,74,80,0.35)';
    g.fillRect(0, 0, 512, 2); g.fillRect(0, 0, 2, 512);
  }, true);
}

function cardboardSide(printed: boolean) {
  return canvas(256, 176, (g) => {
    g.fillStyle = '#c49a64'; g.fillRect(0, 0, 256, 176);
    speckle(g, 256, 176, 1400, 3, ['rgba(120,80,40,0.12)', 'rgba(255,235,200,0.12)'], [0.5, 1.5]);
    for (let y = 0; y < 176; y += 5) { g.fillStyle = `rgba(110,75,35,${y % 10 ? 0.025 : 0.05})`; g.fillRect(0, y, 256, 2); } // flute ribs
    if (printed) {
      g.fillStyle = 'rgba(40,30,25,0.75)';
      g.font = `700 22px ${FONT}`; g.fillText('RU', 18, 40);
      g.font = `500 11px ${FONT}`; g.fillText('ROBOTICS', 52, 39);
      g.strokeStyle = 'rgba(40,30,25,0.7)'; g.lineWidth = 3;
      for (const x of [200, 222]) {                             // "this way up" arrows
        g.beginPath(); g.moveTo(x, 54); g.lineTo(x, 26); g.moveTo(x - 7, 34); g.lineTo(x, 24); g.lineTo(x + 7, 34); g.stroke();
      }
      g.fillRect(18, 150, 220, 2);
    }
  });
}

function cardboardTop(sku: 'A' | 'B', damaged = false) {
  return canvas(272, 200, (g) => {
    g.fillStyle = damaged ? '#b48650' : '#c8a06a'; g.fillRect(0, 0, 272, 200);
    speckle(g, 272, 200, 1600, 5, ['rgba(120,80,40,0.12)', 'rgba(255,235,200,0.14)'], [0.5, 1.6]);
    g.fillStyle = 'rgba(80,50,20,0.55)'; g.fillRect(0, 99, 272, 2);   // flap seam
    g.fillStyle = 'rgba(255,248,230,0.28)'; g.fillRect(0, 84, 272, 32); // clear tape over the seam
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, 86, 272, 3);
    g.fillStyle = '#fbfbf8'; g.fillRect(150, 128, 108, 62);          // shipping label
    g.fillStyle = sku === 'A' ? '#0071e3' : '#ff8a00'; g.fillRect(150, 128, 108, 18);
    g.fillStyle = '#fff'; g.font = `700 14px ${FONT}`; g.fillText(`SKU-${sku}`, 158, 142);
    g.fillStyle = '#1d1d1f';
    for (let i = 0, x = 158; x < 248; i++) {
      const w = [2, 1, 3, 1, 2, 2, 1, 3][i % 8];
      g.fillRect(x, 152, w, 30);
      x += w + [1, 2, 1, 2][i % 4];
    }
    if (damaged) {
      g.strokeStyle = 'rgba(60,35,10,0.6)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(272, 40); g.lineTo(208, 0); g.moveTo(272, 70); g.lineTo(180, 4); g.stroke();
      g.fillStyle = 'rgba(70,40,10,0.28)';
      g.beginPath(); g.ellipse(248, 22, 34, 20, 0.5, 0, Math.PI * 2); g.fill();
    }
  });
}

function woodTexture(seed: number) {
  return canvas(256, 64, (g) => {
    g.fillStyle = '#d8b88a'; g.fillRect(0, 0, 256, 64);
    const r = rng(seed);
    for (let i = 0; i < 26; i++) {                               // grain
      g.strokeStyle = `rgba(${130 + r() * 40},${90 + r() * 30},${50 + r() * 20},${0.12 + r() * 0.18})`;
      g.lineWidth = 0.6 + r() * 1.4;
      const y = r() * 64;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= 256; x += 32) g.lineTo(x, y + Math.sin(x * 0.03 + i) * (1 + r() * 3));
      g.stroke();
    }
    g.fillStyle = 'rgba(90,60,30,0.35)';
    for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(r() * 256, r() * 64, 4 + r() * 4, 2 + r() * 2, 0, 0, Math.PI * 2); g.fill(); }
    for (const x of [6, 250]) for (const y of [16, 48]) { g.fillStyle = 'rgba(60,60,60,0.6)'; g.fillRect(x, y, 3, 3); } // nail heads
  }, true);
}

function beltTexture() {
  return canvas(128, 64, (g) => {
    g.fillStyle = '#26292e'; g.fillRect(0, 0, 128, 64);
    speckle(g, 128, 64, 900, 9, ['rgba(255,255,255,0.05)', 'rgba(0,0,0,0.25)'], [0.5, 1.2]);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = 0; x < 128; x += 16) g.fillRect(x, 0, 1, 64);    // fabric weave
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(126, 0, 2, 64); // splice line
  }, true);
}

function wallTexture() {
  // corrugated cladding: 256 px = 2 m wide, ribs every 0.2 m; lower 1.2 m painted darker
  return canvas(256, 512, (g) => {
    g.fillStyle = '#eceef1'; g.fillRect(0, 0, 256, 512);
    for (let x = 0; x < 256; x += 26) {
      const grad = g.createLinearGradient(x, 0, x + 26, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0.06)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.4)'); grad.addColorStop(1, 'rgba(0,0,0,0.08)');
      g.fillStyle = grad; g.fillRect(x, 0, 26, 512);
    }
    g.fillStyle = '#8c949e'; g.fillRect(0, 512 - 123, 256, 123);
    g.fillStyle = '#f2c300'; g.fillRect(0, 512 - 128, 256, 6);
  }, true);
}

function meshPanel() {
  return canvas(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(40,43,48,0.75)'; g.lineWidth = 1.5;
    for (let i = 0; i <= 128; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
    }
  }, true);
}

function stackTexture(seed: number) {
  // a shrink-wrapped pallet load seen from the side: rows of cartons
  return canvas(256, 192, (g) => {
    g.fillStyle = '#c19763'; g.fillRect(0, 0, 256, 192);
    const r = rng(seed);
    for (let y = 0; y < 192; y += 48) for (let x = 0; x < 256; x += 64) {
      g.fillStyle = `rgba(${150 + r() * 40},${105 + r() * 25},${60 + r() * 20},0.5)`;
      g.fillRect(x + 1, y + 1, 62, 46);
      g.fillStyle = 'rgba(80,55,25,0.45)'; g.fillRect(x, y, 64, 1.5); g.fillRect(x, y, 1.5, 48);
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x + 36, y + 28, 20, 12);
    }
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, 0, 256, 192);    // stretch wrap sheen
  });
}

function sign(text: string, bg: string, fg = '#fff') {
  return canvas(256, 72, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 256, 72);
    g.fillStyle = fg; g.font = `700 34px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 38);
  });
}

// -------------------------------------------------------------------------------------- materials
function std(color: string | Texture, metalness = 0, roughness = 0.7) {
  return typeof color === 'string'
    ? new MeshStandardMaterial({ color, metalness, roughness })
    : new MeshStandardMaterial({ map: color, metalness, roughness });
}

let shared: ReturnType<typeof makeShared> | null = null;
function makeShared() {
  return {
    alu: std('#c3c9d1', 0.75, 0.32),
    steel: std('#9aa2ac', 0.6, 0.4),
    darkSteel: std('#4d545d', 0.35, 0.55),
    plate: std('#2f343b', 0.5, 0.5),
    yellow: std('#f2c300', 0.1, 0.5),
    black: std('#1b1d21', 0.2, 0.55),
    rubber: std('#25272b', 0, 0.85),
  };
}
const mats = () => (shared ??= makeShared());

// ------------------------------------------------------------------------------------------- helpers
function mesh(geo: BufferGeometry, mat: Material | Material[], p: readonly number[] = ZERO, cast = true, receive = false) {
  const m = new Mesh(geo, mat);
  m.position.set(p[0], p[1], p[2]);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
const bx = (w: number, h: number, d: number, mat: Material | Material[], p: readonly number[], cast = true, receive = false) =>
  mesh(new BoxGeometry(w, h, d), mat, p, cast, receive);
const cyl = (r: number, h: number, mat: Material, p: readonly number[], seg = 16, cast = true) =>
  mesh(new CylinderGeometry(r, r, h, seg), mat, p, cast);

// ------------------------------------------------------------------------------------------- boxes
export type Sku = 'A' | 'B';
export interface BoxKind { sku: Sku; damaged?: boolean }

let boxMats: Record<string, Material[]> | null = null;
let boxGeo: BufferGeometry | null = null;
let dentGeo: BufferGeometry | null = null;

function boxMaterials() {
  if (boxMats) return boxMats;
  const end = std(cardboardSide(false), 0, 0.88);
  const side = std(cardboardSide(true), 0, 0.88);
  const bottom = std('#b88e58', 0, 0.9);
  const top = (sku: Sku, d = false) => std(cardboardTop(sku, d), 0, 0.82);
  const dark = std('#ad824c', 0, 0.9);
  // face order: +x, -x, +y, -y, +z, -z
  boxMats = {
    A: [end, end, top('A'), bottom, side, side],
    B: [end, end, top('B'), bottom, side, side],
    D: [dark, dark, top('A', true), bottom, side, dark],
  };
  return boxMats;
}

function boxGeometry(damaged: boolean) {
  if (!boxGeo) {
    boxGeo = new RoundedBoxGeometry(BOX.L, BOX.H, BOX.W, 2, 0.005);
    boxGeo.translate(0, -BOX.H / 2, 0);                     // origin at the top centre, where the cup grips
    dentGeo = boxGeo.clone();
    const pos = dentGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {                   // crush the +x,+z top corner by up to 18 mm
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const fx = Math.max(0, (x - (BOX.L / 2 - 0.06)) / 0.06), fz = Math.max(0, (z - (BOX.W / 2 - 0.05)) / 0.05);
      const fy = Math.max(0, 1 + y / 0.05);
      pos.setY(i, y - 0.018 * Math.min(1, fx * fz * 1.4) * fy);
    }
    dentGeo.computeVertexNormals();
  }
  return damaged ? dentGeo! : boxGeo;
}

export function makeBox(kind: BoxKind) {
  const m = boxMaterials();
  const g = new Group();
  const b = new Mesh(boxGeometry(!!kind.damaged), kind.damaged ? m.D : m[kind.sku]);
  b.castShadow = true;
  b.receiveShadow = true;
  g.add(b);
  return g;
}

// ------------------------------------------------------------------------------------------- operator
export interface Person {
  root: Group;
  hands: Object3D;                                           // where a carried box sits
  pose(phase: number, walk: number, carry: number, reach: number): void;
}

function limb(r: number, len: number, mat: Material) {
  const g = new Group();
  g.add(mesh(new CapsuleGeometry(r, len - 2 * r, 4, 12), mat, [0, -len / 2, 0]));
  return g;
}

function makePerson(): Person {
  const vest = std('#ff7417', 0, 0.55);
  const shirt = std('#2a3446', 0, 0.85);
  const pants = std('#3a3f47', 0, 0.9);
  const skin = std('#c9a58a', 0, 0.6);
  const hat = std('#ffd400', 0.05, 0.3);
  const reflective = std('#dfe4ea', 0.6, 0.25);
  const boot = std('#17181b', 0.1, 0.6);
  const glove = std('#5d646e', 0, 0.8);
  const lens = std('#1d2026', 0.4, 0.15);

  const root = new Group();
  const pelvis = new Group(); pelvis.position.y = 0.97; root.add(pelvis);
  const hipMesh = mesh(new CapsuleGeometry(0.13, 0.1, 4, 12), pants, [0, 0.02, 0]);
  hipMesh.rotation.z = Math.PI / 2; hipMesh.scale.set(1, 1, 0.8);
  pelvis.add(hipMesh);

  // legs: thigh -> knee -> shin -> boot
  const thighs: Group[] = [], knees: Group[] = [];
  for (const s of [-1, 1]) {
    const thigh = limb(0.072, 0.45, pants); thigh.position.set(s * 0.095, 0, 0);
    const knee = limb(0.058, 0.44, pants); knee.position.y = -0.45;
    const b = bx(0.11, 0.08, 0.26, boot, [0, -0.47, 0.04]);
    knee.add(b);
    thigh.add(knee);
    pelvis.add(thigh);
    thighs.push(thigh); knees.push(knee);
  }

  // torso: tapered chest in a vest with reflective bands, neck, head, hard hat, glasses
  const chest = new Group(); chest.position.y = 0.1; pelvis.add(chest);
  const torso = mesh(new CapsuleGeometry(0.17, 0.3, 6, 16), vest, [0, 0.27, 0]);
  torso.scale.set(1, 1, 0.66);
  chest.add(torso);
  for (const y of [0.16, 0.3]) {
    const band = mesh(new CylinderGeometry(0.173, 0.173, 0.03, 24, 1, true), reflective, [0, y, 0], false);
    band.scale.set(1, 1, 0.67);
    chest.add(band);
  }
  chest.add(cyl(0.045, 0.08, skin, [0, 0.6, 0]));
  const head = mesh(new SphereGeometry(0.1, 20, 16), skin, [0, 0.71, 0.005]);
  head.scale.set(0.92, 1.1, 1);
  chest.add(head);
  chest.add(mesh(new BoxGeometry(0.15, 0.03, 0.03), lens, [0, 0.725, 0.085], false));
  chest.add(mesh(new SphereGeometry(0.118, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), hat, [0, 0.75, 0]));
  chest.add(mesh(new CylinderGeometry(0.13, 0.135, 0.012, 24), hat, [0, 0.75, 0.012]));

  // arms: shoulder -> upper arm -> elbow -> forearm -> glove
  const uppers: Group[] = [], elbows: Group[] = [];
  for (const s of [-1, 1]) {
    const upper = limb(0.055, 0.3, shirt); upper.position.set(s * 0.215, 0.47, 0);
    const shoulder = mesh(new SphereGeometry(0.075, 14, 10), vest, [0, -0.02, 0]);
    upper.add(shoulder);
    const fore = limb(0.047, 0.27, shirt); fore.position.y = -0.3;
    fore.add(mesh(new SphereGeometry(0.05, 12, 10), glove, [0, -0.29, 0]));
    upper.add(fore);
    chest.add(upper);
    uppers.push(upper); elbows.push(fore);
  }
  const hands = new Object3D(); chest.add(hands);

  return {
    root, hands,
    pose(phase, walk, carry, reach) {
      const sw = Math.sin(phase);
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;                          // which side of the body (x sign)
        const leg = side * sw;
        thighs[i].rotation.x = -leg * 0.42 * walk;
        // the knee bends most as the leg swings through
        knees[i].rotation.x = Math.max(0, Math.cos(phase + (i ? Math.PI : 0))) * 0.75 * walk + 0.04;
        const armSwing = -side * sw * 0.35 * walk * (1 - carry);
        // carry: upper arms down-forward, forearms level; reach: arms out over the pallet
        uppers[i].rotation.x = armSwing - 0.45 * carry - 0.75 * reach;
        uppers[i].rotation.z = side * (0.06 * (1 - carry) - 0.3 * carry);   // arms in around the box when carrying
        elbows[i].rotation.x = -0.25 - 0.9 * carry + 0.75 * reach;
      }
      pelvis.position.y = 0.97 + Math.abs(Math.cos(phase)) * 0.02 * walk - 0.015 * reach;
      chest.rotation.x = 0.04 * walk + 0.18 * reach;
      hands.position.set(0, 0.2 + 0.08 * reach, 0.36 + 0.12 * reach);
    },
  };
}

// ------------------------------------------------------------------------------------------- the hall
interface Ambient { update(dt: number): void }

function hall(scene: Scene): Ambient {
  scene.background = new Color(HALL);
  scene.fog = new Fog(HALL, 4.2, 10.5);
  const m = mats();

  const floorTex = concrete();
  floorTex.repeat.set(16 / 3, 12 / 3);
  const floor = mesh(new PlaneGeometry(16, 12), std(floorTex, 0, 0.62), [0.4, FLOOR_Y, -0.5], false, true);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  // painted aisle in front of the cell
  const paint = new MeshStandardMaterial({ color: '#f2c300', roughness: 0.55 });
  for (const z of [1.55, 2.75]) {
    const line = mesh(new PlaneGeometry(14, 0.08), paint, [0.4, FLOOR_Y + 0.002, z], false, true);
    line.rotation.x = -Math.PI / 2;
    scene.add(line);
  }
  const walk = new MeshStandardMaterial({ color: '#7c8ea3', roughness: 0.7, transparent: true, opacity: 0.25 });
  const lane = mesh(new PlaneGeometry(14, 1.12), walk, [0.4, FLOOR_Y + 0.001, 2.15], false, true);
  lane.rotation.x = -Math.PI / 2;
  scene.add(lane);

  // back and left walls with steel columns
  const wallTex = wallTexture();
  wallTex.repeat.set(14 / 2, 1);
  const back = mesh(new PlaneGeometry(14, 5), std(wallTex, 0.1, 0.8), [0.4, FLOOR_Y + 2.5, -3.1], false, true);
  scene.add(back);
  const leftTex = wallTexture(); leftTex.repeat.set(8 / 2, 1);
  const left = mesh(new PlaneGeometry(8, 5), std(leftTex, 0.1, 0.8), [-3.6, FLOOR_Y + 2.5, 0.9], false, true);
  left.rotation.y = Math.PI / 2;
  scene.add(left);
  const column = (x: number, z: number) => {
    const g = new Group();
    const blue = std('#3d5a80', 0.4, 0.5);
    g.add(bx(0.24, 5, 0.02, blue, [0, 2.5, 0.11]), bx(0.24, 5, 0.02, blue, [0, 2.5, -0.11]), bx(0.02, 5, 0.22, blue, [0, 2.5, 0]));
    g.add(bx(0.3, 0.9, 0.3, m.yellow, [0, 0.45, 0]));
    g.position.set(x, FLOOR_Y, z);
    scene.add(g);
  };
  for (const x of [-3.35, 3.05]) column(x, -2.95);
  // high windows: a pale band of daylight
  const glass = new MeshBasicMaterial({ color: '#f7fbff', fog: true });
  scene.add(mesh(new PlaneGeometry(14, 0.6), glass, [0.4, FLOOR_Y + 3.9, -3.09], false));

  // pallet racking along the back wall, loaded
  const upright = std('#2f5d9e', 0.4, 0.45);
  const beam = std('#d9822b', 0.3, 0.5);
  const load = [stackTexture(21), stackTexture(22), stackTexture(23)].map((t) => std(t, 0, 0.8));
  const deck = std(woodTexture(4), 0, 0.85);
  for (let bay = 0; bay < 4; bay++) {
    const x0 = -3.0 + bay * 1.45;
    for (const x of [x0, x0 + 1.4]) for (const z of [-2.85, -2.05]) scene.add(bx(0.06, 2.6, 0.06, upright, [x, FLOOR_Y + 1.3, z], false));
    for (const y of [0.0, 1.25]) {
      for (const z of [-2.85, -2.05]) scene.add(bx(1.4, 0.1, 0.05, beam, [x0 + 0.7, FLOOR_Y + y + 0.05, z], false));
      for (const k of [0, 1]) {
        if ((bay + k + (y ? 1 : 0)) % 4 === 3) continue;            // a few empty positions
        const cx = x0 + 0.37 + k * 0.66;
        scene.add(bx(0.6, 0.12, 0.72, deck, [cx, FLOOR_Y + y + 0.16, -2.45], false));
        const h = 0.7 + ((bay * 3 + k) % 3) * 0.12;
        scene.add(bx(0.56, h, 0.68, load[(bay + k) % 3], [cx, FLOOR_Y + y + 0.22 + h / 2, -2.45], false));
      }
    }
  }

  // the neighbouring line behind the fence keeps running: a roller conveyor with cartons
  const lineZ = -1.55, lineY = FLOOR_Y + 0.7, x0 = -3.58, x1 = 4.6;
  scene.add(bx(x1 - x0, 0.06, 0.04, m.alu, [(x0 + x1) / 2, lineY - 0.03, lineZ - 0.24], false));
  scene.add(bx(x1 - x0, 0.06, 0.04, m.alu, [(x0 + x1) / 2, lineY - 0.03, lineZ + 0.24], false));
  const rollers = new InstancedMesh(new CylinderGeometry(0.022, 0.022, 0.46, 10), m.steel, Math.floor((x1 - x0) / 0.08));
  const mtx = new Matrix4();
  const rx = new Matrix4().makeRotationX(Math.PI / 2);
  for (let i = 0; i < rollers.count; i++) rollers.setMatrixAt(i, mtx.makeTranslation(x0 + 0.04 + i * 0.08, lineY - 0.02, lineZ).multiply(rx));
  scene.add(rollers);
  for (let x = x0 + 0.3; x < x1; x += 1.2) for (const z of [-0.2, 0.2]) scene.add(bx(0.04, lineY - FLOOR_Y - 0.05, 0.04, m.steel, [x, FLOOR_Y + (lineY - FLOOR_Y - 0.05) / 2, lineZ + z], false));
  const cartons = new InstancedMesh(new RoundedBoxGeometry(0.3, 0.22, 0.26, 2, 0.008), boxMaterials().A, 7);
  cartons.castShadow = false;
  scene.add(cartons);
  let offset = 0;
  const span = x1 - x0;
  const place = () => {
    for (let i = 0; i < cartons.count; i++) {
      const x = x0 + ((offset + i * (span / cartons.count)) % span);
      cartons.setMatrixAt(i, mtx.makeTranslation(x, lineY + 0.11, lineZ));
    }
    cartons.instanceMatrix.needsUpdate = true;
  };
  place();

  return { update(dt) { offset = (offset + dt * 0.35) % span; place(); } };
}

/** Perimeter guarding: black mesh panels on yellow posts behind and left of the cell; the right side is open,
 *  guarded by the area scanner on the pedestal. */
function guarding(scene: Scene) {
  const m = mats();
  const tex = meshPanel();
  const h = 1.4;
  const wire = new MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: DoubleSide, roughness: 0.6, metalness: 0.3, color: '#ffffff' });
  const run = (a: Vector3, b: Vector3) => {
    const len = a.distanceTo(b);
    const n = Math.max(1, Math.round(len / 1.0));
    const dir = b.clone().sub(a).divideScalar(n);
    for (let i = 0; i <= n; i++) {
      const p = a.clone().addScaledVector(dir, i);
      scene.add(bx(0.05, h + 0.05, 0.05, m.yellow, [p.x, FLOOR_Y + (h + 0.05) / 2, p.z], false));
      scene.add(bx(0.12, 0.012, 0.12, m.yellow, [p.x, FLOOR_Y + 0.006, p.z], false, true));
      if (i === n) continue;
      const c = p.clone().addScaledVector(dir, 0.5);
      const plen = dir.length() - 0.06;
      const t = tex.clone(); t.repeat.set(plen / 0.4, (h - 0.25) / 0.4); t.needsUpdate = true;   // 50 mm mesh
      const panelMat = wire.clone(); panelMat.map = t;
      const panel = mesh(new PlaneGeometry(plen, h - 0.25), panelMat, [c.x, FLOOR_Y + 0.15 + (h - 0.25) / 2, c.z], false);
      panel.rotation.y = -Math.atan2(dir.z, dir.x);
      scene.add(panel);
      const frame = std('#1d2025', 0.4, 0.5);
      for (const y of [0.15, h - 0.1]) {
        const rail = bx(plen, 0.025, 0.025, frame, [c.x, FLOOR_Y + y, c.z], false);
        rail.rotation.y = panel.rotation.y;
        scene.add(rail);
      }
    }
  };
  run(new Vector3(-1.75, 0, -1.05), new Vector3(1.25, 0, -1.05));
  run(new Vector3(-1.75, 0, -1.05), new Vector3(-1.75, 0, 0.15));
}

// ------------------------------------------------------------------------------------------- the cell
export interface Cell {
  scene: Scene;
  joints: Object3D[];
  tcp: Object3D;
  scan: { root: Group; mats: Material[] };
  puff: { root: Group; mat: MeshBasicMaterial };
  beltTex: Texture;
  eyeBeam: MeshBasicMaterial;
  beacon: MeshStandardMaterial;
  stack: MeshStandardMaterial[];                             // red, amber, green
  zones: { warn: MeshBasicMaterial; stop: MeshBasicMaterial; warnFill: MeshBasicMaterial; stopFill: MeshBasicMaterial };
  pallet: Group;
  lift: Group;
  person: Person;
  ambient(dt: number): void;
  setJoints(q: ArrayLike<number>): void;
}

export async function buildCell(modelUrl: string): Promise<Cell> {
  const scene = new Scene();
  const m = mats();
  const bg = hall(scene);
  guarding(scene);

  // scanner fields, painted on the floor
  const ring = (r: number, color: string, width: number) => {
    const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
    const line = new Mesh(new RingGeometry(r - width, r, 128), mat);
    line.rotation.x = -Math.PI / 2; line.position.y = FLOOR_Y + 0.003;
    scene.add(line);
    const fillMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
    const fill = new Mesh(new RingGeometry(r === ZONES.warn ? ZONES.stop : 0.12, r - width, 128), fillMat);
    fill.rotation.x = -Math.PI / 2; fill.position.y = FLOOR_Y + 0.002;
    scene.add(fill);
    return [mat, fillMat] as const;
  };
  const [warn, warnFill] = ring(ZONES.warn, '#f2b600', 0.05);
  const [stop, stopFill] = ring(ZONES.stop, '#ff3b30', 0.05);

  // pedestal with base plate, anchor bolts, area scanner and the robot's control box
  const coat = std('#3c434c', 0.25, 0.6);
  scene.add(bx(0.2, -FLOOR_Y - 0.03, 0.2, coat, [0, (FLOOR_Y - 0.03) / 2, 0], true, true));
  scene.add(bx(0.27, 0.025, 0.27, m.plate, [0, -0.0125, 0], true, true));
  scene.add(bx(0.42, 0.025, 0.42, m.plate, [0, FLOOR_Y + 0.0125, 0], false, true));
  for (const dx of [-0.17, 0.17]) for (const dz of [-0.17, 0.17]) scene.add(cyl(0.012, 0.03, m.steel, [dx, FLOOR_Y + 0.03, dz], 8, false));
  scene.add(mesh(new CylinderGeometry(0.055, 0.06, 0.09, 24), m.yellow, [0.13, FLOOR_Y + 0.2, 0.13]));
  scene.add(cyl(0.045, 0.03, m.black, [0.13, FLOOR_Y + 0.26, 0.13], 24));
  const cab = new Group();
  cab.add(bx(0.48, 0.45, 0.24, std('#e9ecef', 0.2, 0.5), [0, 0.225, 0], true, true));
  cab.add(bx(0.46, 0.012, 0.012, m.darkSteel, [0, 0.43, 0.121], false));
  cab.add(bx(0.08, 0.08, 0.02, std('#d70015', 0.1, 0.4), [0.16, 0.36, 0.125]));             // e-stop
  cab.add(bx(0.32, 0.2, 0.02, std('#1f2328', 0.3, 0.3), [0, 0.24, 0.123]));                  // teach pendant holder
  cab.position.set(-1.25, FLOOR_Y + 0.1, -0.75);
  for (const dx of [-0.2, 0.2]) cab.add(cyl(0.02, 0.1, m.black, [dx, -0.05, 0], 8, false));
  scene.add(cab);

  // infeed conveyor: aluminium profile frame, rubber belt, end drums, drive motor, guides, adjustable feet
  const len = BELT.x1 - BELT.x0;
  const cx = (BELT.x0 + BELT.x1) / 2;
  const beltTex = beltTexture();
  beltTex.repeat.set(len / 0.12, 1);
  const rub = std('#25272b', 0, 0.8);
  scene.add(bx(len, 0.02, BELT.width, [rub, rub, std(beltTex, 0, 0.75), rub, rub, rub], [cx, BELT.top - 0.01, BELT.z], false, true));
  for (const s of [-1, 1]) {
    const z = BELT.z + s * (BELT.width / 2 + 0.014);
    scene.add(bx(len + 0.06, 0.08, 0.028, m.alu, [cx, BELT.top - 0.025, z], true, true));
    scene.add(bx(len + 0.06, 0.006, 0.03, m.darkSteel, [cx, BELT.top - 0.045, z], false));
    // side guide on brackets
    scene.add(bx(len - 0.3, 0.025, 0.008, std('#e8eaed', 0.1, 0.4), [cx - 0.1, BELT.top + 0.045, BELT.z + s * (BELT.width / 2 - 0.004)], false));
    for (let x = BELT.x0 + 0.3; x < BELT.x1 - 0.1; x += 0.35) scene.add(bx(0.012, 0.06, 0.03, m.steel, [x, BELT.top + 0.02, BELT.z + s * (BELT.width / 2 + 0.02)], false));
    for (const x of [BELT.x0 + 0.08, cx, BELT.x1 - 0.06]) {
      const legH = BELT.top - 0.065 - FLOOR_Y - 0.04;
      scene.add(bx(0.04, legH, 0.04, m.alu, [x, FLOOR_Y + 0.04 + legH / 2, BELT.z + s * 0.13]));
      scene.add(cyl(0.025, 0.012, m.black, [x, FLOOR_Y + 0.006, BELT.z + s * 0.13], 12, false));
      scene.add(cyl(0.006, 0.03, m.steel, [x, FLOOR_Y + 0.027, BELT.z + s * 0.13], 6, false));
    }
  }
  for (const x of [BELT.x0 + 0.08, cx, BELT.x1 - 0.06]) scene.add(bx(0.03, 0.03, 0.26, m.alu, [x, FLOOR_Y + 0.25, BELT.z], false));
  for (const x of [BELT.x0, BELT.x1]) {
    const drum = cyl(0.03, BELT.width, m.steel, [x, BELT.top - 0.03, BELT.z], 20);
    drum.rotation.x = Math.PI / 2;
    scene.add(drum);
  }
  const motor = cyl(0.045, 0.16, std('#2f4f7f', 0.4, 0.45), [BELT.x1 - 0.05, BELT.top - 0.07, BELT.z - BELT.width / 2 - 0.12], 20);
  motor.rotation.x = Math.PI / 2;
  scene.add(motor);
  scene.add(bx(0.09, 0.09, 0.06, m.darkSteel, [BELT.x1 - 0.05, BELT.top - 0.07, BELT.z - BELT.width / 2 - 0.03]));
  scene.add(bx(0.022, 0.045, BELT.width - 0.02, m.yellow, [BELT.stopX + 0.011, BELT.top + 0.022, BELT.z]));      // hard stop
  // infeed tunnel (label scanner) the boxes come out of
  const hood = std('#e3e6ea', 0.3, 0.45);
  const hx = BELT.x0 + 0.14;
  scene.add(bx(0.3, 0.012, BELT.width + 0.08, hood, [hx, BELT.top + 0.24, BELT.z]));
  for (const s of [-1, 1]) scene.add(bx(0.3, 0.26, 0.012, hood, [hx, BELT.top + 0.11, BELT.z + s * (BELT.width / 2 + 0.04)]));
  scene.add(bx(0.012, 0.26, BELT.width + 0.08, hood, [BELT.x0 - 0.01, BELT.top + 0.11, BELT.z]));
  scene.add(bx(0.1, 0.012, 0.012, std('#30d158', 0, 0.3), [hx, BELT.top + 0.247, BELT.z + BELT.width / 2 + 0.035], false));
  const strip = new MeshStandardMaterial({ color: '#5b6068', transparent: true, opacity: 0.55, side: DoubleSide, roughness: 0.3 });
  for (let i = 0; i < 6; i++) {                                 // PVC strip curtain
    const s = mesh(new PlaneGeometry(0.048, 0.2), strip, [hx + 0.15, BELT.top + 0.13, BELT.z - BELT.width / 2 + 0.03 + i * 0.05], false);
    s.rotation.y = Math.PI / 2;
    scene.add(s);
  }
  // photo-eye at the pick window
  const eyeX = BELT.stopX - BOX.L / 2;
  for (const s of [-1, 1]) scene.add(bx(0.025, 0.06, 0.03, m.black, [eyeX, BELT.top + 0.06, BELT.z + s * (BELT.width / 2 + 0.035)]));
  const eyeBeam = new MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.6 });
  const beam = new Mesh(new CylinderGeometry(0.0015, 0.0015, BELT.width + 0.07, 6), eyeBeam);
  beam.rotation.x = Math.PI / 2; beam.position.set(eyeX, BELT.top + 0.065, BELT.z);
  scene.add(beam);
  // conveyor beacon (amber when the line stops)
  const beacon = new MeshStandardMaterial({ color: '#c9a64a', emissive: '#000000', roughness: 0.3, transparent: true, opacity: 0.9 });
  scene.add(cyl(0.004, 0.16, m.steel, [BELT.x0 + 0.35, BELT.top + 0.08, BELT.z - 0.19], 6));
  scene.add(cyl(0.022, 0.05, beacon as unknown as Material, [BELT.x0 + 0.35, BELT.top + 0.18, BELT.z - 0.19]));

  // pallet station: scissor lift table + pallet
  const lift = new Group();
  scene.add(lift);
  const liftTopY = PALLET.top - 0.085;
  const liftBlue = std('#2f5d9e', 0.35, 0.5);
  scene.add(bx(0.64, 0.05, 0.4, liftBlue, [PALLET.x + 0.025, FLOOR_Y + 0.025, PALLET.z], true, true));
  const scissorH = liftTopY - 0.06 - FLOOR_Y - 0.05;
  for (const s of [-1, 1]) for (const a of [-1, 1]) {
    const arm = bx(0.04, Math.hypot(0.5, scissorH), 0.02, m.darkSteel, [PALLET.x + 0.025, FLOOR_Y + 0.05 + scissorH / 2, PALLET.z + s * 0.16]);
    arm.rotation.z = a * Math.atan2(0.5, scissorH);
    scene.add(arm);
  }
  scene.add(bx(0.62, 0.05, 0.38, liftBlue, [PALLET.x + 0.025, liftTopY - 0.055, PALLET.z], true, true));
  lift.add(bx(0.6, 0.03, 0.38, m.steel, [PALLET.x + 0.025, liftTopY - 0.015, PALLET.z], true, true));
  const pallet = makePallet();
  pallet.position.set(PALLET.x, PALLET.top, PALLET.z);
  scene.add(pallet);

  // reject bin + SKU-B tote on stands, with signs
  tote(scene, REJECT, '#d93a3f', sign('REJECT', '#d93a3f'), m.darkSteel);
  tote(scene, TOTE_B, '#f59a0a', sign('SKU-B', '#f59a0a', '#1d1d1f'), m.darkSteel);

  // stack light on the control box
  const stack: MeshStandardMaterial[] = [];
  const sx = -1.42, sz = -0.75, top = FLOOR_Y + 0.55;
  scene.add(cyl(0.012, 0.18, m.steel, [sx, top + 0.09, sz], 10));
  ['#ff3b30', '#ffb000', '#30d158'].forEach((c, i) => {
    const mat = new MeshStandardMaterial({ color: new Color(c).multiplyScalar(0.35), emissive: c, emissiveIntensity: 0, roughness: 0.25, transparent: true, opacity: 0.92 });
    stack.push(mat);
    scene.add(cyl(0.033, 0.07, mat as unknown as Material, [sx, top + 0.22 + (2 - i) * 0.075, sz], 20));
  });
  scene.add(cyl(0.034, 0.02, m.plate, [sx, top + 0.42, sz], 20));

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
  const tool = makeTool();
  tool.root.position.y = FLANGE_Y;
  joints[5].add(tool.root);
  const tcp = new Object3D();
  tcp.position.y = FLANGE_Y + TOOL_LEN;
  joints[5].add(tcp);
  // the robot cable, from the base down the pedestal and across the floor to the control box
  const route = new CatmullRomCurve3([
    new Vector3(-0.06, -0.06, -0.1), new Vector3(-0.11, -0.4, -0.11), new Vector3(-0.12, FLOOR_Y + 0.06, -0.14),
    new Vector3(-0.35, FLOOR_Y + 0.01, -0.35), new Vector3(-0.9, FLOOR_Y + 0.01, -0.62), new Vector3(-1.08, FLOOR_Y + 0.15, -0.72),
  ]);
  scene.add(mesh(new TubeGeometry(route, 48, 0.009, 6), m.black, ZERO, false));

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
    ambient: (dt) => bg.update(dt),
  };
}

function makePallet() {
  const plank = std(woodTexture(1), 0, 0.82);
  const plank2 = std(woodTexture(2), 0, 0.85);
  const block = std('#c9a675', 0, 0.9);
  const p = new Group();
  const w = 0.52, d = 0.34;
  for (let i = 0; i < 5; i++) p.add(bx(w, 0.014, 0.058, i % 2 ? plank2 : plank, [0, -0.007, -d / 2 + 0.029 + i * ((d - 0.058) / 4)], true, true));
  for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) p.add(bx(w, 0.014, 0.06, plank2, [0, -0.021, z], true, true));
  for (const x of [-w / 2 + 0.035, 0, w / 2 - 0.035]) for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) p.add(bx(0.06, 0.04, 0.06, block, [x, -0.048, z], true, true));
  for (let i = 0; i < 3; i++) p.add(bx(w, 0.012, 0.07, plank, [0, -0.074, -d / 2 + 0.035 + i * ((d - 0.07) / 2)], true, true));
  return p;
}

function tote(scene: Scene, at: { x: number; z: number; floor: number }, color: string, label: Texture, stand: Material) {
  const wall = std(color, 0, 0.5);
  const inner = std(new Color(color).multiplyScalar(0.72).getStyle(), 0, 0.7);
  const w = 0.3, d = 0.24, h = 0.16, t = 0.012;
  const y = at.floor;
  const g = new Group();
  g.add(bx(w, t, d, inner, [0, t / 2, 0], false, true));
  g.add(bx(w, h, t, wall, [0, h / 2, d / 2 - t / 2]), bx(w, h, t, wall, [0, h / 2, -d / 2 + t / 2]));
  g.add(bx(t, h, d, wall, [w / 2 - t / 2, h / 2, 0]), bx(t, h, d, wall, [-w / 2 + t / 2, h / 2, 0]));
  g.add(bx(w + 0.016, 0.014, d + 0.016, wall, [0, h - 0.007, 0], false));                   // rolled rim
  g.position.set(at.x, y, at.z);
  scene.add(g);
  for (const dx of [-0.11, 0.11]) for (const dz of [-0.08, 0.08]) {
    scene.add(bx(0.03, y - FLOOR_Y, 0.03, stand, [at.x + dx, (y + FLOOR_Y) / 2, at.z + dz]));
  }
  scene.add(bx(0.27, 0.02, 0.21, stand, [at.x, y - 0.01, at.z], true, true));
  const s = new Mesh(new PlaneGeometry(0.2, 0.056), new MeshStandardMaterial({ map: label, roughness: 0.5 }));
  s.position.set(at.x, y + h * 0.5, at.z + d / 2 + 0.003);
  scene.add(s);
}

function makeTool() {
  const m = mats();
  const root = new Group();
  const part = (r0: number, r1: number, h: number, mat: Material, y: number) => root.add(mesh(new CylinderGeometry(r1, r0, h, 24), mat, [0, y + h / 2, 0]));
  part(0.032, 0.032, 0.012, m.black, 0);                    // flange adapter
  part(0.024, 0.024, 0.09, m.alu, 0.012);                   // vacuum tube
  part(0.017, 0.017, 0.012, m.black, 0.102);
  part(0.016, 0.03, 0.031, m.rubber, 0.114);                // bellows cup to the lip at TOOL_LEN
  root.add(bx(0.03, 0.05, 0.03, m.alu, [0.035, 0.045, 0])); // ejector block
  const hose = mesh(new TorusGeometry(0.05, 0.005, 6, 16, Math.PI), std('#3a7bd5', 0, 0.5), [0.07, 0.02, 0], false);
  hose.rotation.z = Math.PI / 2;
  root.add(hose);
  // wrist camera (D435i-sized bar) on a bracket, looking along the tool axis
  const cam = new Group();
  cam.position.set(0, 0.03, -0.06);
  cam.add(bx(0.09, 0.025, 0.025, std('#2b2e33', 0.3, 0.4), ZERO));
  for (const x of [-0.03, 0, 0.03]) cam.add(cyl(0.004, 0.002, std('#0b0c0e', 0.2, 0.1), [x, 0.0125, 0], 10, false));
  root.add(cam);
  root.add(bx(0.02, 0.012, 0.05, m.alu, [0, 0.012, -0.035]));
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
