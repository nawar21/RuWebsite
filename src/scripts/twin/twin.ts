// Mounts the digital twin into the #twin section: WebGL renderer, camera with a horizontal drag orbit, the HUD
// bindings, and the frame loop. Loaded on demand by DigitalTwin.astro when the section nears the viewport.
import {
  DirectionalLight, HemisphereLight, NeutralToneMapping, PCFSoftShadowMap, PerspectiveCamera, PMREMGenerator,
  Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CASES } from './cases';
import { Sim, type Hud, type Stats, type Tone } from './sim';
import { buildCell } from './world';

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

  const hud: Hud & { clock(t: number): void } = {
    log(t, text, tone: Tone) {
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
    edge(t, n, detail) {
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
    status(label, tone) {
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
    tool(vac, payload, speed) {
      const v = `Vacuum ${vac} kPa · Payload ${payload.toFixed(1)} kg · Speed ${speed}%`;
      if (tool.textContent !== v) tool.textContent = v;
    },
    clock(t) {
      clock.textContent = `T+${fmt(t)}`;
      if (bannerUntil >= 0 && t > bannerUntil) {
        bannerUntil = -1;
        banner.hidden = true;
        if (active) setActive(0);
      }
    },
  };
  return hud;
}

export async function mountTwin(root: HTMLElement, opts: TwinOptions) {
  if (root.dataset.mounted) return;
  root.dataset.mounted = '1';
  const view = root.querySelector<HTMLElement>('.twin__view')!;
  const toggle = root.querySelector<HTMLButtonElement>('.twin__toggle')!;
  const small = matchMedia('(max-width: 700px), (pointer: coarse)').matches;

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.toneMapping = NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'twin__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label',
    'Simulated palletizing cell in a factory hall: boxes arrive on an infeed conveyor, a UR5e arm with a vacuum cup stacks them on a pallet, with a reject bin, an SKU-B tote, perimeter guarding and floor-marked safety zones.');

  const cell = await buildCell(opts.modelUrl);
  const { scene } = cell;
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();
  scene.add(new HemisphereLight('#f4f7fb', '#b4b9c0', 0.9));
  const sun = new DirectionalLight('#fff6ea', 2.4);
  sun.position.set(1.6, 3.4, 2.4);
  sun.target.position.set(0.1, -0.5, 0.1);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 8 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.015;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  const hud = bindHud(root);
  const sim = new Sim(cell, hud);

  // camera: framed on the cell, dragged left/right around it (vertical drags scroll the page)
  const camera = new PerspectiveCamera(30, 1, 0.05, 40);
  const target = new Vector3(0.0, -0.08, 0.12);
  const base = { az: 0.55, el: 0.36 };
  let orbit = 0;
  let zoom = 1;
  const frame = () => {
    const w = view.clientWidth, h = view.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
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

  let playing = !opts.reduced;
  let visible = true;
  let raf = 0;
  let last = performance.now();
  const render = () => renderer.render(scene, camera);
  const tick = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (playing) {
      sim.step(dt);
      hud.clock(sim.time);
      // ease the camera back while the operator is in the cell so a 1.8 m person fits the frame
      const goal = sim.operatorInCell ? 1.3 : 1;
      if (Math.abs(goal - zoom) > 1e-3) { zoom += (goal - zoom) * Math.min(1, dt * 1.6); frame(); }
    }
    render();
    schedule();
  };
  const schedule = () => {
    if (!raf && playing && visible && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  };

  if (opts.reduced) {
    // a still: run the script ahead to the operator in the cell, then draw one frame
    for (let i = 0; i < 60 * 90 && !sim.personPlacing; i++) sim.step(1 / 60);
    for (let i = 0; i < 18; i++) sim.step(1 / 60);
    hud.clock(sim.time);
    zoom = 1.3;
  }

  view.prepend(canvas);
  frame();
  render();
  root.classList.add('is-loaded');

  new ResizeObserver(() => { frame(); if (!playing) render(); }).observe(view);
  new IntersectionObserver((e) => {
    visible = e.some((x) => x.isIntersecting);
    if (visible) schedule();
  }).observe(view);
  document.addEventListener('visibilitychange', schedule);

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
    // dev only: jump the script ahead to inspect a given moment
    Object.assign(window, { __twin: {
      sim,
      seek(sec: number) { for (let t = 0; t < sec; t += 1 / 60) sim.step(1 / 60); hud.clock(sim.time); render(); },
      look(o: { x?: number; y?: number; z?: number; zoom?: number; orbit?: number; el?: number; az?: number }) {
        target.set(o.x ?? target.x, o.y ?? target.y, o.z ?? target.z);
        base.el = o.el ?? base.el; base.az = o.az ?? base.az;
        zoom = o.zoom ?? zoom; orbit = o.orbit ?? orbit; frame(); render();
      },
    } });
  }
  const sync = () => { toggle.textContent = playing ? 'Pause' : 'Play'; };
  toggle.hidden = false;
  sync();
  toggle.addEventListener('click', () => {
    playing = !playing;
    sync();
    schedule();
  });
  schedule();
}
