// The render side of "looks like Isaac Sim": image-based lighting from an HDR factory hall, surface detail from
// normal maps, physical materials on the UR5e, and warehouse dressing. Everything is generated in code; nothing
// is downloaded.
import {
  BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, NoColorSpace, Object3D, PlaneGeometry, RepeatWrapping, Scene, BackSide, type Material,
  type Texture,
} from 'three';

/**
 * Tangent-space normal map from a texture's own image, using its luminance as height (dark = low): grooves,
 * flutes, grain and ribs drawn into the colour map become relief. Wraps at the edges; keeps the source's repeat.
 */
export function normalFrom(src: Texture, strength = 2): CanvasTexture {
  const img = src.image as HTMLCanvasElement;
  const w = img.width, h = img.height;
  const data = img.getContext('2d')!.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  const H = (x: number, y: number) => lum[((y + h) % h) * w + ((x + w) % w)];
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const g = out.getContext('2d')!;
  const o = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * w + x) * 4;
      o.data[k] = (-dx / len * 0.5 + 0.5) * 255;
      o.data[k + 1] = (dy / len * 0.5 + 0.5) * 255;
      o.data[k + 2] = (1 / len * 0.5 + 0.5) * 255;
      o.data[k + 3] = 255;
    }
  }
  g.putImageData(o, 0, 0);
  const t = new CanvasTexture(out);
  t.colorSpace = NoColorSpace;
  t.wrapS = src.wrapS; t.wrapT = src.wrapT;
  t.repeat.copy(src.repeat);
  t.anisotropy = 8;
  return t;
}

/** A greyscale canvas texture for roughness or clearcoat variation (linear, not sRGB). */
export function greyMap(size: number, draw: (g: CanvasRenderingContext2D) => void, repeat: [number, number] = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}

/**
 * The hall as an HDR light probe: high bays of linear LED fixtures, a daylight window band, grey cladding and a
 * concrete floor. Fed through PMREM it lights every PBR surface and shows up as the light streaks Isaac Sim's RTX
 * renders put on glossy floors and brushed metal.
 */
export function factoryEnvironment() {
  const env = new Scene();
  const lin = (hex: string, k = 1) => new Color(hex).multiplyScalar(k);
  const basic = (c: Color) => new MeshBasicMaterial({ color: c, side: BackSide, toneMapped: false });
  const room = new Mesh(new BoxGeometry(36, 10, 28), [
    basic(lin('#6d737b', 0.55)), basic(lin('#6d737b', 0.55)),   // +x / -x walls
    basic(lin('#2a2d31', 0.35)), basic(lin('#8f9399', 0.5)),     // ceiling / floor
    basic(lin('#7d838b', 0.6)), basic(lin('#7d838b', 0.6)),      // +z / -z walls
  ]);
  room.position.y = 4.2;
  env.add(room);
  const led = new MeshBasicMaterial({ color: lin('#fff4e6', 14), toneMapped: false });
  for (let x = -12; x <= 12; x += 4) {
    for (let z = -9; z <= 9; z += 3.6) {
      const f = new Mesh(new BoxGeometry(2.4, 0.06, 0.22), led);
      f.position.set(x, 8.6, z);
      env.add(f);
    }
  }
  const sky = new MeshBasicMaterial({ color: lin('#d9e8ff', 5), toneMapped: false });
  const band = new Mesh(new PlaneGeometry(30, 1.6), sky);
  band.position.set(0, 7.2, -13.9);
  env.add(band);
  const band2 = band.clone();
  band2.rotation.y = Math.PI / 2;
  band2.position.set(-17.9, 7.2, 0);
  env.add(band2);
  return env;
}

/**
 * Re-skin the UR5e: painted aluminium links, glossy blue joint caps, dark grey joint housings, black rubber.
 * The GLB carries flat factors only; these are tuned to read like the real arm under factory light.
 */
export function dressRobot(robot: Object3D) {
  const mats: Record<string, Material> = {
    linkgray: new MeshPhysicalMaterial({ color: '#cfd3d8', metalness: 0.35, roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.25 }),
    urblue: new MeshPhysicalMaterial({ color: '#7fb8de', metalness: 0, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
    jointgray: new MeshPhysicalMaterial({ color: '#5a5f67', metalness: 0.2, roughness: 0.48, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
    black: new MeshStandardMaterial({ color: '#141518', metalness: 0, roughness: 0.62 }),
  };
  robot.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const name = (m.material as Material).name;
    if (mats[name]) m.material = mats[name];
  });
}

/** A parked counterbalance forklift: chassis, counterweight, overhead guard, mast, forks, wheels. */
export function makeForklift() {
  const g = new Group();
  const paint = new MeshPhysicalMaterial({ color: '#f0a400', metalness: 0.2, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const dark = new MeshStandardMaterial({ color: '#25282d', metalness: 0.5, roughness: 0.5 });
  const tyre = new MeshStandardMaterial({ color: '#111214', roughness: 0.85 });
  const steel = new MeshStandardMaterial({ color: '#7a8088', metalness: 0.8, roughness: 0.35 });
  const add = (geo: BoxGeometry | CylinderGeometry, mat: Material, x: number, y: number, z: number) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(new BoxGeometry(1.1, 0.55, 1.0), paint, 0, 0.45, 0);              // chassis
  add(new BoxGeometry(0.35, 0.6, 1.0), dark, -0.62, 0.55, 0);           // counterweight
  add(new BoxGeometry(0.5, 0.12, 0.55), dark, -0.1, 0.78, 0);           // seat base
  add(new BoxGeometry(0.12, 0.4, 0.5), dark, -0.3, 0.98, 0);            // seat back
  for (const x of [-0.45, 0.3]) for (const z of [-0.45, 0.45]) add(new BoxGeometry(0.05, 1.35, 0.05), dark, x, 1.38, z);
  add(new BoxGeometry(0.85, 0.05, 1.0), dark, -0.07, 2.05, 0);          // overhead guard
  for (const z of [-0.3, 0.3]) add(new BoxGeometry(0.1, 2.2, 0.1), steel, 0.68, 1.1, z);   // mast
  add(new BoxGeometry(0.1, 0.5, 0.75), steel, 0.75, 0.35, 0);           // carriage
  for (const z of [-0.22, 0.22]) add(new BoxGeometry(1.0, 0.04, 0.1), steel, 1.25, 0.12, z);  // forks
  for (const [x, z] of [[-0.35, -0.5], [-0.35, 0.5], [0.4, -0.5], [0.4, 0.5]]) {
    const w = add(new CylinderGeometry(0.22, 0.22, 0.2, 20), tyre, x, 0.22, z);
    w.rotation.x = Math.PI / 2;
  }
  return g;
}

/** Empty pallets stacked by the station, the way a cell keeps its supply. */
export function palletStack(wood: Material, n = 5) {
  const g = new Group();
  for (let i = 0; i < n; i++) {
    const p = new Group();
    for (let k = 0; k < 5; k++) {
      const b = new Mesh(new BoxGeometry(0.52, 0.014, 0.058), wood);
      b.position.set(0, 0.073, -0.141 + k * 0.0705);
      b.castShadow = b.receiveShadow = true;
      p.add(b);
    }
    for (const z of [-0.14, 0, 0.14]) {
      const s = new Mesh(new BoxGeometry(0.52, 0.06, 0.06), wood);
      s.position.set(0, 0.035, z);
      s.castShadow = s.receiveShadow = true;
      p.add(s);
    }
    p.position.y = i * 0.08;
    p.rotation.y = (i % 2 ? 0.02 : -0.015) * (i + 1);
    g.add(p);
  }
  return g;
}
