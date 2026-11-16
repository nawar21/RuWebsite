"""Build public/models/ur5e.glb: an animated UR5e for the <model-viewer> section.

Source meshes and kinematics: MuJoCo Menagerie `universal_robots_ur5e`
(BSD-3-Clause, Copyright 2018 ROS Industrial Consortium).

    python scripts/build_ur5e_glb.py <path/to/mujoco_menagerie/universal_robots_ur5e>

Needs: trimesh, numpy, fast-simplification, pygltflib.
"""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pygltflib
import trimesh

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "public" / "models" / "ur5e.glb"
FACE_BUDGET = 0.3  # keep ~30% of faces: smooth at 600px, still under 2 MB

# A slow pick-and-place loop (radians, the 6 joints in MJCF order) at times in seconds.
HOME = [-1.5708, -1.5708, 1.5708, -1.5708, -1.5708, 0.0]
PICK_UP = [-0.75, -1.85, 1.95, -1.67, -1.5708, 0.0]
PICK_DN = [-0.75, -1.45, 2.05, -2.17, -1.5708, 0.0]
PLACE_UP = [-2.45, -1.85, 1.95, -1.67, -1.5708, 0.9]
PLACE_DN = [-2.45, -1.45, 2.05, -2.17, -1.5708, 0.9]
KEYS = [
    (0.0, HOME), (1.6, PICK_UP), (2.4, PICK_DN), (2.9, PICK_DN), (3.7, PICK_UP),
    (5.6, PLACE_UP), (6.4, PLACE_DN), (6.9, PLACE_DN), (7.7, PLACE_UP), (9.4, HOME), (10.0, HOME),
]
FPS = 30

MATERIALS = {  # MJCF rgba, tuned to read well on a white page
    "black": ([0.04, 0.04, 0.045, 1], 0.2, 0.55),
    "jointgray": ([0.30, 0.30, 0.32, 1], 0.3, 0.45),
    "linkgray": ([0.70, 0.72, 0.75, 1], 0.25, 0.35),
    "urblue": ([0.42, 0.64, 0.82, 1], 0.1, 0.4),
}


def quat_mul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ])


def axis_angle(axis, angle):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    return np.concatenate([[np.cos(angle / 2)], np.sin(angle / 2) * axis])


def parse_vec(s, default):
    return np.array([float(v) for v in s.split()]) if s else np.array(default, float)


root = ET.parse(SRC / "ur5e.xml").getroot()
default_axis = [0, 1, 0]

scene = trimesh.Scene()
bodies = []  # (node name, rest quat wxyz, joint axis or None)


def add_body(el, parent):
    name = el.get("name")
    pos = parse_vec(el.get("pos"), [0, 0, 0])
    quat = parse_vec(el.get("quat"), [1, 0, 0, 0])
    quat = quat / np.linalg.norm(quat)
    joint = el.find("joint")
    axis = parse_vec(joint.get("axis"), default_axis) if joint is not None else None
    m = trimesh.transformations.quaternion_matrix(quat)
    m[:3, 3] = pos
    scene.graph.update(frame_from=parent, frame_to=name, matrix=m)
    bodies.append((name, quat, axis))

    for i, g in enumerate(el.findall("geom")):
        if g.get("class") != "visual":
            continue
        mesh = trimesh.load(SRC / "assets" / f"{g.get('mesh')}.obj", force="mesh", process=True)
        mesh.merge_vertices(merge_tex=True, merge_norm=True)
        target = max(200, int(len(mesh.faces) * FACE_BUDGET))
        if len(mesh.faces) > target:
            mesh = mesh.simplify_quadric_decimation(face_count=target)
        rgba, metal, rough = MATERIALS[g.get("material")]
        mesh.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(
                name=g.get("material"), baseColorFactor=rgba, metallicFactor=metal, roughnessFactor=rough
            )
        )
        geom_name = f"{name}_geom{i}"
        scene.add_geometry(mesh, geom_name=geom_name, node_name=geom_name, parent_node_name=name)

    for child in el.findall("body"):
        add_body(child, name)


# MuJoCo is Z-up, glTF is Y-up: rotate -90 degrees about X at the root.
up = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])
scene.graph.update(frame_from=scene.graph.base_frame, frame_to="ur5e", matrix=up)
add_body(root.find("worldbody").find("body"), "ur5e")

OUT.parent.mkdir(parents=True, exist_ok=True)
glb_bytes = scene.export(file_type="glb", include_normals=True)
gltf = pygltflib.GLTF2.load_from_bytes(glb_bytes)
blob = bytearray(gltf.binary_blob())


def append(data: np.ndarray, acc_type, minmax=False):
    while len(blob) % 4:
        blob.append(0)
    offset = len(blob)
    raw = data.astype(np.float32).tobytes()
    blob.extend(raw)
    gltf.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=offset, byteLength=len(raw)))
    acc = pygltflib.Accessor(
        bufferView=len(gltf.bufferViews) - 1, componentType=pygltflib.FLOAT, count=len(data), type=acc_type
    )
    if minmax:
        acc.min = [float(data.min())]
        acc.max = [float(data.max())]
    gltf.accessors.append(acc)
    return len(gltf.accessors) - 1


# Smoothly interpolate joint angles (cosine ease between keys), sample at FPS.
key_t = np.array([k[0] for k in KEYS])
key_q = np.array([k[1] for k in KEYS])
times = np.arange(0, key_t[-1] + 1e-9, 1 / FPS)
idx = np.clip(np.searchsorted(key_t, times, side="right") - 1, 0, len(key_t) - 2)
u = (times - key_t[idx]) / (key_t[idx + 1] - key_t[idx])
u = 0.5 - 0.5 * np.cos(np.pi * u)
q = key_q[idx] + (key_q[idx + 1] - key_q[idx]) * u[:, None]

time_acc = append(times, pygltflib.SCALAR, minmax=True)
node_index = {n.name: i for i, n in enumerate(gltf.nodes)}
samplers, channels = [], []
joint_bodies = [b for b in bodies if b[2] is not None]
for j, (name, rest, axis) in enumerate(joint_bodies):
    rots = np.array([quat_mul(rest, axis_angle(axis, a)) for a in q[:, j]])
    xyzw = rots[:, [1, 2, 3, 0]]
    out_acc = append(xyzw, pygltflib.VEC4)
    samplers.append(pygltflib.AnimationSampler(input=time_acc, output=out_acc, interpolation="LINEAR"))
    channels.append(
        pygltflib.AnimationChannel(
            sampler=len(samplers) - 1, target=pygltflib.AnimationChannelTarget(node=node_index[name], path="rotation")
        )
    )
    # Rest pose = first frame, so the still model (reduced motion) is the home pose.
    node = gltf.nodes[node_index[name]]
    if node.matrix:  # glTF matrices are column-major: translation is elements 12..14
        node.translation = [float(v) for v in node.matrix[12:15]]
        node.matrix = None
    node.rotation = xyzw[0].tolist()

gltf.animations = [pygltflib.Animation(name="PickAndPlace", samplers=samplers, channels=channels)]
gltf.buffers[0].byteLength = len(blob)
gltf.set_binary_blob(bytes(blob))
gltf.save_binary(str(OUT))

faces = sum(len(g.faces) for g in scene.geometry.values())
print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB, {faces} faces, {len(times)} frames)")
