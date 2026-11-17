# Builds a UR5e palletizing cell in a factory hall and animates two pick-and-place cycles, filmed by a
# handheld phone. Renders public/assets/ur5e-line.mp4 together with audio.py and post.sh (see README.md).
#   Blender -b --factory-startup -P scene.py -- still FRAME PCT SAMPLES   one test frame -> out/still_FRAME.png
#   Blender -b --factory-startup -P scene.py -- anim 0 PCT SAMPLES        every frame    -> out/frames/f_####.png
#   Blender -b --factory-startup -P scene.py -- plan                      motion plan only (writes out/events.json)
# Env overrides for framing tests: CAM0, LOOK, LENS, EXPO, HAZE, HAZE_D.
import bpy, sys, os, math, random
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from kin import Arm, JOINTS, HOME, down, seed_for, wrap_near

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
MODE = argv[0] if argv else 'still'
STILL_FRAME = int(argv[1]) if MODE == 'still' and len(argv) > 1 else 60
PCT = int(argv[2]) if len(argv) > 2 else 50
SAMPLES = int(argv[3]) if len(argv) > 3 else 32
WORK = os.environ.get('WORK', os.path.join(HERE, 'out'))
OUT = os.path.join(WORK, 'frames')
MODEL = os.path.join(HERE, '..', '..', 'public', 'models', 'ur5e.glb')
os.makedirs(WORK, exist_ok=True)

FPS = 30
N_FRAMES = 285
FZ = -0.80                  # floor
BELT_Z = -0.10              # belt top
BELT_Y = -0.45
BOX = (0.20, 0.15, 0.12)    # L (x), W (y), H
STOP_X = 0.0                # box centre at the end stop
TOOL_LEN = 0.12
PAL = (0.55, 0.05)          # pallet centre
PAL_TOP = -0.40
BELT_V = 0.25

rng = random.Random(7)

# ------------------------------------------------------------------------------------------ scene
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = N_FRAMES


def link(o, coll=None):
    (coll or scene.collection).objects.link(o)
    return o


# ------------------------------------------------------------------------------------- materials
def mat(name, color, rough=0.5, metal=0.0, var=0.08, rvar=0.15, bump=0.05, scale=6.0, coat=0.0,
        obj_rand=0.0, emission=None, estrength=0.0, aniso=0.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    n = nt.nodes
    l = nt.links
    bsdf = n.get('Principled BSDF')
    bsdf.inputs['Metallic'].default_value = metal
    if coat:
        bsdf.inputs['Coat Weight'].default_value = coat
        bsdf.inputs['Coat Roughness'].default_value = 0.15
    if aniso:
        bsdf.inputs['Anisotropic'].default_value = aniso
    tc = n.new('ShaderNodeTexCoord')
    # two noise scales: blotchy wear and fine grain
    nz = n.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 8
    l.new(tc.outputs['Object'], nz.inputs['Vector'])
    fine = n.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value = scale * 40; fine.inputs['Detail'].default_value = 4
    l.new(tc.outputs['Object'], fine.inputs['Vector'])
    # colour variation
    mixc = n.new('ShaderNodeMix'); mixc.data_type = 'RGBA'; mixc.blend_type = 'MULTIPLY'
    mixc.inputs['Factor'].default_value = 1.0
    c = Vector(color)
    ramp = n.new('ShaderNodeMapRange')
    ramp.inputs['From Min'].default_value = 0.3; ramp.inputs['From Max'].default_value = 0.7
    ramp.inputs['To Min'].default_value = 1 - var; ramp.inputs['To Max'].default_value = 1 + var
    l.new(nz.outputs['Fac'], ramp.inputs['Value'])
    if obj_rand:
        oi = n.new('ShaderNodeObjectInfo')
        r2 = n.new('ShaderNodeMapRange')
        r2.inputs['To Min'].default_value = 1 - obj_rand; r2.inputs['To Max'].default_value = 1 + obj_rand
        l.new(oi.outputs['Random'], r2.inputs['Value'])
        mul = n.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'
        l.new(ramp.outputs['Result'], mul.inputs[0]); l.new(r2.outputs['Result'], mul.inputs[1])
        fac_out = mul.outputs['Value']
    else:
        fac_out = ramp.outputs['Result']
    comb = n.new('ShaderNodeCombineColor')
    for k in range(3):
        l.new(fac_out, comb.inputs[k])
    mixc.inputs[6].default_value = (c[0], c[1], c[2], 1)  # A
    l.new(comb.outputs['Color'], mixc.inputs[7])           # B
    l.new(mixc.outputs[2], bsdf.inputs['Base Color'])
    # roughness variation
    rr = n.new('ShaderNodeMapRange')
    rr.inputs['From Min'].default_value = 0.25; rr.inputs['From Max'].default_value = 0.75
    rr.inputs['To Min'].default_value = max(0.02, rough - rvar / 2); rr.inputs['To Max'].default_value = min(1, rough + rvar / 2)
    l.new(nz.outputs['Fac'], rr.inputs['Value'])
    l.new(rr.outputs['Result'], bsdf.inputs['Roughness'])
    if bump:
        bp = n.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = bump; bp.inputs['Distance'].default_value = 0.002
        l.new(fine.outputs['Fac'], bp.inputs['Height'])
        l.new(bp.outputs['Normal'], bsdf.inputs['Normal'])
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1)
        bsdf.inputs['Emission Strength'].default_value = estrength
    return m


def emit_mat(name, color, strength):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    n = m.node_tree.nodes
    for x in list(n):
        n.remove(x)
    o = n.new('ShaderNodeOutputMaterial')
    e = n.new('ShaderNodeEmission')
    e.inputs['Color'].default_value = (*color, 1)
    e.inputs['Strength'].default_value = strength
    m.node_tree.links.new(e.outputs[0], o.inputs[0])
    return m


M = {}
M['floor'] = mat('epoxy_floor', (0.105, 0.115, 0.11), rough=0.26, var=0.22, rvar=0.34, bump=0.03, scale=0.6)
_ft = M['floor'].node_tree
_b = _ft.nodes['Principled BSDF']
_tc = _ft.nodes.new('ShaderNodeTexCoord')
_mp = _ft.nodes.new('ShaderNodeMapping'); _mp.inputs['Scale'].default_value = (0.25, 7.0, 1.0)
_ft.links.new(_tc.outputs['Object'], _mp.inputs['Vector'])
_nz = _ft.nodes.new('ShaderNodeTexNoise'); _nz.inputs['Scale'].default_value = 1.2; _nz.inputs['Detail'].default_value = 3
_ft.links.new(_mp.outputs['Vector'], _nz.inputs['Vector'])
_cr = _ft.nodes.new('ShaderNodeMapRange'); _cr.inputs['From Min'].default_value = 0.55; _cr.inputs['From Max'].default_value = 0.75
_cr.inputs['To Min'].default_value = 1.0; _cr.inputs['To Max'].default_value = 0.55
_ft.links.new(_nz.outputs['Fac'], _cr.inputs['Value'])
_src = _b.inputs['Base Color'].links[0].from_socket
_mul = _ft.nodes.new('ShaderNodeMix'); _mul.data_type = 'RGBA'; _mul.blend_type = 'MULTIPLY'; _mul.inputs['Factor'].default_value = 1.0
_ft.links.new(_src, _mul.inputs[6])
_cc = _ft.nodes.new('ShaderNodeCombineColor')
for _k in range(3):
    _ft.links.new(_cr.outputs['Result'], _cc.inputs[_k])
_ft.links.new(_cc.outputs['Color'], _mul.inputs[7])
_ft.links.new(_mul.outputs[2], _b.inputs['Base Color'])
M['line_y'] = mat('paint_yellow', (0.75, 0.48, 0.02), rough=0.45, var=0.22, rvar=0.4, bump=0.05, scale=3)
M['dark_steel'] = mat('ral7016', (0.032, 0.037, 0.042), rough=0.42, var=0.1, rvar=0.2, scale=4)
M['light_steel'] = mat('ral7035', (0.62, 0.63, 0.60), rough=0.4, var=0.06, rvar=0.2, scale=3)
M['alu'] = mat('aluminium', (0.80, 0.80, 0.82), rough=0.32, metal=1.0, var=0.04, rvar=0.18, scale=8, aniso=0.4)
M['alu_dull'] = mat('aluminium_dull', (0.70, 0.71, 0.72), rough=0.5, metal=1.0, var=0.05, rvar=0.2, scale=8)
M['rubber'] = mat('belt_rubber', (0.022, 0.024, 0.026), rough=0.62, var=0.25, rvar=0.2, bump=0.25, scale=3)
M['black_plastic'] = mat('black_plastic', (0.015, 0.015, 0.016), rough=0.38, var=0.05, rvar=0.15)
M['cup'] = mat('suction_cup', (0.012, 0.012, 0.013), rough=0.55, var=0.05)
M['kraft'] = mat('kraft', (0.40, 0.25, 0.12), rough=0.82, var=0.10, rvar=0.1, bump=0.15, scale=9, obj_rand=0.08)
M['tape'] = mat('tape', (0.48, 0.33, 0.16), rough=0.22, var=0.05, rvar=0.15, bump=0.02, scale=20, coat=0.4)
M['label'] = mat('label', (0.78, 0.78, 0.76), rough=0.5, var=0.03, bump=0.02)
M['wood'] = mat('pallet_wood', (0.42, 0.30, 0.18), rough=0.85, var=0.22, rvar=0.1, bump=0.3, scale=14)
M['yellow'] = mat('ral1018', (0.80, 0.55, 0.02), rough=0.38, var=0.06, rvar=0.2, scale=5, coat=0.2)
M['blue'] = mat('ral5010', (0.01, 0.06, 0.20), rough=0.4, var=0.06, scale=5)
M['orange'] = mat('ral2004', (0.75, 0.13, 0.01), rough=0.42, var=0.06, scale=5)
M['wall'] = mat('wall_panel', (0.48, 0.50, 0.50), rough=0.55, var=0.08, rvar=0.2, scale=1.5)
M['ceiling'] = mat('ceiling', (0.30, 0.31, 0.31), rough=0.7, var=0.1)
M['wrap'] = mat('stretch_wrap', (0.70, 0.72, 0.72), rough=0.18, var=0.12, rvar=0.2, bump=0.4, scale=4, coat=0.6)
M['red'] = mat('red', (0.45, 0.02, 0.01), rough=0.3, coat=0.5)
M['tote'] = mat('tote_blue', (0.01, 0.10, 0.30), rough=0.45)
M['green'] = mat('tote_green', (0.04, 0.18, 0.06), rough=0.45)
M['window'] = emit_mat('window', (0.82, 0.90, 1.0), 9.0)
M['fixture'] = emit_mat('fixture', (1.0, 0.95, 0.86), 30.0)
M['led_green'] = emit_mat('led_green', (0.2, 1.0, 0.3), 12.0)
M['led_orange'] = emit_mat('led_orange', (1.0, 0.45, 0.05), 10.0)


def cube(name, size, loc, material, bevel=0.0, rot=(0, 0, 0), coll=None):
    me = bpy.data.meshes.new(name)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me)
    o.location = loc
    o.rotation_euler = rot
    me.materials.append(material)
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel; mod.segments = 2; mod.limit_method = 'ANGLE'
    link(o, coll)
    return o


def cyl(name, r, h, loc, material, rot=(0, 0, 0), verts=24, coll=None, bevel=0.0):
    import bmesh
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r, depth=h)
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = len(p.vertices) == 4
    o = bpy.data.objects.new(name, me)
    o.location = loc; o.rotation_euler = rot
    me.materials.append(material)
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL'); mod.width = bevel; mod.segments = 2; mod.limit_method = 'ANGLE'
    link(o, coll)
    return o


def cone(name, r1, r2, h, loc, material, rot=(0, 0, 0), verts=24):
    import bmesh
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r1, radius2=r2, depth=h)
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = len(p.vertices) == 4
    o = bpy.data.objects.new(name, me)
    o.location = loc; o.rotation_euler = rot
    me.materials.append(material)
    link(o)
    return o


def tube(name, pts, r, material):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'; cu.bevel_depth = r; cu.bevel_resolution = 3; cu.resolution_u = 12
    sp = cu.splines.new('NURBS')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (*p, 1)
    sp.use_endpoint_u = True; sp.order_u = 3
    o = bpy.data.objects.new(name, cu)
    cu.materials.append(material)
    link(o)
    return o


# ---------------------------------------------------------------------------------------- hall
floor = cube('floor', (60, 60, 0.02), (0, 0, FZ - 0.01), M['floor'])
# walkway lines and cell marking (worn paint)
cube('walkway_a', (14, 0.08, 0.002), (-1.0, -1.55, FZ + 0.001), M['line_y'])
cube('walkway_b', (14, 0.08, 0.002), (-1.0, -3.35, FZ + 0.001), M['line_y'])
cube('cell_line_1', (0.06, 2.6, 0.002), (1.35, 0.0, FZ + 0.001), M['line_y'])
cube('cell_line_2', (3.2, 0.06, 0.002), (-0.25, 1.25, FZ + 0.001), M['line_y'])
# walls, windows, ceiling
cube('wall_back', (40, 0.2, 9), (0, 11, FZ + 4.5), M['wall'])
cube('wall_left', (0.2, 40, 9), (-10, 0, FZ + 4.5), M['wall'])
cube('wall_right', (0.2, 40, 9), (12, 0, FZ + 4.5), M['wall'])
for i in range(7):
    cube(f'win_back_{i}', (4.2, 0.05, 1.1), (-8 + i * 5.2, 10.88, FZ + 5.4), M['window'])
for i in range(5):
    cube(f'win_left_{i}', (0.05, 4.2, 1.1), (-9.88, -6 + i * 5.2, FZ + 5.4), M['window'])
cube('ceiling', (40, 40, 0.2), (0, 0, FZ + 7.4), M['ceiling'])
# roof trusses
for i in range(9):
    cube(f'truss_{i}', (24, 0.25, 0.5), (1, -8 + i * 2.5, FZ + 7.0), M['light_steel'])
# columns (H beams)
for x in (-6.5, -0.5, 5.5):
    for y in (4.0, 9.8):
        c = cube(f'col_{x}_{y}', (0.32, 0.32, 7.4), (x, y, FZ + 3.7), M['light_steel'])
        cube(f'colguard_{x}_{y}', (0.42, 0.42, 1.0), (x, y, FZ + 0.5), M['yellow'], bevel=0.01)
# high-bay fixtures + area lights
for ix, x in enumerate((-6, -2, 2, 6)):
    for iy, y in enumerate((-4, 0, 4, 8)):
        cyl(f'hb_{ix}_{iy}', 0.28, 0.10, (x, y, FZ + 6.3), M['dark_steel'])
        cyl(f'hbl_{ix}_{iy}', 0.25, 0.01, (x, y, FZ + 6.245), M['fixture'], verts=32)
        ld = bpy.data.lights.new(f'L_{ix}_{iy}', 'AREA')
        ld.shape = 'DISK'; ld.size = 0.5; ld.energy = 650; ld.color = (1.0, 0.94, 0.86)
        lo = bpy.data.objects.new(f'L_{ix}_{iy}', ld); lo.location = (x, y, FZ + 6.22); link(lo)
# daylight through the windows
for i, x in enumerate((-6, 0, 6)):
    ld = bpy.data.lights.new(f'Win_{i}', 'AREA'); ld.shape = 'RECTANGLE'; ld.size = 4.0; ld.size_y = 1.2
    ld.energy = 900; ld.color = (0.80, 0.88, 1.0)
    lo = bpy.data.objects.new(f'Win_{i}', ld); lo.location = (x, 10.6, FZ + 5.4)
    lo.rotation_euler = (math.radians(-70), 0, 0); link(lo)

# ---------------------------------------------------------------------------------------- robot
bpy.ops.import_scene.gltf(filepath=MODEL)
robot_root = bpy.data.objects['ur5e']
for o in bpy.data.objects:
    if o.type == 'MESH' and o.name.split('_geom')[0] in JOINTS + ['base']:
        for p in o.data.polygons:
            p.use_smooth = True
# richer robot materials (keep names, replace node setups)
rm = {
    'linkgray': mat('ur_link', (0.62, 0.64, 0.66), rough=0.30, var=0.03, rvar=0.12, bump=0.01, scale=20, coat=0.35),
    'urblue': mat('ur_cap', (0.17, 0.42, 0.66), rough=0.33, var=0.02, rvar=0.1, bump=0.0, coat=0.3),
    'black': mat('ur_black', (0.018, 0.018, 0.02), rough=0.5, var=0.04, rvar=0.15),
    'jointgray': mat('ur_joint', (0.10, 0.10, 0.11), rough=0.42, metal=0.3, var=0.03),
}
for o in bpy.data.objects:
    if o.type == 'MESH':
        for slot in o.material_slots:
            if slot.material and slot.material.name in rm:
                slot.material = rm[slot.material.name]

joints = [bpy.data.objects[n] for n in JOINTS]
bpy.context.view_layer.update()
arm = Arm(joints, bpy.data.objects['base'].matrix_world, TOOL_LEN)
wrist3 = joints[5]

# vacuum tool on the flange (wrist_3 local: +z out of the flange, starting 0.1 from the wrist_3 origin)
def tool_part(o):
    o.parent = wrist3
    return o

tool_part(cyl('tool_adapter', 0.0315, 0.012, (0, 0, 0.106), M['alu'], bevel=0.001))
tool_part(cube('tool_block', (0.05, 0.05, 0.045), (0, 0, 0.1345), M['alu_dull'], bevel=0.003))
tool_part(cube('tool_ejector', (0.022, 0.05, 0.03), (0.036, 0, 0.13), M['black_plastic'], bevel=0.002))
tool_part(cube('tool_bar', (0.15, 0.03, 0.012), (0, 0, 0.163), M['alu'], bevel=0.002))
for sx in (-0.055, 0.055):
    tool_part(cyl(f'cup_stem_{sx}', 0.007, 0.03, (sx, 0, 0.184), M['alu']))
    tool_part(cone(f'cup_bellow_{sx}', 0.012, 0.016, 0.012, (sx, 0, 0.2), M['cup']))
    tool_part(cone(f'cup_lip_{sx}', 0.016, 0.022, 0.012, (sx, 0, 0.214), M['cup']))
led = tool_part(cube('tool_led', (0.004, 0.012, 0.006), (0.048, 0.0, 0.14), M['led_orange']))
# vacuum hose loop on the wrist
hose_pts = [(0.047, 0.012, 0.135), (0.07, 0.03, 0.10), (0.06, 0.06, 0.04), (0.03, 0.08, 0.0)]
h = tube('hose', hose_pts, 0.004, M['black_plastic']); h.parent = wrist3

# pedestal
cube('ped_base', (0.42, 0.42, 0.02), (0, 0, FZ + 0.01), M['dark_steel'], bevel=0.003)
cube('ped_col', (0.17, 0.17, abs(FZ) - 0.035), (0, 0, (FZ + 0.02 - 0.015) / 2), M['dark_steel'], bevel=0.004)
cube('ped_top', (0.22, 0.22, 0.015), (0, 0, -0.0075), M['dark_steel'], bevel=0.002)
for dx in (-0.17, 0.17):
    for dy in (-0.17, 0.17):
        cyl(f'anchor_{dx}_{dy}', 0.012, 0.03, (dx, dy, FZ + 0.03), M['alu_dull'], verts=6)
# robot cable and control box with teach pendant
tube('robot_cable', [(-0.045, 0.09, 0.02), (-0.1, 0.12, -0.05), (-0.1, 0.11, -0.5), (-0.12, 0.13, FZ + 0.03),
                     (-0.35, 0.40, FZ + 0.01), (-0.62, 0.62, FZ + 0.012), (-0.72, 0.70, FZ + 0.2)], 0.008, M['black_plastic'])
cube('control_box', (0.47, 0.27, 0.42), (-0.85, 0.72, FZ + 0.24), M['light_steel'], bevel=0.008, rot=(0, 0, math.radians(-35)))
cube('cb_feet', (0.42, 0.22, 0.03), (-0.85, 0.72, FZ + 0.015), M['black_plastic'], rot=(0, 0, math.radians(-35)))
cube('pendant', (0.30, 0.04, 0.23), (-0.68, 0.53, FZ + 0.33), M['black_plastic'], bevel=0.01, rot=(math.radians(8), 0, math.radians(-35)))

# ------------------------------------------------------------------------------------- conveyor
X0, X1 = -6.0, STOP_X + BOX[0] / 2 + 0.01
L = X1 - X0
belt_w = 0.30
belt = cube('belt', (L, belt_w, 0.01), ((X0 + X1) / 2, BELT_Y, BELT_Z - 0.005), M['rubber'])
cyl('end_roller', 0.045, belt_w + 0.01, (X1, BELT_Y, BELT_Z - 0.045), M['alu'], rot=(math.radians(90), 0, 0), verts=32)
for s in (-1, 1):
    y = BELT_Y + s * (belt_w / 2 + 0.025)
    cube(f'frame_{s}', (L + 0.02, 0.045, 0.12), ((X0 + X1) / 2, y, BELT_Z - 0.05), M['alu'], bevel=0.003)
    cube(f'guide_{s}', (L, 0.012, 0.04), ((X0 + X1) / 2, BELT_Y + s * (belt_w / 2 + 0.01), BELT_Z + 0.045), M['alu'], bevel=0.002)
    for i in range(int(L / 0.8)):
        x = X1 - 0.2 - i * 0.8
        cyl(f'guide_post_{s}_{i}', 0.006, 0.07, (x, BELT_Y + s * (belt_w / 2 + 0.03), BELT_Z + 0.02), M['alu_dull'], verts=8)
for i in range(int(L / 1.2) + 1):
    x = X1 - 0.15 - i * 1.2
    for s in (-1, 1):
        y = BELT_Y + s * (belt_w / 2 + 0.025)
        cube(f'leg_{i}_{s}', (0.045, 0.045, BELT_Z - 0.11 - FZ), (x, y, (BELT_Z - 0.11 + FZ) / 2), M['alu'], bevel=0.003)
        cyl(f'foot_{i}_{s}', 0.035, 0.02, (x, y, FZ + 0.01), M['black_plastic'])
    cube(f'brace_{i}', (0.04, belt_w + 0.05, 0.04), (x, BELT_Y, FZ + 0.25), M['alu'], bevel=0.003)
# end stop, photo eye, drive motor
cube('end_stop', (0.012, belt_w + 0.04, 0.07), (X1 + 0.05, BELT_Y, BELT_Z + 0.03), M['alu'], bevel=0.002)
cube('pe_bracket', (0.02, 0.03, 0.10), (STOP_X + 0.03, BELT_Y - belt_w / 2 - 0.05, BELT_Z + 0.03), M['alu_dull'])
cube('photo_eye', (0.03, 0.025, 0.045), (STOP_X + 0.03, BELT_Y - belt_w / 2 - 0.04, BELT_Z + 0.09), M['black_plastic'], bevel=0.002)
cube('pe_led', (0.006, 0.004, 0.006), (STOP_X + 0.03, BELT_Y - belt_w / 2 - 0.054, BELT_Z + 0.105), M['led_orange'])
cyl('motor', 0.055, 0.20, (X1 - 0.08, BELT_Y - belt_w / 2 - 0.16, BELT_Z - 0.07), M['blue'], rot=(math.radians(90), 0, 0), bevel=0.004)
cube('gearbox', (0.12, 0.08, 0.12), (X1 - 0.08, BELT_Y - belt_w / 2 - 0.08, BELT_Z - 0.07), M['blue'], bevel=0.006)

# moving belt texture: animate the texture coordinate offset of the rubber (object space)
rub = M['rubber'].node_tree
mp = rub.nodes.new('ShaderNodeMapping')
tc = [n for n in rub.nodes if n.bl_idname == 'ShaderNodeTexCoord'][0]
for lk in list(tc.outputs['Object'].links):
    rub.links.new(mp.outputs['Vector'], lk.to_socket)
rub.links.new(tc.outputs['Object'], mp.inputs['Vector'])

# ---------------------------------------------------------------------------------- lift + pallet
cube('lift_base', (0.66, 0.46, 0.05), (PAL[0], PAL[1], FZ + 0.025), M['yellow'], bevel=0.004)
cube('lift_top', (0.64, 0.44, 0.04), (PAL[0], PAL[1], PAL_TOP - 0.144 - 0.02), M['yellow'], bevel=0.004)
for s in (-1, 1):
    for a in (1, -1):
        cube(f'scissor_{s}_{a}', (0.62, 0.035, 0.03), (PAL[0], PAL[1] + s * 0.19, (FZ + 0.05 + PAL_TOP - 0.184) / 2),
             M['yellow'], rot=(0, a * math.radians(17), 0), bevel=0.003)
cyl('lift_ram', 0.025, 0.15, (PAL[0], PAL[1], FZ + 0.12), M['alu'], rot=(0, math.radians(70), 0))
pz = PAL_TOP - 0.144
for i, x in enumerate((-0.28, -0.14, 0.0, 0.14, 0.28)):
    cube(f'pal_top_{i}', (0.09, 0.40, 0.022), (PAL[0] + x * 1.0, PAL[1], PAL_TOP - 0.011), M['wood'], bevel=0.002)
for i, y in enumerate((-0.17, 0.0, 0.17)):
    cube(f'pal_str_{i}', (0.60, 0.07, 0.022), (PAL[0], PAL[1] + y, PAL_TOP - 0.033), M['wood'], bevel=0.002)
    for j, x in enumerate((-0.26, 0.0, 0.26)):
        cube(f'pal_blk_{i}_{j}', (0.08, 0.07, 0.078), (PAL[0] + x, PAL[1] + y, PAL_TOP - 0.083), M['wood'], bevel=0.003)
    cube(f'pal_bot_{i}', (0.60, 0.08, 0.022), (PAL[0], PAL[1] + y, PAL_TOP - 0.133), M['wood'], bevel=0.002)

# ------------------------------------------------------------------------------------------ boxes
boxes = []


def make_box(name, coll=None):
    b = cube(name, BOX, (0, 0, 0), M['kraft'], bevel=0.004, coll=coll)
    t = cube(name + '_tape', (BOX[0] + 0.004, 0.05, 0.001), (0, 0, BOX[2] / 2 + 0.0005), M['tape'])
    t.parent = b
    t2 = cube(name + '_tape_e', (0.002, 0.05, 0.06), (BOX[0] / 2 + 0.001, 0, BOX[2] / 2 - 0.03), M['tape'])
    t2.parent = b
    t3 = cube(name + '_tape_w', (0.002, 0.05, 0.06), (-BOX[0] / 2 - 0.001, 0, BOX[2] / 2 - 0.03), M['tape'])
    t3.parent = b
    lb = cube(name + '_label', (0.075, 0.001, 0.05), (0.04, -BOX[1] / 2 - 0.0006, -0.01), M['label'])
    lb.parent = b
    return b


def place_static(b, x, y, z, yaw=0.0):
    b.location = (x, y, z)
    b.rotation_euler = (0, 0, yaw)


# pallet load already built: layer 1 full, layer 2 far column
SLOTS_X = [PAL[0] - 0.20, PAL[0], PAL[0] + 0.20]
SLOTS_Y = [PAL[1] - 0.075, PAL[1] + 0.075]
for lx, x in enumerate(SLOTS_X):
    for ly, y in enumerate(SLOTS_Y):
        b = make_box(f'pal_l1_{lx}_{ly}')
        place_static(b, x + rng.uniform(-0.004, 0.004), y + rng.uniform(-0.003, 0.003), PAL_TOP + BOX[2] / 2, rng.uniform(-0.02, 0.02))
for ly, y in enumerate(SLOTS_Y):
    b = make_box(f'pal_l2_2_{ly}')
    place_static(b, SLOTS_X[2] + rng.uniform(-0.004, 0.004), y + rng.uniform(-0.003, 0.003), PAL_TOP + BOX[2] * 1.5, rng.uniform(-0.02, 0.02))

# ------------------------------------------------------------------------------- background dressing
def rack_bay(x0, y0, levels=(0.0, 1.55, 3.05, 4.5), bay=2.7, depth=1.1, seed=0):
    r = random.Random(seed)
    for dx in (0, bay):
        for dy in (0, depth):
            cube(f'up_{x0}_{dx}_{dy}', (0.08, 0.07, 5.2), (x0 + dx, y0 + dy, FZ + 2.6), M['blue'])
    for lv in levels[1:]:
        for dy in (0, depth):
            cube(f'beam_{x0}_{lv}_{dy}', (bay, 0.05, 0.11), (x0 + bay / 2, y0 + dy, FZ + lv), M['orange'])
    for lv in levels:
        for k in range(2):
            if r.random() < 0.15:
                continue
            px = x0 + 0.1 + k * 1.3 + 0.6
            base = FZ + lv + (0.06 if lv else 0.0)
            cube(f'rp_{x0}_{lv}_{k}', (1.15, 0.95, 0.14), (px, y0 + depth / 2, base + 0.07), M['wood'])
            kind = r.random()
            hgt = r.uniform(0.6, 1.15)
            if kind < 0.45:
                cube(f'rl_{x0}_{lv}_{k}', (1.1, 0.92, hgt), (px, y0 + depth / 2, base + 0.14 + hgt / 2), M['wrap'], bevel=0.02)
            else:
                nx, ny, nz = 4, 3, int(hgt / 0.25)
                for i in range(nx):
                    for j in range(ny):
                        for kk in range(max(1, nz)):
                            if kk == nz - 1 and r.random() < 0.3:
                                continue
                            c = cube(f'rb_{x0}_{lv}_{k}_{i}_{j}_{kk}', (0.26, 0.29, 0.24),
                                     (px - 0.41 + i * 0.275, y0 + depth / 2 - 0.31 + j * 0.31, base + 0.14 + 0.12 + kk * 0.245), M['kraft'])


for i, x in enumerate((-7.5, -4.8, -2.1, 0.6, 3.3)):
    rack_bay(x, 5.0, seed=i)
for i, x in enumerate((-7.5, -4.8, -2.1, 0.6, 3.3)):
    rack_bay(x, 8.2, seed=10 + i)

# second line in the background
for i in range(10):
    x = -7 + i * 1.2
    cube(f'bg_leg_{i}', (0.05, 0.6, 0.7), (x, 3.4, FZ + 0.35), M['alu'])
cube('bg_belt', (12, 0.55, 0.12), (-1.6, 3.4, FZ + 0.76), M['rubber'])
for i in range(6):
    b = cube(f'bg_box_{i}', (0.32, 0.26, 0.24), (-6.8 + i * 1.25 + rng.uniform(-0.3, 0.3), 3.4, FZ + 0.94), M['kraft'], bevel=0.004)
cube('bg_guard', (3.0, 0.04, 1.8), (2.6, 3.9, FZ + 0.9), M['yellow'])
# stack of empty pallets, a wrapped load waiting, totes, bollards, a bin, an extinguisher
def pallet(name, cx, cy, z0, w=1.2, d=0.8, yaw=0.0):
    parts = []
    for i in range(7):
        parts.append(cube(f'{name}_t{i}', (0.10, d, 0.022), (cx - w / 2 + 0.05 + i * (w - 0.1) / 6, cy, z0 + 0.133), M['wood']))
    for j, yy in enumerate((-d / 2 + 0.05, 0, d / 2 - 0.05)):
        parts.append(cube(f'{name}_s{j}', (w, 0.10, 0.022), (cx, cy + yy, z0 + 0.111), M['wood']))
        for i, xx in enumerate((-w / 2 + 0.05, 0, w / 2 - 0.05)):
            parts.append(cube(f'{name}_b{j}{i}', (0.10, 0.10, 0.078), (cx + xx, cy + yy, z0 + 0.061), M['wood']))
        parts.append(cube(f'{name}_u{j}', (w, 0.10, 0.022), (cx, cy + yy, z0 + 0.011), M['wood']))
    for p in parts:
        v = p.location - Vector((cx, cy, 0))
        p.location = Vector((cx, cy, 0)) + Matrix.Rotation(yaw, 3, 'Z') @ v
        p.rotation_euler.z = yaw


for k in range(7):
    pallet(f'empty_pal_{k}', -3.4, 1.4, FZ + k * 0.146, yaw=0.06 + rng.uniform(-0.03, 0.03))
cube('out_pal', (0.8, 0.6, 0.144), (2.0, 0.9, FZ + 0.072), M['wood'])
cube('out_load', (0.8, 0.6, 0.62), (2.0, 0.9, FZ + 0.144 + 0.31), M['wrap'], bevel=0.02)
for k in range(4):
    cube(f'tote_{k}', (0.6, 0.4, 0.22), (-2.9, -0.4, FZ + 0.11 + k * 0.215), M['tote' if k % 2 else 'green'], bevel=0.01)
for k, (x, y) in enumerate(((3.6, 1.6), (-3.4, 1.9))):
    cyl(f'bollard_{k}', 0.06, 1.0, (x, y, FZ + 0.5), M['yellow'], bevel=0.01)
cyl('bin', 0.25, 0.75, (3.2, -0.8, FZ + 0.375), M['dark_steel'])
cyl('extinguisher', 0.075, 0.55, (-0.5, 3.79, FZ + 1.2), M['red'])
# safety laser scanner by the lift table
cube('scanner', (0.10, 0.10, 0.15), (1.05, -0.30, FZ + 0.075), M['yellow'], bevel=0.008)
cyl('scanner_win', 0.045, 0.05, (1.05, -0.30, FZ + 0.17), M['black_plastic'])

# world: Blender's bundled interior HDRI, dim, for reflections
world = bpy.data.worlds.new('World'); scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
wn = world.node_tree.nodes
env = wn.new('ShaderNodeTexEnvironment')
hdr = None
for root in (bpy.utils.resource_path('LOCAL'), bpy.utils.resource_path('SYSTEM')):
    p = os.path.join(root, 'datafiles', 'studiolights', 'world', 'interior.exr')
    if os.path.exists(p):
        hdr = p
if hdr:
    env.image = bpy.data.images.load(hdr)
    world.node_tree.links.new(env.outputs['Color'], wn['Background'].inputs['Color'])
wn['Background'].inputs['Strength'].default_value = 0.35
if os.environ.get('HAZE', '1') == '1':
    vs = wn.new('ShaderNodeVolumeScatter'); vs.inputs['Density'].default_value = float(os.environ.get('HAZE_D', '0.012'))
    vs.inputs['Anisotropy'].default_value = 0.3
    world.node_tree.links.new(vs.outputs[0], wn['World Output'].inputs['Volume'])

# ------------------------------------------------------------------------------------ motion plan
def ease(s):
    # smooth start/stop like a trapezoid with jerk limiting
    return s * s * s * (s * (s * 6 - 15) + 10)


PICK = Vector((STOP_X, BELT_Y, BELT_Z + BOX[2]))
A = PICK + Vector((0, 0, 0.16))
LIFT = PICK + Vector((0, 0, 0.22))
CLEAR = 0.13


def place_tcp(slot):
    return Vector((slot[0], slot[1], PAL_TOP + BOX[2] * 2))


prev_slot = (SLOTS_X[2], SLOTS_Y[1])
plan_slots = [(SLOTS_X[1], SLOTS_Y[0]), (SLOTS_X[1], SLOTS_Y[1])]

q_cache = {}


def ik(p, yaw, seed):
    q, e = arm.ik(down(p, yaw), seed)
    if e > 1e-4:
        raise RuntimeError(f'IK failed at {tuple(p)} err {e}')
    return np.array(wrap_near(q, seed))


# a single absolute timeline in seconds; segments produce joint angles
segments = []  # (t0, t1, fn(t) -> q, event)


def linear_seg(p0, p1, yaw, dur, seed):
    n = max(2, int(dur * FPS * 2))
    qs = [None] * (n + 1)
    s = seed
    for i in range(n + 1):
        u = ease(i / n)
        s = ik(p0.lerp(p1, u), yaw, s)
        qs[i] = s
    qs = np.array(qs)

    def f(t):
        x = min(max(t / dur, 0), 1) * n
        i = min(int(x), n - 1)
        return qs[i] + (qs[i + 1] - qs[i]) * (x - i)
    return f, qs[-1]


def joint_seg(q0, q1, dur):
    def f(t):
        return q0 + (q1 - q0) * ease(min(max(t / dur, 0), 1))
    return f, q1


def hold(q, dur):
    return (lambda t: q), q


timeline = []
t = 0.0
qA = ik(A, 0.0, seed_for(A))
_s1 = place_tcp(plan_slots[0]) + Vector((0, 0, CLEAR))
q_s1 = np.array(wrap_near(ik(_s1, 0.0, seed_for(_s1)), qA))
q_place_prev = ik(place_tcp(prev_slot) + Vector((0, 0, CLEAR)), 0.0, q_s1)
# the previous cycle's return, of which the clip shows the last part
RET = 1.10
f, _ = joint_seg(q_place_prev, qA, RET)
timeline.append((t, RET, f, None)); t += RET
picks, releases = [], []
q = qA
for slot in plan_slots:
    f, q = linear_seg(A, PICK, 0.0, 0.45, q); timeline.append((t, 0.45, f, None)); t += 0.45
    f, q = hold(q, 0.22); timeline.append((t, 0.22, f, 'grip')); picks.append(t + 0.08); t += 0.22
    f, q = linear_seg(PICK, LIFT, 0.0, 0.40, q); timeline.append((t, 0.40, f, None)); t += 0.40
    above = place_tcp(slot) + Vector((0, 0, CLEAR))
    q_above = ik(above, 0.0, seed_for(above))
    q_above = np.array(wrap_near(q_above, q))
    f, q = joint_seg(q, q_above, 1.25); timeline.append((t, 1.25, f, None)); t += 1.25
    f, q = linear_seg(above, place_tcp(slot), 0.0, 0.50, q); timeline.append((t, 0.50, f, None)); t += 0.50
    f, q = hold(q, 0.20); timeline.append((t, 0.20, f, 'release')); releases.append((t + 0.10, slot)); t += 0.20
    f, q = linear_seg(place_tcp(slot), above, 0.0, 0.35, q); timeline.append((t, 0.35, f, None)); t += 0.35
    f, q = joint_seg(q, qA, 1.10); timeline.append((t, 1.10, f, None)); t += 1.10
T_END = t
CLIP_T0 = 0.55  # the clip starts this far into the timeline (mid-return)


def q_at(tt):
    for (t0, d, f, _) in timeline:
        if tt <= t0 + d:
            return f(tt - t0)
    return timeline[-1][2](timeline[-1][1])


# sample per frame (+ smoothing to blend corners like a UR blend radius)
times = [CLIP_T0 + (fr - 1) / FPS for fr in range(1, N_FRAMES + 1)]
Q = np.array([q_at(tt) for tt in times])
pad = 4
Qp = np.vstack([np.repeat(Q[:1], pad, 0), Q, np.repeat(Q[-1:], pad, 0)])
k = np.exp(-0.5 * (np.arange(-pad, pad + 1) / 1.6) ** 2); k /= k.sum()
Qs = np.array([np.convolve(Qp[:, j], k, mode='valid') for j in range(6)]).T
# keep the grip/release poses exact
for fr, tt in enumerate(times):
    for (t0, d, f, ev) in timeline:
        if ev and t0 <= tt <= t0 + d:
            Qs[fr] = f(tt - t0)
print('timeline', round(T_END, 2), 's; clip', N_FRAMES / FPS, 's; max joint step deg/frame',
      round(float(np.degrees(np.abs(np.diff(Qs, axis=0)).max())), 2))

for fr in range(N_FRAMES):
    arm.set(Qs[fr])
    for o in joints:
        o.keyframe_insert('rotation_quaternion', frame=fr + 1)

# ------------------------------------------------------------------------------------ box motion
FLIP = Matrix.Rotation(math.pi, 4, 'X')


def tcp_box(qv):
    return arm.fk(qv) @ Matrix.Translation((0, 0, BOX[2] / 2)) @ FLIP


GAP = 0.012
# queue on the belt at clip start: front at the stop, one touching behind, more arriving
belt_boxes = []
starts = [STOP_X, STOP_X - BOX[0] - GAP, STOP_X - 1.15, STOP_X - 2.3, STOP_X - 3.3, STOP_X - 4.6]
for i, x in enumerate(starts):
    b = make_box(f'belt_box_{i}')
    belt_boxes.append({'obj': b, 'x': x, 'state': 'belt', 'yaw': rng.uniform(-0.03, 0.03), 'dy': rng.uniform(-0.01, 0.01)})

pick_frames = [round((tp - CLIP_T0) * FPS) + 1 for tp in picks]
release_frames = [(round((tr - CLIP_T0) * FPS) + 1, s) for tr, s in releases]
carrying = None
dt = 1 / FPS
for fr in range(1, N_FRAMES + 1):
    if fr in pick_frames:
        front = min((bb for bb in belt_boxes if bb['state'] == 'belt'), key=lambda bb: -bb['x'])
        front['state'] = 'held'; carrying = front
    for rf, slot in release_frames:
        if fr == rf and carrying:
            carrying['state'] = 'placed'; carrying = None
    # accumulate on the belt
    ahead_limit = STOP_X
    for bb in sorted([bb for bb in belt_boxes if bb['state'] == 'belt'], key=lambda bb: -bb['x']):
        bb['x'] = min(bb['x'] + BELT_V * dt, ahead_limit)
        ahead_limit = bb['x'] - BOX[0] - GAP
    for bb in belt_boxes:
        o = bb['obj']
        if bb['state'] == 'belt':
            o.matrix_world = Matrix.Translation((bb['x'], BELT_Y + bb['dy'], BELT_Z + BOX[2] / 2)) @ Matrix.Rotation(bb['yaw'], 4, 'Z')
        elif bb['state'] == 'held':
            o.matrix_world = tcp_box(Qs[fr - 1])
        # placed: keep the last pose
        o.keyframe_insert('location', frame=fr)
        o.keyframe_insert('rotation_euler', frame=fr)
    # belt texture
    mp.inputs['Location'].default_value = (-(fr - 1) * dt * BELT_V, 0, 0)
    mp.inputs['Location'].keyframe_insert('default_value', frame=fr)

import json
json.dump({'fps': FPS, 'frames': N_FRAMES, 'picks': pick_frames, 'releases': [rf for rf, _ in release_frames],
           'speed': [float(v) for v in np.abs(np.diff(Qs, axis=0, prepend=Qs[:1])).sum(axis=1) * FPS]},
          open(os.path.join(WORK, 'events.json'), 'w'))
# vacuum LED colour switch via two LEDs
led_g = cube('tool_led_g', (0.004, 0.012, 0.006), (0.0485, 0.0, 0.14), M['led_green']); led_g.parent = wrist3
for fr in range(1, N_FRAMES + 1):
    holding = any(pf <= fr < rf for pf, (rf, _) in zip(pick_frames, release_frames))
    led_g.hide_render = not holding
    led.hide_render = holding
    led_g.keyframe_insert('hide_render', frame=fr)
    led.keyframe_insert('hide_render', frame=fr)

# ---------------------------------------------------------------------------------- handheld camera
cam_d = bpy.data.cameras.new('Phone')
cam_d.sensor_width = 36.0
cam_d.lens = float(os.environ.get('LENS', '26'))
cam_d.dof.use_dof = True
cam_d.dof.aperture_fstop = 4.0
cam = bpy.data.objects.new('Phone', cam_d)
link(cam)
scene.camera = cam
look_at = Vector(tuple(float(v) for v in os.environ.get('LOOK', '0.20,-0.10,0.0').split(',')))
r = np.random.default_rng(3)


def smooth_noise(n, cutoff_frames, amp):
    x = r.normal(size=n + 200)
    w = np.exp(-0.5 * (np.arange(-100, 101) / cutoff_frames) ** 2); w /= np.sqrt((w ** 2).sum())
    y = np.convolve(x, w, mode='valid')[:n]
    return y / (np.abs(y).max() + 1e-9) * amp


n = N_FRAMES
drift = [smooth_noise(n, 22, a) for a in (0.03, 0.02, 0.018)]
jit = [smooth_noise(n, 2.2, a) for a in (0.0012, 0.0012, 0.0010)]
rot_drift = [smooth_noise(n, 18, a) for a in (0.006, 0.004, 0.009)]
rot_jit = [smooth_noise(n, 1.6, a) for a in (0.0009, 0.0007, 0.0012)]
start = Vector(tuple(float(v) for v in os.environ.get('CAM0', '1.42,-1.95,0.60').split(',')))
end = start + Vector((-0.16, 0.12, -0.02))
for fr in range(n):
    u = fr / (n - 1)
    pos = start.lerp(end, u * u * (3 - 2 * u))
    pos += Vector((drift[0][fr] + jit[0][fr], drift[1][fr] + jit[1][fr], drift[2][fr] + jit[2][fr]))
    tgt = look_at + Vector((0.05 * math.sin(u * 2.1), 0, 0.02 * math.sin(u * 3.3)))
    d = (tgt - pos).normalized()
    rotq = d.to_track_quat('-Z', 'Y')
    e = rotq.to_euler()
    e.x += rot_drift[0][fr] + rot_jit[0][fr]
    e.y += rot_drift[1][fr] + rot_jit[1][fr]
    e.z += rot_drift[2][fr] + rot_jit[2][fr]
    e.y += 0.012  # phone held a little off level
    cam.location = pos
    cam.rotation_euler = e
    cam.keyframe_insert('location', frame=fr + 1)
    cam.keyframe_insert('rotation_euler', frame=fr + 1)
    # autofocus: settles on the robot, hunts briefly at the start
    fd = (Vector((0.2, -0.05, 0.0)) - pos).length
    if fr < 14:
        fd += 0.9 * math.exp(-fr / 4.0) * math.cos(fr * 0.9)
    cam_d.dof.focus_distance = fd
    cam_d.dof.keyframe_insert('focus_distance', frame=fr + 1)

# ------------------------------------------------------------------------------------------ render
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for dv in prefs.devices:
        dv.use = True
    scene.cycles.device = 'GPU'
except Exception as ex:
    print('GPU setup failed', ex)
scene.cycles.samples = SAMPLES
scene.cycles.adaptive_threshold = 0.03
scene.cycles.use_denoising = True
try:
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    scene.cycles.denoising_use_gpu = True
except Exception:
    pass
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 3
scene.cycles.glossy_bounces = 3
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False
scene.cycles.sample_clamp_indirect = 6
scene.cycles.volume_bounces = 0
scene.cycles.volume_step_rate = 4.0
scene.render.use_motion_blur = True
scene.render.motion_blur_shutter = 0.42
scene.render.use_persistent_data = True
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = PCT
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_depth = '8'
scene.view_settings.view_transform = 'AgX'
for lk in ('AgX - Medium High Contrast', 'Medium High Contrast', 'AgX - Punchy', 'Punchy'):
    try:
        scene.view_settings.look = lk
        break
    except Exception:
        continue
scene.view_settings.exposure = float(os.environ.get('EXPO', '-0.9'))
print('look', scene.view_settings.look)

if MODE == 'plan':
    sys.exit(0)
if MODE == 'still':
    scene.frame_set(STILL_FRAME)
    scene.render.filepath = os.path.join(WORK, f'still_{STILL_FRAME}.png')
    bpy.ops.render.render(write_still=True)
elif MODE == 'save':
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'cell.blend'))
else:
    os.makedirs(OUT, exist_ok=True)
    scene.render.filepath = os.path.join(OUT, 'f_')
    if len(argv) > 4:
        scene.frame_start = int(argv[4]); scene.frame_end = int(argv[5])
    bpy.ops.render.render(animation=True)
