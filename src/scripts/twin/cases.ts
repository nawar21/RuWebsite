// The ten edge cases the twin's palletizing cell meets in every loop, in the order they happen.
// `code` is the failure code (or production-state call) RuRobotics' executor uses for it:
// ruro/contracts/outcomes.py FailureCode, ruro/skills/runtime.py recovery actions,
// ruro/skills/production.py slot bookkeeping. Shared by the page markup and the HUD.

export interface EdgeCase {
  n: number;
  code: string;
  title: string;
  detect: string;
  response: string;
}

export const CASES: EdgeCase[] = [
  {
    n: 1, code: 'pose_error', title: 'Box arrives rotated',
    detect: 'Wrist camera measures 35° of yaw off the belt guide.',
    response: 'Grasp re-planned with the wrist turned to match. The box still lands square on the pallet.',
  },
  {
    n: 2, code: 'identity_switch', title: 'Two boxes touching',
    detect: 'One 0.30 m blob where a box is 0.15 m long.',
    response: 'Re-observe, split at the depth edge, pick them one at a time.',
  },
  {
    n: 3, code: 'empty_grasp', title: 'No vacuum seal',
    detect: 'Vacuum reads 9 kPa after the press. It needs 55.',
    response: 'Vent, press again with a longer dwell, confirm the seal before lifting.',
  },
  {
    n: 4, code: 'product_damage', title: 'Crushed carton',
    detect: 'Depth shows one corner 18 mm low.',
    response: 'Not palletized. Placed in the reject bin and logged.',
  },
  {
    n: 5, code: 'slip', title: 'Box slips off the cup',
    detect: 'Vacuum drops from 62 to 14 kPa during the lift.',
    response: 'Motion held, the box re-located on the belt, regrasped and carried at 70% speed.',
  },
  {
    n: 6, code: 'wrong_slot', title: 'Wrong SKU on the line',
    detect: 'Label reads SKU-B on an SKU-A pallet order.',
    response: 'Routed to the SKU-B tote before it can reach the wrong pallet.',
  },
  {
    n: 7, code: 'conveyor_miss', title: 'Infeed stops',
    detect: 'No part at the photo-eye 2 s after the robot is ready.',
    response: 'Hold at the ready pose without faulting. Resume as soon as parts flow.',
  },
  {
    n: 8, code: 'robot_fault', title: 'Person enters the cell',
    detect: 'Area scanner trips the warning field, then the protective field.',
    response: 'Slow to 30%, then a safeguard stop with the part held on vacuum. Resume when the zone is clear.',
  },
  {
    n: 9, code: 'slot_observed_occupied', title: 'Pallet slot already taken',
    detect: 'Before placing, the camera finds a box the robot did not put there.',
    response: 'Slot reconciled as occupied, not counted. Place re-planned to the next free slot.',
  },
  {
    n: 10, code: 'failed_release', title: 'Box sticks to the cup',
    detect: 'Release check still sees the box on the tool after venting.',
    response: 'Blow-off pulse, set down again, release verified before the count moves.',
  },
];
