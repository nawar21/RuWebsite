# UR5e kinematics in Blender's frame for the glTF-imported public/models/ur5e.glb.
# The importer converts every node from glTF Y-up to Blender Z-up: v=(x,y,z) -> (x,-z,y), so the twin's
# REST/AXES (kinematics.ts) become the values below.
import math
import numpy as np
from mathutils import Matrix, Quaternion, Vector

JOINTS = ['shoulder_link', 'upper_arm_link', 'forearm_link', 'wrist_1_link', 'wrist_2_link', 'wrist_3_link']
REST = [Quaternion(), Quaternion((0, 0, 1), math.pi / 2), Quaternion(), Quaternion((0, 0, 1), math.pi / 2), Quaternion(), Quaternion()]
AXES = [Vector((0, -1, 0)), Vector((0, 0, 1)), Vector((0, 0, 1)), Vector((0, 0, 1)), Vector((0, -1, 0)), Vector((0, 0, 1))]
HOME = [-math.pi / 2, -math.pi / 2, math.pi / 2, -math.pi / 2, -math.pi / 2, 0.0]
FLANGE = 0.1


def jquat(j, q):
    return REST[j] @ Quaternion(AXES[j], q)


class Arm:
    def __init__(self, objs, base_world, tool_len):
        self.objs = objs
        self.locs = [Matrix.Translation(o.location.copy()) for o in objs]
        self.base = base_world.copy()
        self.tool = Matrix.Translation((0, 0, FLANGE + tool_len))

    def fk(self, q):
        m = self.base.copy()
        for j in range(6):
            m = m @ self.locs[j] @ jquat(j, q[j]).to_matrix().to_4x4()
        return m @ self.tool

    def set(self, q):
        for j, o in enumerate(self.objs):
            o.rotation_mode = 'QUATERNION'
            o.rotation_quaternion = jquat(j, q[j])

    def ik(self, target, seed, iters=200, tol=1e-7):
        q = np.array(seed, dtype=float)
        pt = target.to_translation()
        Rt = target.to_3x3()
        lam2 = 0.03 ** 2

        def err(qv):
            m = self.fk(qv)
            dp = pt - m.to_translation()
            dr = (Rt @ m.to_3x3().transposed()).to_quaternion()
            if dr.w < 0:
                dr.negate()
            ax, ang = dr.to_axis_angle()
            rv = ax * ang
            return np.array([dp.x, dp.y, dp.z, rv.x, rv.y, rv.z])

        for _ in range(iters):
            e = err(q)
            if e @ e < tol * tol:
                break
            J = np.zeros((6, 6))
            h = 1e-6
            for k in range(6):
                dq = q.copy(); dq[k] += h
                J[:, k] = (err(q) - err(dq)) / h  # d(-err)/dq = d(fk)/dq
            dq = J.T @ np.linalg.solve(J @ J.T + lam2 * np.eye(6), e)
            n = np.linalg.norm(dq)
            if n > 0.3:
                dq *= 0.3 / n
            q += dq
        e = err(q)
        return q, float(np.sqrt(e @ e))


def down(p, yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    m = Matrix(((c, s, 0, p[0]), (s, -c, 0, p[1]), (0, 0, -1, p[2]), (0, 0, 0, 1)))
    return m


def seed_for(p, yaw=0.0):
    """Elbow-up, tool-down seed facing the target (pan = -90 deg faces +Y at HOME)."""
    phi = math.atan2(p[1], p[0])
    pan = phi - math.pi
    while pan < -math.pi:
        pan += 2 * math.pi
    lift, elbow = -1.0, 1.7
    return [pan, lift, elbow, -math.pi / 2 - (lift + elbow), -math.pi / 2, 0.0]


def wrap_near(q, ref):
    """Shift each joint by multiples of 2*pi so it is closest to ref."""
    out = list(q)
    for k in range(6):
        while out[k] - ref[k] > math.pi:
            out[k] -= 2 * math.pi
        while out[k] - ref[k] < -math.pi:
            out[k] += 2 * math.pi
    return out
