// Mounts the digital twin into the #twin section. The physics (MuJoCo) and the cell controller run in a Web Worker
// (physics.worker.ts); this side renders what it reports: the robot's joint angles as MuJoCo integrated them, every
// carton's pose, the pallet, the operator, and the HUD events. Loaded on demand by DigitalTwin.astro.
import {
  ACESFilmicToneMapping, AgXToneMapping, DirectionalLight, Group, HalfFloatType, HemisphereLight, Material, Mesh,
  NeutralToneMapping, PerspectiveCamera, PMREMGenerator, Vector2, Vector3, VSMShadowMap, WebGLRenderTarget,
  WebGLRenderer, type Object3D, type ToneMapping,
} from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { CASES } from './cases.ts';
import { FLOOR_Y, POOL } from './layout.ts';
import { S, type HudEvent, type Stats, type Tone } from './protocol.ts';
import { factoryEnvironment } from './look.ts';
import { buildCell, makeBox, styleBox } from './world.ts';

export interface TwinOptions { modelUrl: string; reduced: boolean }

const fmt = (t: number) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};

function bindHud(root: HTMLElement) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const status = $('.twin__status');
  const statusText = $('.twin__status-text');
  const clock = $('.twin__clock');
  const banner = $('.twin__banner');
  const bannerN = $('.twin__banner-n');
  const bannerTitle = $('.twin__banner-title');
  const bannerDetail = $('.twin__banner-detail');
  const log = $('.twin__log');
  const tool = $('.twin__tool');
  const stats = new Map([...root.querySelectorAll<HTMLElement>('[data-stat]')].map((el) => [el.dataset.stat!, el]));
  // the edge-case list sits after the figure, in the same section
  const cases = [...(root.closest('section') ?? document).querySelectorAll<HTMLElement>('.twin__case')];
  let bannerUntil = -1;
  let active = 0;
  const setActive = (n: number) => {
    active = n;
    for (const li of cases) li.classList.toggle('is-active', Number(li.dataset.case) === n);
  };

  return {
    log(t: number, text: string, tone: Tone) {
      const line = document.createElement('p');
      line.className = 'twin__line';
      line.dataset.tone = tone;
      const time = document.createElement('span');
      time.className = 'twin__time';
      time.textContent = fmt(t);
      const msg = document.createElement('span');
      msg.textContent = text;
      line.append(time, msg);
      log.prepend(line);
      while (log.children.length > 6) log.lastElementChild!.remove();
    },
    edge(t: number, n: number, detail: string) {
      const c = CASES[n - 1];
      bannerN.textContent = `Edge case ${n}/10 · ${c.code}`;
      bannerTitle.textContent = c.title;
      bannerDetail.textContent = detail;
      banner.hidden = false;
      bannerUntil = t + 4.5;
      setActive(n);
      cases[n - 1]?.classList.add('is-done');
    },
    resetEdges() {
      for (const li of cases) li.classList.remove('is-done', 'is-active');
    },
    status(label: string, tone: Tone) {
      statusText.textContent = label;
      status.dataset.tone = tone;
    },
    stats(s: Stats) {
      const set = (k: string, v: string) => { const el = stats.get(k); if (el && el.textContent !== v) el.textContent = v; };
      set('placed', String(s.placed));
      set('rejected', String(s.rejected));
      set('sorted', String(s.sorted));
      set('pallet', `${s.onPallet}/12`);
      set('generation', String(s.generation));
      set('edges', `${s.edges}/10`);
    },
    tool(vac: number, payload: number, speed: number) {
      const v = `Vacuum ${vac} kPa · Payload ${payload.toFixed(1)} kg · Speed ${speed}%`;
      if (tool.textContent !== v) tool.textContent = v;
    },
    clock(t: number) {
      clock.textContent = `T+${fmt(t)}`;
      if (bannerUntil >= 0 && t > bannerUntil) {
        bannerUntil = -1;
        banner.hidden = true;
        if (active) setActive(0);
      }
    },
  };
}

/** Swap objects onto transparent clones of their materials while they fade (shared opacity), and back. */
class Fader {
  private clones = new Map<Material, Material>();
  private fading = new Set<Mesh>();
  set(objs: Object3D[], opacity: number) {
    const want = new Set<Mesh>();
    if (opacity < 0.999) for (const o of objs) o.traverse((m) => { if ((m as Mesh).isMesh) want.add(m as Mesh); });
    for (const m of this.fading) if (!want.has(m)) { m.material = m.userData.orig; this.fading.delete(m); }
    for (const m of want) {
      if (!this.fading.has(m)) {
        m.userData.orig = m.material;
        const swap = (mat: Material) => {
          let c = this.clones.get(mat);
          if (!c) { c = mat.clone(); c.transparent = true; this.clones.set(mat, c); }
          return c;
        };
        m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
        this.fading.add(m);
      }
    }
    for (const c of this.clones.values()) { c.opacity = opacity; c.depthWrite = opacity > 0.98; }
  }
}

export async function mountTwin(root: HTMLElement, opts: TwinOptions) {
  if (root.dataset.mounted) return;
  root.dataset.mounted = '1';
  const view = root.querySelector<HTMLElement>('.twin__view')!;
  const toggle = root.querySelector<HTMLButtonElement>('.twin__toggle')!;
  const small = matchMedia('(max-width: 700px), (pointer: coarse)').matches;

  // physics first: MuJoCo (WebAssembly) loads in the worker while the scene is built here
  const worker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
  let resolveFirst: (s: Float32Array) => void;
  let rejectFirst: (e: Error) => void;
  const first = new Promise<Float32Array>((res, rej) => { resolveFirst = res; rejectFirst = rej; });
  let onFrame: (state: Float32Array, events: HudEvent[]) => void = () => {};
  let pendingEvents: HudEvent[] = [];
  worker.onmessage = (e: MessageEvent) => {
    if (e.data.type === 'error') { rejectFirst(new Error(e.data.message)); return; }
    if (e.data.type === 'frame') {
      pendingEvents = pendingEvents.concat(e.data.events);
      resolveFirst(e.data.state);
      onFrame(e.data.state, e.data.events);
    }
  };
  worker.onerror = (e) => rejectFirst(new Error(e.message || 'physics worker failed'));
  worker.postMessage({ type: 'init', reduced: opts.reduced });

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.toneMapping = ACESFilmicToneMapping;           // the filmic contrast of an RTX viewport
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = VSMShadowMap;                   // soft, area-light-like shadow edges
  const canvas = renderer.domElement;
  canvas.className = 'twin__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label',
    'MuJoCo physics simulation of a palletizing cell in a factory hall: boxes arrive on an infeed conveyor, a UR5e arm with a vacuum cup stacks them on a pallet, with a reject bin, an SKU-B tote, perimeter guarding and floor-marked safety zones.');

  const cell = await buildCell(opts.modelUrl);
  const { scene } = cell;
  // image-based light from an HDR factory hall (high-bay LED rows, a daylight band), as Isaac Sim lights with a dome
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(factoryEnvironment(), 0.02).texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();
  scene.add(new HemisphereLight('#eef3fa', '#8d939b', 0.35));
  // the high bay right over the cell: a soft key light, shadows blurred like a large fixture's
  const sun = new DirectionalLight('#fff3e2', 2.6);
  sun.position.set(0.9, 4.2, 1.6);
  sun.target.position.set(0.1, -0.5, 0.1);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 0.5, far: 9 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 7;
  sun.shadow.blurSamples = 16;
  scene.add(sun, sun.target);

  // the carton pool, posed from the physics state
  const boxes: Group[] = [];
  for (let i = 0; i < POOL; i++) {
    const b = makeBox({ sku: 'A' });
    b.visible = false;
    scene.add(b);
    boxes.push(b);
  }
  const fader = new Fader();
  const hud = bindHud(root);

  // camera: framed on the cell, dragged left/right around it (vertical drags scroll the page)
  const camera = new PerspectiveCamera(30, 1, 0.05, 40);
  const target = new Vector3(0.0, -0.08, 0.12);
  const base = { az: 0.55, el: 0.36 };
  let orbit = 0;
  let zoom = 1;

  // desktop: ambient occlusion where things meet (box on box, box on pallet, feet on the floor)
  let composer: EffectComposer | null = null;
  if (!small) {
    const rt = new WebGLRenderTarget(1, 1, { samples: 4, type: HalfFloatType });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    const gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.updateGtaoMaterial({ radius: 0.18, distanceExponent: 1.4, thickness: 1, scale: 1.1, samples: 12 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    gtao.blendIntensity = 0.9;
    composer.addPass(gtao);
    // a little bloom on the bright bits: stack light, LED reflections, the photo-eye
    composer.addPass(new UnrealBloomPass(new Vector2(1, 1), 0.16, 0.35, 0.92));
    composer.addPass(new OutputPass());
  }

  const frame = () => {
    const w = view.clientWidth, h = view.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer?.setPixelRatio(renderer.getPixelRatio());
    composer?.setSize(w, h);
    camera.aspect = w / h;
    const vf = (camera.fov * Math.PI) / 360;
    const hf = Math.atan(Math.tan(vf) * camera.aspect);
    const wide = camera.aspect >= 1.2;
    const dist = Math.max((wide ? 1.55 : 1.2) / Math.tan(hf), (wide ? 0.82 : 0.9) / Math.tan(vf));
    const aim = target.clone().setY(target.y + (zoom - 1) * 0.6);
    camera.position.setFromSphericalCoords(dist * zoom, Math.PI / 2 - base.el, base.az + orbit).add(aim);
    camera.lookAt(aim);
    camera.updateProjectionMatrix();
  };
  const render = () => (composer ? composer.render() : renderer.render(scene, camera));

  // apply one physics frame to the scene
  const stack = cell.stack;
  const apply = (s: Float32Array) => {
    cell.setJoints(s.subarray(S.q, S.q + 6));
    cell.beltTex.offset.x = -s[S.beltOffset] / 0.12;
    cell.eyeBeam.color.set(s[S.beam] ? '#30d158' : '#ff3b30');
    cell.beacon.emissive.set(s[S.beacon] ? '#ffb000' : '#000000');
    cell.beacon.emissiveIntensity = s[S.beacon] ? 2.2 : 0;
    const field = s[S.field], pulse = 0.5 + 0.5 * Math.sin(s[S.time] * 9), z = cell.zones;
    z.warn.opacity = field >= 1 ? 0.75 + 0.25 * pulse : 0.5;
    z.stop.opacity = field === 2 ? 0.75 + 0.25 * pulse : 0.45;
    z.warnFill.opacity = field === 1 ? 0.1 : 0;
    z.stopFill.opacity = field === 2 ? 0.12 : 0;
    const a = s[S.scan];
    cell.scan.root.visible = a > 0;
    cell.scan.mats[0].opacity = 0.16 * a;
    cell.scan.mats[1].opacity = 0.8 * a;
    const u = s[S.puff];
    cell.puff.root.visible = u >= 0 && u < 1;
    if (u >= 0) {
      cell.puff.mat.opacity = 0.85 * (1 - u);
      for (const p of cell.puff.root.children) {
        const [dx, dz] = p.userData.dir as [number, number];
        const r = 0.03 + 0.07 * u;
        p.position.set(dx * r, 0.01 * u, dz * r);
        p.scale.setScalar(1 + u * 1.5);
      }
    }
    cell.pallet.position.set(s[S.pallet], s[S.pallet + 1], s[S.pallet + 2]);
    const P = cell.person, o = S.person;
    P.root.visible = s[o] > 0;
    if (P.root.visible) {
      P.root.position.set(s[o + 1], FLOOR_Y, s[o + 2]);
      P.root.rotation.y = s[o + 3];
      P.pose(s[o + 4], s[o + 5], s[o + 6], s[o + 7]);
    }
    const exiting: Object3D[] = [];
    for (let i = 0; i < POOL; i++) {
      const k = S.boxes + i * S.stride, b = boxes[i];
      b.visible = s[k + 7] > 0;
      if (!b.visible) continue;
      b.position.set(s[k], s[k + 1], s[k + 2]);
      b.quaternion.set(s[k + 3], s[k + 4], s[k + 5], s[k + 6]);
      if (s[k + 8] > 0) exiting.push(b);
    }
    const fade = s[S.fade];
    fader.set(fade < 0.999 ? [...exiting, cell.pallet] : [], fade);
  };
  const handle = (events: HudEvent[], time: number) => {
    for (const e of events) {
      switch (e.k) {
        case 'log': hud.log(e.t, e.text, e.tone); break;
        case 'edge': hud.edge(e.t, e.n, e.detail); break;
        case 'reset': hud.resetEdges(); break;
        case 'stats': hud.stats(e.s); break;
        case 'tool': hud.tool(e.vac, e.payload, e.speed); break;
        case 'kind': styleBox(boxes[e.i], { sku: e.sku, damaged: e.damaged }); break;
        case 'status': {
          hud.status(e.label, e.tone);
          const [red, amber, green] = stack;
          red.emissiveIntensity = e.tone === 'stop' ? 2.4 : 0;
          amber.emissiveIntensity = e.tone === 'hold' ? 2.4 : 0;
          green.emissiveIntensity = e.tone === 'run' ? 2.0 : 0;
          break;
        }
      }
    }
    hud.clock(time);
  };

  let state: Float32Array;
  try {
    state = await first;
  } catch (err) {
    worker.terminate();
    throw err;
  }
  handle(pendingEvents, state[S.time]);
  pendingEvents = [];
  apply(state);
  if (state[S.person] > 0) zoom = 1.3;

  view.prepend(canvas);
  frame();
  render();
  root.classList.add('is-loaded');

  // loop: one physics request per animation frame, and the next only once the last has come back
  let playing = !opts.reduced;
  let visible = true;
  let raf = 0;
  let waiting = false;
  let last = performance.now();
  onFrame = (s, events) => {
    waiting = false;
    cell.ambient(Math.max(0, Math.min(0.1, s[S.time] - state[S.time])));   // the neighbouring line keeps running
    state = s;
    handle(events, s[S.time]);
    pendingEvents = [];
    apply(s);
    const goal = s[S.person] > 0 ? 1.3 : 1;      // pull back while the operator is in the cell so they fit
    if (Math.abs(goal - zoom) > 1e-3) { zoom += (goal - zoom) * 0.03; frame(); }
    render();
    schedule();
  };
  const tick = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (playing && !waiting) { waiting = true; worker.postMessage({ type: 'step', dt }); }
  };
  const schedule = () => {
    if (!raf && playing && visible && !document.hidden && !waiting) raf = requestAnimationFrame(tick);
  };
  const resume = () => { last = performance.now(); schedule(); };

  new ResizeObserver(() => { frame(); render(); }).observe(view);
  new IntersectionObserver((e) => {
    visible = e.some((x) => x.isIntersecting);
    if (visible) resume();
  }).observe(view);
  document.addEventListener('visibilitychange', resume);

  let dragX: number | null = null;
  let orbit0 = 0;
  view.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    dragX = e.clientX;
    orbit0 = orbit;
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (dragX === null) return;
    orbit = Math.max(-0.95, Math.min(0.95, orbit0 - (e.clientX - dragX) * 0.006));
    frame();
    if (!playing) render();
  });
  const end = () => { dragX = null; };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);

  if (import.meta.env.DEV) {
    // dev only: jump the physics ahead, or move the camera, to inspect a moment
    Object.assign(window, { __twin: {
      seek(sec: number) { worker.postMessage({ type: 'seek', sec }); },
      look(o: { x?: number; y?: number; z?: number; zoom?: number; orbit?: number; el?: number; az?: number }) {
        target.set(o.x ?? target.x, o.y ?? target.y, o.z ?? target.z);
        base.el = o.el ?? base.el; base.az = o.az ?? base.az;
        zoom = o.zoom ?? zoom; orbit = o.orbit ?? orbit; frame(); render();
      },
      get time() { return state[S.time]; },
      tone(kind: 'agx' | 'aces' | 'neutral', exposure = renderer.toneMappingExposure, env = scene.environmentIntensity) {
        const map: Record<string, ToneMapping> = { agx: AgXToneMapping, aces: ACESFilmicToneMapping, neutral: NeutralToneMapping };
        renderer.toneMapping = map[kind]; renderer.toneMappingExposure = exposure; scene.environmentIntensity = env; render();
      },
    } });
  }
  const sync = () => { toggle.textContent = playing ? 'Pause' : 'Play'; };
  toggle.hidden = false;
  sync();
  toggle.addEventListener('click', () => {
    playing = !playing;
    sync();
    resume();
  });
  resume();
}
