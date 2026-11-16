// Web Worker: owns MuJoCo and the cell controller, so physics never blocks the page and the site's CSP
// (a <meta> policy, which does not reach workers) can stay strict. Protocol:
//   in:  { type: 'init', reduced }  { type: 'step', dt }  { type: 'seek', sec }
//   out: { type: 'frame', state: Float32Array (see sim.ts S), events: HudEvent[] }  { type: 'error', message }
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { buildMJCF } from './mjcf.ts';
import { Sim, STATE_LEN, type HudEvent } from './sim.ts';

let sim: Sim | null = null;
let events: HudEvent[] = [];

function flush() {
  const state = new Float32Array(STATE_LEN);
  sim!.write(state);
  (self as unknown as Worker).postMessage({ type: 'frame', state, events }, [state.buffer]);
  events = [];
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const mj = await loadMujoco({ locateFile: () => wasmUrl });
      const model = mj.MjModel.from_xml_string(buildMJCF());
      const data = new mj.MjData(model);
      sim = new Sim({ mj, model, data }, (ev) => events.push(ev));
      if (m.reduced) {
        // a still for reduced motion: run ahead to the operator handing a carton onto the pallet,
        // or as far as a 4 s compute budget gets on a slow device
        const start = performance.now();
        while (!sim.personPlacing && sim.time < 90 && performance.now() - start < 4000) sim.advance(0.05);
        for (let i = 0; i < 6; i++) sim.advance(0.05);
      }
      flush();
    } else if (m.type === 'step' && sim) {
      sim.advance(m.dt);
      flush();
    } else if (m.type === 'seek' && sim) {
      for (let t = 0; t < m.sec; t += 0.05) sim.advance(0.05);
      flush();
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
