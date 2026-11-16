// The cell as a MuJoCo model (MJCF). MuJoCo is Z-up; the twin's layout is Y-up, so every position goes through
// `p()` (three.js x, y, z -> MuJoCo x, -z, y) and every box size through `half()`.
//
// - UR5e: kinematic tree, inertias, joint armature and position servos from MuJoCo Menagerie
//   (universal_robots_ur5e, BSD-3-Clause). The arm's links do not collide; the motion planner keeps them clear.
// - Vacuum tool: the cup is the only colliding part of the arm. Suction is a weld per carton, switched on when the
//   cup seals with the carton's pose at that moment (the way Isaac Sim's surface gripper attaches a joint).
// - Cartons: POOL free bodies with mass and friction. Spares wait off stage.
// - Conveyor, hard stop, side guides, bins, pedestal: static geometry. The belt drive is applied as a friction-
//   limited force in sim.ts (MuJoCo has no moving surfaces), so the belt surface itself is nearly frictionless.
// - Pallet: a mocap (kinematic) body, so it can be rolled out with its load riding on it.
import { BELT, BOX, FLOOR_Y, PALLET, POOL, REJECT, TOTE, TOTE_B, park } from './layout.ts';

const f = (n: number) => +n.toFixed(5);
/** three.js position -> MuJoCo position */
export const p = (x: number, y: number, z: number) => `${f(x)} ${f(-z)} ${f(y)}`;
/** three.js full extents (x, y, z) -> MuJoCo box half sizes */
const half = (w: number, h: number, d: number) => `${f(w / 2)} ${f(d / 2)} ${f(h / 2)}`;

/** Tool length from the flange to the cup lip (matches kinematics.ts TOOL_LEN). */
export const CUP_LIP = 0.145;
/** The cup lip compresses this much into a carton when it presses down. */
export const CUP_MARGIN = 0.0;

function staticBox(name: string, w: number, h: number, d: number, x: number, y: number, z: number, extra = '') {
  return `<geom name="${name}" type="box" size="${half(w, h, d)}" pos="${p(x, y, z)}" ${extra}/>`;
}

function tote(name: string, at: { x: number; z: number; floor: number }) {
  const { w, d, h, t } = TOTE;
  const y = at.floor;
  return [
    staticBox(`${name}_floor`, w, t, d, at.x, y + t / 2, at.z),
    staticBox(`${name}_n`, w, h, t, at.x, y + h / 2, at.z - d / 2 + t / 2),
    staticBox(`${name}_s`, w, h, t, at.x, y + h / 2, at.z + d / 2 - t / 2),
    staticBox(`${name}_e`, t, h, d, at.x + w / 2 - t / 2, y + h / 2, at.z),
    staticBox(`${name}_w`, t, h, d, at.x - w / 2 + t / 2, y + h / 2, at.z),
  ].join('\n    ');
}

export function buildMJCF() {
  const len = BELT.x1 - BELT.x0;
  const cx = (BELT.x0 + BELT.x1) / 2;
  const boxes = Array.from({ length: POOL }, (_, i) => {
    const q = park(i);
    return `<body name="box${i}" pos="${p(q.x, q.y, q.z)}"><freejoint name="box${i}"/>`
      + `<geom class="carton" name="box${i}" size="${half(BOX.L, BOX.H, BOX.W)}"/></body>`;
  }).join('\n    ');

  return `<mujoco model="rurobotics palletizing cell">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" integrator="implicitfast" cone="elliptic" impratio="10"/>
  <size memory="16M"/>
  <default>
    <geom friction="0.8 0.01 0.0005" solref="0.004 1" condim="3"/>
    <default class="carton"><geom type="box" mass="${BOX.mass}" friction="0.6 0.01 0.0005" condim="4"/></default>
    <default class="ur5e">
      <joint axis="0 1 0" range="-6.28319 6.28319" armature="0.1"/>
      <general gaintype="fixed" biastype="affine" ctrlrange="-6.2831 6.2831" gainprm="2000" biasprm="0 -2000 -400" forcerange="-150 150"/>
      <geom contype="0" conaffinity="0" group="3" type="capsule"/>
      <default class="size3"><default class="size3_limited"><joint range="-3.1415 3.1415"/><general ctrlrange="-3.1415 3.1415"/></default></default>
      <default class="size1"><general gainprm="500" biasprm="0 -500 -100" forcerange="-28 28"/></default>
    </default>
  </default>
  <worldbody>
    <geom name="floor" type="plane" size="30 30 0.1" pos="0 0 ${FLOOR_Y}"/>
    ${staticBox('pedestal', 0.2, -FLOOR_Y, 0.2, 0, FLOOR_Y / 2, 0)}
    ${staticBox('belt', len, 0.02, BELT.width, cx, BELT.top - 0.01, BELT.z, 'priority="1" friction="0.03 0.005 0.0001"')}
    ${staticBox('guide_n', len - 0.3, 0.03, 0.008, cx - 0.1, BELT.top + 0.045, BELT.z - BELT.width / 2 + 0.004)}
    ${staticBox('guide_s', len - 0.3, 0.03, 0.008, cx - 0.1, BELT.top + 0.045, BELT.z + BELT.width / 2 - 0.004)}
    ${staticBox('stop', 0.022, 0.045, BELT.width - 0.02, BELT.stopX + 0.011, BELT.top + 0.0225, BELT.z)}
    ${tote('reject', REJECT)}
    ${tote('toteb', TOTE_B)}
    <body name="pallet" mocap="true" pos="${p(PALLET.x, PALLET.top, PALLET.z)}">
      <geom name="pallet" type="box" size="${half(0.52, 0.09, 0.34)}" pos="0 0 -0.045" friction="0.9 0.01 0.0005"/>
    </body>
    <body name="base" gravcomp="1" quat="0 0 0 -1" childclass="ur5e">
      <inertial mass="4.0" pos="0 0 0" diaginertia="0.00443333156 0.00443333156 0.0072"/>
      <body name="shoulder_link" gravcomp="1" pos="0 0 0.163">
        <inertial mass="3.7" pos="0 0 0" diaginertia="0.0102675 0.0102675 0.00666"/>
        <joint name="shoulder_pan_joint" class="size3" axis="0 0 1"/>
        <geom size="0.06 0.06" pos="0 0 -0.04"/>
        <body name="upper_arm_link" gravcomp="1" pos="0 0.138 0" quat="1 0 1 0">
          <inertial mass="8.393" pos="0 0 0.2125" diaginertia="0.133886 0.133886 0.0151074"/>
          <joint name="shoulder_lift_joint" class="size3"/>
          <geom size="0.05 0.2" pos="0 0 0.2"/>
          <body name="forearm_link" gravcomp="1" pos="0 -0.131 0.425">
            <inertial mass="2.275" pos="0 0 0.196" diaginertia="0.0311796 0.0311796 0.004095"/>
            <joint name="elbow_joint" class="size3_limited"/>
            <geom size="0.038 0.19" pos="0 0 0.2"/>
            <body name="wrist_1_link" gravcomp="1" pos="0 0 0.392" quat="1 0 1 0">
              <inertial mass="1.219" pos="0 0.127 0" diaginertia="0.0025599 0.0025599 0.0021942"/>
              <joint name="wrist_1_joint" class="size1"/>
              <body name="wrist_2_link" gravcomp="1" pos="0 0.127 0">
                <inertial mass="1.219" pos="0 0 0.1" diaginertia="0.0025599 0.0025599 0.0021942"/>
                <joint name="wrist_2_joint" axis="0 0 1" class="size1"/>
                <body name="wrist_3_link" gravcomp="1" pos="0 0 0.1">
                  <inertial mass="0.1889" pos="0 0.0771683 0" quat="1 0 0 1" diaginertia="0.000132134 9.90863e-05 9.90863e-05"/>
                  <joint name="wrist_3_joint" class="size1"/>
                  <body name="tool" gravcomp="1" pos="0 0.1 0" quat="-1 1 0 0">
                    <inertial mass="0.45" pos="0 0 0.06" diaginertia="0.0006 0.0006 0.0002"/>
                    <geom name="cup" type="cylinder" size="0.026 0.006" pos="0 0 ${f(CUP_LIP - 0.006)}"
                      contype="1" conaffinity="1" group="0" friction="1.6 0.02 0.001"/>
                  </body>
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>
    </body>
    ${boxes}
  </worldbody>
  <actuator>
    <general class="size3" name="shoulder_pan" joint="shoulder_pan_joint"/>
    <general class="size3" name="shoulder_lift" joint="shoulder_lift_joint"/>
    <general class="size3_limited" name="elbow" joint="elbow_joint"/>
    <general class="size1" name="wrist_1" joint="wrist_1_joint"/>
    <general class="size1" name="wrist_2" joint="wrist_2_joint"/>
    <general class="size1" name="wrist_3" joint="wrist_3_joint"/>
  </actuator>
  <equality>
    ${Array.from({ length: POOL }, (_, i) => `<weld name="grip${i}" body1="tool" body2="box${i}" active="false" solref="0.004 1"/>`).join('\n    ')}
  </equality>
</mujoco>`;
}
