#!/usr/bin/env python3
"""构境画布（ArchCanvas）Blender 独立建模与原生渲染工作进程（兼容 Blender 4.x / 5.x）。

调用方式：
blender --background --factory-startup --disable-autoexec --python blender_worker.py -- --request <request.json>

严格遵循总规格：
- §5.6: 参数化构建有厚度墙体、楼板、揭顶顶板集合；流形性、法线、体积与包围盒实测。
- §7.2: 统一建筑 Z-up 相机矩阵与投影参数。
- §15.1: 按节点类型（BSDF_PRINCIPLED）查找着色节点，按运行版本动态探测渲染引擎枚举。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

import bmesh  # type: ignore
import bpy  # type: ignore
from mathutils import Matrix, Vector  # type: ignore

# 允许从 workers/export/ 导入独立 COLLADA 1.4.1 序列化器
_EXPORT_DIR = str(Path(__file__).resolve().parent.parent / "export")
if _EXPORT_DIR not in sys.path:
    sys.path.insert(0, _EXPORT_DIR)
from dae_exporter import write_collada_141  # type: ignore


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def read_png_dimensions(png_path: Path) -> tuple[int, int]:
    """从 PNG 文件头（IHDR）实测真实像素尺寸，不依赖外部库。"""
    data = png_path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"文件不是有效的 PNG 图像：{png_path}")
    width, height = struct.unpack(">II", data[16:24])
    return int(width), int(height)


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def get_or_create_collection(name: str) -> Any:
    if name in bpy.data.collections:
        return bpy.data.collections[name]
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def make_material(name: str, rgba: tuple[float, float, float, float], roughness: float = 0.65) -> Any:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = rgba
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = roughness
    return mat


def create_box_object(
    name: str,
    collection: Any,
    length: float,
    thickness: float,
    height: float,
    center: tuple[float, float, float],
    rot_z: float,
    material: Any,
    element_id: str,
    element_kind: str,
) -> Any:
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(length, thickness, height), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    obj.location = Vector(center)
    obj.rotation_euler = (0.0, 0.0, rot_z)
    obj["archcanvas_element_id"] = element_id
    obj["archcanvas_element_kind"] = element_kind
    if material is not None:
        obj.data.materials.append(material)
    collection.objects.link(obj)
    return obj


def validate_solid_object(obj: Any) -> dict[str, Any]:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    non_manifold_edges = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    volume = float(bm.calc_volume(signed=True))
    bm.free()

    world_corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    xs = [v.x for v in world_corners]
    ys = [v.y for v in world_corners]
    zs = [v.z for v in world_corners]

    return {
        "objectName": obj.name,
        "elementId": obj.get("archcanvas_element_id", ""),
        "kind": obj.get("archcanvas_element_kind", ""),
        "isManifold": non_manifold_edges == 0,
        "nonManifoldEdges": non_manifold_edges,
        "volumeM3": round(abs(volume), 6),
        "positiveSignedVolume": volume > 0,
        "bbox": {
            "minX": round(min(xs), 6),
            "maxX": round(max(xs), 6),
            "minY": round(min(ys), 6),
            "maxY": round(max(ys), 6),
            "minZ": round(min(zs), 6),
            "maxZ": round(max(zs), 6),
        },
    }


def select_available_render_engine(requested: str) -> str:
    scene = bpy.context.scene
    enum_items = [item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items]
    req_upper = requested.upper()
    if req_upper in enum_items:
        return req_upper
    if req_upper == "EEVEE":
        for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"):
            if cand in enum_items:
                return cand
    for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"):
        if cand in enum_items:
            return cand
    return enum_items[0]


def ensure_studio_lighting() -> None:
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("ArchCanvasWorld")
    scene.world.use_nodes = True
    bg = next((n for n in scene.world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg is not None:
        bg.inputs["Color"].default_value = (0.78, 0.83, 0.90, 1.0)
        bg.inputs["Strength"].default_value = 0.85

    has_light = any(obj.type == "LIGHT" for obj in bpy.data.objects)
    if not has_light:
        light_col = get_or_create_collection("Lighting")
        sun_data = bpy.data.lights.new(name="ArchSun", type="SUN")
        sun_data.energy = 3.2
        sun_obj = bpy.data.objects.new(name="ArchSun", object_data=sun_data)
        sun_obj.rotation_euler = (math.radians(48.0), math.radians(15.0), math.radians(-35.0))
        light_col.objects.link(sun_obj)


def run_build_model(inputs: dict[str, Any], parameters: dict[str, Any], output_dir: Path, task_id: str) -> Path:
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "load_semantics",
            "completed": 1,
            "total": 4,
            "message": "正在读取结构化建筑语义数据",
        }
    )

    semantics_path = Path(inputs["semanticsPath"])
    if not semantics_path.is_file():
        raise FileNotFoundError(f"建筑语义文件不存在：{semantics_path}")
    semantics = json.loads(semantics_path.read_text(encoding="utf-8"))

    storeys = max(1, int(parameters.get("storeys", 1)))
    floor_height_m = float(parameters.get("floorHeightM", 4.5))
    if floor_height_m <= 0.5:
        raise ValueError("层高 floorHeightM 必须大于 0.5 米。")
    white_wall_mode = bool(parameters.get("whiteWallMode", True))
    default_door_height_m = min(float(parameters.get("defaultDoorHeightM", 2.1)), floor_height_m - 0.1)
    include_roof_cap = bool(parameters.get("includeRoofCap", True))
    roof_style = str(parameters.get("roofStyle", "flat"))  # flat | gable
    ridge_height_m = float(parameters.get("ridgeHeightM", 1.8))
    eave_overhang_m = float(parameters.get("eaveOverhangM", 0.6))
    include_steps = bool(parameters.get("includeSteps", False))
    include_ramp = bool(parameters.get("includeRamp", False))
    ramp_start_z = float(parameters.get("rampStartElevationM", 0.30))
    ramp_end_z = float(parameters.get("rampEndElevationM", 0.0))
    remove_rail_sides = [str(s) for s in parameters.get("removeRailSides", [])]
    include_drainage_apron = bool(parameters.get("includeDrainageApron", False))
    include_grille = bool(parameters.get("includeGrille", False))
    grille_bottom_z = float(parameters.get("grilleBottomElevationM", 0.0))

    clear_scene()
    walls_col = get_or_create_collection("Walls")
    slabs_col = get_or_create_collection("Slabs")
    roof_col = get_or_create_collection("Roof_Cap")
    site_attach_col = get_or_create_collection("Site_Attachments")

    wall_mat = make_material(
        "Mat_Exterior_Wall",
        (0.93, 0.93, 0.91, 1.0) if white_wall_mode else (0.82, 0.80, 0.76, 1.0),
        roughness=0.72,
    )
    slab_mat = make_material("Mat_Floor_Slab", (0.72, 0.73, 0.75, 1.0), roughness=0.80)
    roof_mat = make_material("Mat_Roof_Cap", (0.55, 0.57, 0.60, 1.0) if roof_style == "gable" else (0.88, 0.89, 0.90, 1.0), roughness=0.70)
    apron_mat = make_material("Mat_Drainage_Apron", (0.62, 0.63, 0.64, 1.0), roughness=0.88)
    grille_mat = make_material("Mat_Grille", (0.74, 0.76, 0.79, 1.0), roughness=0.35)
    step_mat = make_material("Mat_Step_Paving", (0.78, 0.76, 0.72, 1.0), roughness=0.75)
    rail_mat = make_material("Mat_Handrail", (0.68, 0.70, 0.73, 1.0), roughness=0.30)

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "build_geometry",
            "completed": 2,
            "total": 4,
            "message": f"正在生成 {storeys} 层白模（层高 {floor_height_m} m）",
        }
    )

    elements = semantics.get("elements", [])
    created_solids: list[Any] = []
    wall_objects: list[Any] = []

    for storey_idx in range(storeys):
        z_base_offset = storey_idx * floor_height_m
        for elem in elements:
            kind = elem.get("kind")
            geom = elem.get("geometry", {})
            eid = str(elem.get("id", "elem"))

            if kind == "wall":
                p1 = geom["start"]
                p2 = geom["end"]
                dx = float(p2[0]) - float(p1[0])
                dy = float(p2[1]) - float(p1[1])
                length = math.hypot(dx, dy)
                if length < 0.05:
                    continue
                thickness = max(0.05, float(geom.get("thicknessM", 0.24)))
                base_z = float(geom.get("baseElevationM", 0.0)) + z_base_offset
                cx = 0.5 * (float(p1[0]) + float(p2[0]))
                cy = 0.5 * (float(p1[1]) + float(p2[1]))
                cz = base_z + 0.5 * floor_height_m
                rot_z = math.atan2(dy, dx)
                obj = create_box_object(
                    name=f"{eid}_L{storey_idx + 1}",
                    collection=walls_col,
                    length=length,
                    thickness=thickness,
                    height=floor_height_m,
                    center=(cx, cy, cz),
                    rot_z=rot_z,
                    material=wall_mat,
                    element_id=eid,
                    element_kind="wall",
                )
                created_solids.append(obj)
                wall_objects.append(obj)

            elif kind == "opening" and geom.get("openingType") == "door":
                # 在门洞上方建立过梁，保持墙顶标高连续一致
                hinge = geom.get("hinge", [0.0, 0.0])
                width_m = float(geom.get("widthM", 1.0))
                lintel_h = floor_height_m - default_door_height_m
                if lintel_h > 0.05 and width_m > 0.1:
                    thickness = 0.24
                    cx = float(hinge[0]) + 0.5 * width_m
                    cy = max(0.5 * thickness, float(hinge[1]) - 0.5 * thickness)
                    cz = z_base_offset + default_door_height_m + 0.5 * lintel_h
                    obj = create_box_object(
                        name=f"{eid}_lintel_L{storey_idx + 1}",
                        collection=walls_col,
                        length=width_m,
                        thickness=thickness,
                        height=lintel_h,
                        center=(cx, cy, cz),
                        rot_z=0.0,
                        material=wall_mat,
                        element_id=eid,
                        element_kind="opening_lintel",
                    )
                    created_solids.append(obj)
                    wall_objects.append(obj)

            elif kind == "slab":
                poly = geom.get("polygon", [])
                if len(poly) >= 3:
                    xs = [float(p[0]) for p in poly]
                    ys = [float(p[1]) for p in poly]
                    sx = max(xs) - min(xs)
                    sy = max(ys) - min(ys)
                    st = max(0.05, float(geom.get("thicknessM", 0.15)))
                    elev = float(geom.get("elevationM", 0.0)) + z_base_offset
                    obj = create_box_object(
                        name=f"{eid}_L{storey_idx + 1}",
                        collection=slabs_col,
                        length=sx,
                        thickness=sy,
                        height=st,
                        center=(0.5 * (min(xs) + max(xs)), 0.5 * (min(ys) + max(ys)), elev - 0.5 * st),
                        rot_z=0.0,
                        material=slab_mat,
                        element_id=eid,
                        element_kind="slab",
                    )
                    created_solids.append(obj)

                    if include_roof_cap and storey_idx == storeys - 1:
                        roof_top = z_base_offset + floor_height_m
                        if roof_style == "gable":
                            # 真实双坡屋顶（屋脊 + 双坡面 + 出檐，总规格 §5.6 & B03）
                            x0 = min(xs) - eave_overhang_m
                            x1 = max(xs) + eave_overhang_m
                            y0 = min(ys) - eave_overhang_m
                            y1 = max(ys) + eave_overhang_m
                            ym = 0.5 * (y0 + y1)
                            eave_z = roof_top
                            ridge_z = roof_top + max(0.3, ridge_height_m)

                            mesh = bpy.data.meshes.new("Gable_Roof_Mesh")
                            bm = bmesh.new()
                            v0 = bm.verts.new((x0, y0, eave_z))
                            v1 = bm.verts.new((x1, y0, eave_z))
                            v2 = bm.verts.new((x1, y1, eave_z))
                            v3 = bm.verts.new((x0, y1, eave_z))
                            v4 = bm.verts.new((x0, ym, ridge_z))
                            v5 = bm.verts.new((x1, ym, ridge_z))
                            bm.faces.new((v0, v3, v2, v1))  # bottom
                            bm.faces.new((v0, v1, v5, v4))  # south slope
                            bm.faces.new((v2, v3, v4, v5))  # north slope
                            bm.faces.new((v0, v4, v3))      # west gable
                            bm.faces.new((v1, v2, v5))      # east gable
                            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
                            bm.to_mesh(mesh)
                            bm.free()

                            roof_obj = bpy.data.objects.new("Gable_Roof_Main", mesh)
                            roof_obj["archcanvas_element_id"] = "roof-gable-main"
                            roof_obj["archcanvas_element_kind"] = "roof"
                            roof_obj.data.materials.append(roof_mat)
                            roof_col.objects.link(roof_obj)
                            created_solids.append(roof_obj)
                        else:
                            roof_t = 0.12
                            roof_obj = create_box_object(
                                name="Roof_Cap_Slab",
                                collection=roof_col,
                                length=sx,
                                thickness=sy,
                                height=roof_t,
                                center=(0.5 * (min(xs) + max(xs)), 0.5 * (min(ys) + max(ys)), roof_top - 0.5 * roof_t),
                                rot_z=0.0,
                                material=roof_mat,
                                element_id="roof-cap-main",
                                element_kind="roof",
                            )
                            created_solids.append(roof_obj)

                    # 附属地面与建筑构件（散水、入口台阶、连续坡道、分边扶手、落地格栅，总规格 B04-B07）
                    if storey_idx == 0:
                        if include_drainage_apron:
                            apron_w = 0.8
                            apron_obj = create_box_object(
                                name="Drainage_Apron_Perimeter",
                                collection=site_attach_col,
                                length=sx + 2 * apron_w,
                                thickness=sy + 2 * apron_w,
                                height=0.10,
                                center=(0.5 * (min(xs) + max(xs)), 0.5 * (min(ys) + max(ys)), elev - 0.20),
                                rot_z=0.0,
                                material=apron_mat,
                                element_id="drainage-apron-main",
                                element_kind="drainage_apron",
                            )
                            created_solids.append(apron_obj)

                        if include_steps:
                            # 入口台阶（位于南侧中部，独立于坡道）
                            for step_i in range(3):
                                sh = 0.15
                                sr = 0.32
                                step_obj = create_box_object(
                                    name=f"Entrance_Step_{step_i + 1}",
                                    collection=site_attach_col,
                                    length=1.8,
                                    thickness=sr,
                                    height=sh * (3 - step_i),
                                    center=(0.5 * (min(xs) + max(xs)), min(ys) - (step_i + 0.5) * sr, elev - 0.15 + 0.5 * sh * (3 - step_i) - 0.30),
                                    rot_z=0.0,
                                    material=step_mat,
                                    element_id=f"step-main-{step_i + 1}",
                                    element_kind="step",
                                )
                                created_solids.append(step_obj)

                        if include_ramp:
                            # 连续坡道（位于南侧左端，端部高程与室外地坪接齐，B05）
                            rx0, rx1 = min(xs) + 0.2, min(xs) + 2.8
                            ry_wall, ry_out = min(ys), min(ys) - 1.2
                            mesh = bpy.data.meshes.new("Entrance_Ramp_Mesh")
                            bm = bmesh.new()
                            b0 = bm.verts.new((rx0, ry_out, ramp_end_z))
                            b1 = bm.verts.new((rx1, ry_out, ramp_end_z))
                            b2 = bm.verts.new((rx1, ry_wall, ramp_end_z))
                            b3 = bm.verts.new((rx0, ry_wall, ramp_end_z))
                            t0 = bm.verts.new((rx0, ry_out, ramp_end_z + 0.05))
                            t1 = bm.verts.new((rx1, ry_out, ramp_start_z))
                            t2 = bm.verts.new((rx1, ry_wall, ramp_start_z))
                            t3 = bm.verts.new((rx0, ry_wall, ramp_end_z + 0.05))
                            bm.faces.new((b0, b3, b2, b1))
                            bm.faces.new((t0, t1, t2, t3))
                            bm.faces.new((b0, b1, t1, t0))
                            bm.faces.new((b2, b3, t3, t2))
                            bm.faces.new((b1, b2, t2, t1))
                            bm.faces.new((b3, b0, t0, t3))
                            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
                            bm.to_mesh(mesh)
                            bm.free()

                            ramp_obj = bpy.data.objects.new("Entrance_Ramp_West", mesh)
                            ramp_obj["archcanvas_element_id"] = "ramp-west-01"
                            ramp_obj["archcanvas_element_kind"] = "ramp"
                            ramp_obj.data.materials.append(step_mat)
                            site_attach_col.objects.link(ramp_obj)
                            created_solids.append(ramp_obj)

                            # 分边侧扶手（outer / wall_side 可分别删除，B04）
                            for side, y_pos in (("outer", ry_out + 0.05), ("wall_side", ry_wall - 0.05)):
                                if side in remove_rail_sides:
                                    continue
                                rail_obj = create_box_object(
                                    name=f"Ramp_Rail_{side}",
                                    collection=site_attach_col,
                                    length=rx1 - rx0,
                                    thickness=0.05,
                                    height=0.95,
                                    center=(0.5 * (rx0 + rx1), y_pos, ramp_end_z + 0.5 * (ramp_start_z - ramp_end_z) + 0.475),
                                    rot_z=0.0,
                                    material=rail_mat,
                                    element_id=f"rail-ramp-{side}",
                                    element_kind="rail",
                                )
                                created_solids.append(rail_obj)

                        if include_grille:
                            # 银灰格栅（底标高严格对齐目标地坪，不悬空，B07）
                            grille_h = floor_height_m - grille_bottom_z
                            for g_idx in range(4):
                                gx = max(xs) + 0.08
                                gy = min(ys) + 0.8 + g_idx * 0.45
                                g_obj = create_box_object(
                                    name=f"Facade_Grille_{g_idx + 1}",
                                    collection=site_attach_col,
                                    length=0.06,
                                    thickness=0.14,
                                    height=grille_h,
                                    center=(gx, gy, grille_bottom_z + 0.5 * grille_h),
                                    rot_z=0.0,
                                    material=grille_mat,
                                    element_id=f"grille-east-{g_idx + 1}",
                                    element_kind="grille",
                                )
                                created_solids.append(g_obj)

    bpy.context.view_layer.update()
    ensure_studio_lighting()

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "validate_and_export",
            "completed": 3,
            "total": 4,
            "message": "正在执行流形/法线/体积检查并导出 BLEND 与 GLB",
        }
    )

    solid_checks = [validate_solid_object(obj) for obj in created_solids]
    all_manifold = all(c["isManifold"] for c in solid_checks)
    all_positive_vol = all(c["volumeM3"] > 0 for c in solid_checks)

    wall_checks = [c for c in solid_checks if c["kind"] in ("wall", "opening_lintel")]
    ref_checks = wall_checks if wall_checks else solid_checks

    min_x = min(c["bbox"]["minX"] for c in ref_checks) if ref_checks else 0.0
    max_x = max(c["bbox"]["maxX"] for c in ref_checks) if ref_checks else 0.0
    min_y = min(c["bbox"]["minY"] for c in ref_checks) if ref_checks else 0.0
    max_y = max(c["bbox"]["maxY"] for c in ref_checks) if ref_checks else 0.0
    min_z = min(c["bbox"]["minZ"] for c in ref_checks) if ref_checks else 0.0
    max_z = max(c["bbox"]["maxZ"] for c in ref_checks) if ref_checks else 0.0

    blend_path = output_dir / "model.blend"
    glb_path = output_dir / "preview.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB", export_yup=True)

    emit(
        {
            "type": "artifact",
            "taskId": task_id,
            "kind": "blend",
            "path": str(blend_path),
            "sha256": sha256_file(blend_path),
        }
    )
    emit(
        {
            "type": "artifact",
            "taskId": task_id,
            "kind": "glb",
            "path": str(glb_path),
            "sha256": sha256_file(glb_path),
        }
    )

    report = {
        "schemaVersion": 1,
        "operation": "build_model",
        "modelVersionId": inputs.get("modelVersionId", ""),
        "blenderVersion": bpy.app.version_string,
        "unit": "m",
        "upAxis": "Z",
        "worldOriginOffset": semantics.get("worldOriginOffset", [0.0, 0.0, 0.0]),
        "parameters": {
            "storeys": storeys,
            "floorHeightM": floor_height_m,
            "whiteWallMode": white_wall_mode,
            "defaultDoorHeightM": default_door_height_m,
            "includeRoofCap": include_roof_cap,
        },
        "measuredBoundsM": {
            "minX": round(min_x, 4),
            "maxX": round(max_x, 4),
            "minY": round(min_y, 4),
            "maxY": round(max_y, 4),
            "minZ": round(min_z, 4),
            "maxZ": round(max_z, 4),
            "widthM": round(max_x - min_x, 4),
            "depthM": round(max_y - min_y, 4),
            "wallTopElevationM": round(max_z, 4),
            "heightM": round(max_z - min_z, 4),
        },
        "validation": {
            "passed": all_manifold and all_positive_vol and len(solid_checks) > 0,
            "solidCount": len(solid_checks),
            "allManifold": all_manifold,
            "allPositiveVolume": all_positive_vol,
            "railSidesPresent": [c["objectName"] for c in solid_checks if c["kind"] == "rail"],
            "roofMaxZ": round(
                max((c["bbox"]["maxZ"] for c in solid_checks if c["kind"] == "roof"), default=max_z),
                4,
            ),
            "grilleMinZ": (
                round(min(c["bbox"]["minZ"] for c in solid_checks if c["kind"] == "grille"), 4)
                if any(c["kind"] == "grille" for c in solid_checks)
                else None
            ),
            "rampMinZ": (
                round(min(c["bbox"]["minZ"] for c in solid_checks if c["kind"] == "ramp"), 4)
                if any(c["kind"] == "ramp" for c in solid_checks)
                else None
            ),
        },
        "assumptions": list(semantics.get("assumptions", []))
        + [f"白模门洞过梁底标高暂定 {default_door_height_m} m（未在平面图注明）"],
        "blendPath": str(blend_path),
        "glbPath": str(glb_path),
        "blendSha256": sha256_file(blend_path),
        "glbSha256": sha256_file(glb_path),
    }

    report_path = output_dir / "validation_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def hex_to_linear_rgba(hex_str: str) -> tuple[float, float, float, float]:
    cleaned = hex_str.strip().lstrip("#")
    if len(cleaned) != 6:
        return (0.9, 0.9, 0.9, 1.0)
    r = int(cleaned[0:2], 16) / 255.0
    g = int(cleaned[2:4], 16) / 255.0
    b = int(cleaned[4:6], 16) / 255.0
    # sRGB -> linear 近似转换，保证 Blender 渲染色值一致
    def srgb_to_lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b), 1.0)


def apply_material_overrides(overrides: list[dict[str, Any]]) -> list[str]:
    """按材料槽名称独立修改材质颜色/粗糙度，不改动建筑几何与门窗开口（总规格 §6.1 & G2）。"""
    slot_to_mat_name = {
        "exterior_wall": "Mat_Exterior_Wall",
        "floor_slab": "Mat_Floor_Slab",
        "roof_cap": "Mat_Roof_Cap",
        "grille": "Mat_Grille",
        "drainage_apron": "Mat_Drainage_Apron",
        "step_paving": "Mat_Step_Paving",
    }
    applied: list[str] = []
    for ov in overrides:
        slot = str(ov.get("slotName", "")).strip()
        color_hex = str(ov.get("baseColorHex", "")).strip()
        roughness = ov.get("roughness")
        mat_name = slot_to_mat_name.get(slot, slot)
        mat = bpy.data.materials.get(mat_name)
        if mat is None or not mat.use_nodes:
            continue
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        if color_hex:
            bsdf.inputs["Base Color"].default_value = hex_to_linear_rgba(color_hex)
        if roughness is not None and "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = float(roughness)
        applied.append(f"{slot}:{color_hex}")
    return applied


def run_native_render(inputs: dict[str, Any], parameters: dict[str, Any], output_dir: Path, task_id: str) -> Path:
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "load_model",
            "completed": 1,
            "total": 3,
            "message": "正在加载冻结的模型版本 (.blend)",
        }
    )

    blend_path = Path(inputs["blendPath"])
    if not blend_path.is_file():
        raise FileNotFoundError(f"模型文件不存在：{blend_path}")

    camera_snapshot = inputs["cameraSnapshot"]
    bpy.ops.wm.open_mainfile(filepath=str(blend_path), load_ui=False)
    ensure_studio_lighting()

    # 独立材质槽覆盖（不改变几何与门窗数量）
    material_overrides = inputs.get("materialOverrides") or []
    applied_materials = apply_material_overrides(material_overrides)

    # 可选揭顶显示（仅影响本次渲染视图，不修改源模型文件）
    hide_roof = bool(parameters.get("hideRoofCap", False))
    if "Roof_Cap" in bpy.data.collections:
        bpy.data.collections["Roof_Cap"].hide_render = hide_roof

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new(name="ArchCanvasCamera")
    cam_obj = bpy.data.objects.new(name="ArchCanvasCamera", object_data=cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    # 列主序 16 项 matrixWorld -> Blender 行主序 4x4 Matrix
    m_col = [float(v) for v in camera_snapshot["matrixWorld"]]
    if len(m_col) != 16:
        raise ValueError("相机 matrixWorld 必须包含 16 个数值。")
    mat = Matrix(
        (
            (m_col[0], m_col[4], m_col[8], m_col[12]),
            (m_col[1], m_col[5], m_col[9], m_col[13]),
            (m_col[2], m_col[6], m_col[10], m_col[14]),
            (m_col[3], m_col[7], m_col[11], m_col[15]),
        )
    )
    cam_obj.matrix_world = mat

    proj = camera_snapshot.get("projection", "perspective")
    cam_data.clip_start = float(camera_snapshot.get("nearM", 0.1))
    cam_data.clip_end = float(camera_snapshot.get("farM", 500.0))

    if proj == "orthographic":
        cam_data.type = "ORTHO"
        ortho = camera_snapshot.get("orthographic") or {}
        cam_data.ortho_scale = float(ortho.get("widthM", 16.0))
    else:
        cam_data.type = "PERSP"
        persp = camera_snapshot.get("perspective") or {}
        cam_data.lens = float(persp.get("focalLengthMm", 35.0))
        cam_data.sensor_width = float(persp.get("sensorWidthMm", 36.0))
        cam_data.sensor_fit = "VERTICAL" if persp.get("sensorFit") == "vertical" else "HORIZONTAL"
        cam_data.shift_x = float(persp.get("shiftX", 0.0))
        cam_data.shift_y = float(persp.get("shiftY", 0.0))

    width_px = int(parameters.get("widthPx") or camera_snapshot.get("widthPx", 1280))
    height_px = int(parameters.get("heightPx") or camera_snapshot.get("heightPx", 720))

    scene.render.engine = select_available_render_engine(str(parameters.get("engine", "EEVEE")))
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = int(parameters.get("samples", 32))
    scene.render.resolution_x = width_px
    scene.render.resolution_y = height_px
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    out_png = output_dir / "beauty.png"
    scene.render.filepath = str(out_png)

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "rendering",
            "completed": 2,
            "total": 3,
            "message": f"正在使用 {scene.render.engine} 原生渲染 {width_px}x{height_px} PNG",
        }
    )

    bpy.ops.render.render(write_still=True)

    if not out_png.is_file():
        raise RuntimeError(f"Blender 渲染结束但未产出 PNG 文件：{out_png}")

    actual_w, actual_h = read_png_dimensions(out_png)
    png_sha = sha256_file(out_png)

    emit(
        {
            "type": "artifact",
            "taskId": task_id,
            "kind": "png",
            "path": str(out_png),
            "sha256": png_sha,
        }
    )

    report = {
        "schemaVersion": 1,
        "operation": "native_render",
        "origin": "native_render",
        "blenderVersion": bpy.app.version_string,
        "renderEngine": scene.render.engine,
        "actualFormat": "PNG",
        "actualWidthPx": actual_w,
        "actualHeightPx": actual_h,
        "cameraId": camera_snapshot.get("id", ""),
        "cameraName": camera_snapshot.get("name", ""),
        "hideRoofCap": hide_roof,
        "appliedMaterialOverrides": applied_materials,
        "pngPath": str(out_png),
        "pngSha256": png_sha,
    }
    report_path = output_dir / "render_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def run_export_model(inputs: dict[str, Any], parameters: dict[str, Any], output_dir: Path, task_id: str) -> Path:
    """从冻结模型导出真实 FBX / GLB / OBJ+MTL（不二次缩放，绝不改后缀伪造 SKP/MAX）。"""
    blend_path = Path(inputs["blendPath"])
    if not blend_path.is_file():
        raise FileNotFoundError(f"模型文件不存在：{blend_path}")

    formats = [str(f).lower() for f in parameters.get("formats", ["fbx", "glb", "obj"])]
    bpy.ops.wm.open_mainfile(filepath=str(blend_path), load_ui=False)

    exported: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for idx, fmt in enumerate(formats):
        emit(
            {
                "type": "progress",
                "taskId": task_id,
                "stage": f"export_{fmt}",
                "completed": idx,
                "total": len(formats),
                "message": f"正在导出 {fmt.upper()} 模型交换文件",
            }
        )
        if fmt == "fbx":
            out_fbx = output_dir / "model.fbx"
            bpy.ops.export_scene.fbx(
                filepath=str(out_fbx),
                global_scale=1.0,
                apply_unit_scale=True,
                apply_scale_options="FBX_SCALE_ALL",
                use_mesh_modifiers=True,
            )
            exported.append(
                {
                    "format": "FBX",
                    "path": str(out_fbx),
                    "byteSize": out_fbx.stat().st_size,
                    "sha256": sha256_file(out_fbx),
                    "compatibilityNote": "3ds Max / 通用兼容交换格式（非原生 .max，导入后请核对材质）",
                }
            )
        elif fmt == "glb":
            out_glb = output_dir / "model.glb"
            bpy.ops.export_scene.gltf(
                filepath=str(out_glb),
                export_format="GLB",
                export_yup=True,
            )
            exported.append(
                {
                    "format": "GLB",
                    "path": str(out_glb),
                    "byteSize": out_glb.stat().st_size,
                    "sha256": sha256_file(out_glb),
                    "compatibilityNote": "glTF 2.0 二进制通用交换格式（Y-up）",
                }
            )
        elif fmt == "obj":
            out_obj = output_dir / "model.obj"
            bpy.ops.wm.obj_export(
                filepath=str(out_obj),
                global_scale=1.0,
                export_materials=True,
            )
            exported.append(
                {
                    "format": "OBJ",
                    "path": str(out_obj),
                    "byteSize": out_obj.stat().st_size,
                    "sha256": sha256_file(out_obj),
                    "compatibilityNote": "OBJ + MTL 通用网格交换格式",
                }
            )
            out_mtl = output_dir / "model.mtl"
            if out_mtl.is_file():
                exported.append(
                    {
                        "format": "MTL",
                        "path": str(out_mtl),
                        "byteSize": out_mtl.stat().st_size,
                        "sha256": sha256_file(out_mtl),
                        "compatibilityNote": "OBJ 配套材质定义文件",
                    }
                )
        elif fmt == "dae":
            # 独立 COLLADA 1.4.1 导出（不依赖 Blender 5.x 已删除的内置 collada_export）
            dae_meshes: list[dict[str, Any]] = []
            for obj in bpy.data.objects:
                if obj.type != "MESH":
                    continue
                bm = bmesh.new()
                bm.from_mesh(obj.data)
                bmesh.ops.transform(bm, matrix=obj.matrix_world, verts=bm.verts)
                bmesh.ops.triangulate(bm, faces=bm.faces)
                bm.verts.ensure_lookup_table()
                bm.faces.ensure_lookup_table()

                positions: list[float] = []
                for v in bm.verts:
                    positions.extend([float(v.co.x), float(v.co.y), float(v.co.z)])

                normals: list[float] = []
                tri_indices: list[int] = []
                for f_idx, f in enumerate(bm.faces):
                    n = f.normal
                    normals.extend([float(n.x), float(n.y), float(n.z)])
                    for v in f.verts:
                        tri_indices.extend([v.index, f_idx])
                bm.free()

                rgba = (0.85, 0.85, 0.85, 1.0)
                if obj.data.materials and obj.data.materials[0] and obj.data.materials[0].use_nodes:
                    bsdf = next(
                        (nd for nd in obj.data.materials[0].node_tree.nodes if nd.type == "BSDF_PRINCIPLED"),
                        None,
                    )
                    if bsdf is not None:
                        bc = bsdf.inputs["Base Color"].default_value
                        rgba = (float(bc[0]), float(bc[1]), float(bc[2]), float(bc[3]))

                dae_meshes.append(
                    {
                        "id": obj.name,
                        "name": obj.name,
                        "positions": positions,
                        "normals": normals,
                        "triangles": tri_indices,
                        "colorRgba": rgba,
                    }
                )

            out_dae = output_dir / "model.dae"
            dae_info = write_collada_141(dae_meshes, out_dae, up_axis="Z_UP")
            exported.append(dae_info)
        elif fmt in ("skp", "max"):
            skipped.append(
                {
                    "format": fmt.upper(),
                    "reason": f"未配置原生 {fmt.upper()} SDK/自动化组件；严禁将 FBX/DAE/OBJ 改后缀冒充原生 {fmt.upper()}（SketchUp 请使用已导出的 .dae 兼容格式）。",
                }
            )

    report = {
        "schemaVersion": 1,
        "operation": "export_model",
        "blenderVersion": bpy.app.version_string,
        "sourceBlend": str(blend_path),
        "exported": exported,
        "skipped": skipped,
    }
    report_path = output_dir / "model_export_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def run_compose_site(inputs: dict[str, Any], parameters: dict[str, Any], output_dir: Path, task_id: str) -> Path:
    """多栋楼场地组合与 L 型包裹空间约束验证（总规格 §3.3 & C01）。

    保留各栋建筑独立对象集合与相对世界变换，不合并为无法区分的单一网格。
    """
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "compose_instances",
            "completed": 1,
            "total": 3,
            "message": "正在加载主楼与新建单体并应用场地相对变换",
        }
    )

    clear_scene()
    new_blend_path = Path(inputs["newBuildingBlendPath"])
    if not new_blend_path.is_file():
        raise FileNotFoundError(f"单体模型文件不存在：{new_blend_path}")

    new_offset = [float(v) for v in parameters.get("newBuildingOffset", [0.0, 0.0, 0.0])]
    new_rot_deg = float(parameters.get("newBuildingRotationDeg", 0.0))
    enable_l_host = bool(parameters.get("enableLHostBuilding", True))
    courtyard_gap_m = float(parameters.get("courtyardGapM", 4.0))

    # 1. 追加新建单体到独立集合（保持独立对象）
    new_col = get_or_create_collection("New_Building_Instance")
    with bpy.data.libraries.load(str(new_blend_path), link=False) as (data_from, data_to):
        data_to.objects = [name for name in data_from.objects]

    new_meshes: list[Any] = []
    for obj in data_to.objects:
        if obj is None or obj.type != "MESH":
            continue
        new_col.objects.link(obj)
        obj.location = Vector((
            obj.location.x + new_offset[0],
            obj.location.y + new_offset[1],
            obj.location.z + new_offset[2],
        ))
        obj.rotation_euler = (
            obj.rotation_euler[0],
            obj.rotation_euler[1],
            obj.rotation_euler[2] + math.radians(new_rot_deg),
        )
        new_meshes.append(obj)

    bpy.context.view_layer.update()

    # 计算新楼世界包围盒
    def compute_group_bbox(objs: list[Any]) -> dict[str, float]:
        xs, ys, zs = [], [], []
        for o in objs:
            for c in o.bound_box:
                wc = o.matrix_world @ Vector(c)
                xs.append(wc.x)
                ys.append(wc.y)
                zs.append(wc.z)
        if not xs:
            return {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0, "minZ": 0, "maxZ": 0}
        return {
            "minX": round(min(xs), 4),
            "maxX": round(max(xs), 4),
            "minY": round(min(ys), 4),
            "maxY": round(max(ys), 4),
            "minZ": round(min(zs), 4),
            "maxZ": round(max(zs), 4),
        }

    new_bbox = compute_group_bbox(new_meshes)

    # 2. 若启用 L 型主楼包裹约束，建立独立 L 型主楼两翼（北翼 + 西翼）并校验内院关系
    host_col = get_or_create_collection("Host_L_Building")
    host_mat = make_material("Mat_Host_Stone", (0.76, 0.72, 0.66, 1.0), roughness=0.78)
    ground_col = get_or_create_collection("Site_Ground")
    ground_mat = make_material("Mat_Site_Ground", (0.48, 0.50, 0.49, 1.0), roughness=0.92)

    constraint_report: dict[str, Any] = {"type": "none", "passed": True}

    if enable_l_host:
        wing_depth = 8.0
        host_height = 12.0
        # 西翼位于新楼西侧（minX - courtyard_gap_m - wing_depth .. minX - courtyard_gap_m）
        west_x1 = new_bbox["minX"] - courtyard_gap_m
        west_x0 = west_x1 - wing_depth
        # 北翼位于新楼北侧（maxY + courtyard_gap_m .. maxY + courtyard_gap_m + wing_depth）
        north_y0 = new_bbox["maxY"] + courtyard_gap_m
        north_y1 = north_y0 + wing_depth

        north_x0 = west_x0
        north_x1 = new_bbox["maxX"] + 6.0
        west_y0 = new_bbox["minY"] - 4.0
        west_y1 = north_y0

        west_wing = create_box_object(
            name="Host_L_West_Wing",
            collection=host_col,
            length=west_x1 - west_x0,
            thickness=west_y1 - west_y0,
            height=host_height,
            center=(0.5 * (west_x0 + west_x1), 0.5 * (west_y0 + west_y1), 0.5 * host_height),
            rot_z=0.0,
            material=host_mat,
            element_id="host-l-west-wing",
            element_kind="wall",
        )
        north_wing = create_box_object(
            name="Host_L_North_Wing",
            collection=host_col,
            length=north_x1 - north_x0,
            thickness=north_y1 - north_y0,
            height=host_height,
            center=(0.5 * (north_x0 + north_x1), 0.5 * (north_y0 + north_y1), 0.5 * host_height),
            rot_z=0.0,
            material=host_mat,
            element_id="host-l-north-wing",
            element_kind="wall",
        )

        # 场地地坪
        create_box_object(
            name="Site_Ground_Plane",
            collection=ground_col,
            length=(north_x1 - west_x0) + 16.0,
            thickness=(north_y1 - west_y0) + 16.0,
            height=0.20,
            center=(0.5 * (west_x0 + north_x1), 0.5 * (west_y0 + north_y1), -0.35),
            rot_z=0.0,
            material=ground_mat,
            element_id="site-ground",
            element_kind="terrain",
        )

        bpy.context.view_layer.update()
        west_bbox = compute_group_bbox([west_wing])
        north_bbox = compute_group_bbox([north_wing])

        clearance_west = round(new_bbox["minX"] - west_bbox["maxX"], 4)
        clearance_north = round(north_bbox["minY"] - new_bbox["maxY"], 4)
        enclosed_in_courtyard = (
            clearance_west > 0.5
            and clearance_north > 0.5
            and new_bbox["maxX"] <= north_bbox["maxX"]
            and new_bbox["minY"] >= west_bbox["minY"]
        )
        constraint_report = {
            "type": "l_courtyard_enclosure",
            "passed": enclosed_in_courtyard,
            "clearanceWestM": clearance_west,
            "clearanceNorthM": clearance_north,
            "courtyardPocket": {
                "minX": west_bbox["maxX"],
                "maxX": north_bbox["maxX"],
                "minY": west_bbox["minY"],
                "maxY": north_bbox["minY"],
            },
        }

    ensure_studio_lighting()
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "save_scene",
            "completed": 2,
            "total": 3,
            "message": "正在保存组合场景 scene.blend 与 scene_preview.glb",
        }
    )

    scene_blend = output_dir / "scene.blend"
    scene_glb = output_dir / "scene_preview.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(scene_blend))
    bpy.ops.export_scene.gltf(filepath=str(scene_glb), export_format="GLB", export_yup=True)

    report = {
        "schemaVersion": 1,
        "operation": "compose_site",
        "sceneVersionId": inputs.get("sceneVersionId", ""),
        "blenderVersion": bpy.app.version_string,
        "newBuildingBboxM": new_bbox,
        "spatialConstraint": constraint_report,
        "sceneBlendPath": str(scene_blend),
        "sceneGlbPath": str(scene_glb),
        "sceneBlendSha256": sha256_file(scene_blend),
        "sceneGlbSha256": sha256_file(scene_glb),
    }
    report_path = output_dir / "site_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def _matrix_from_col_major(m_col: list[float]) -> Matrix:
    return Matrix(
        (
            (m_col[0], m_col[4], m_col[8], m_col[12]),
            (m_col[1], m_col[5], m_col[9], m_col[13]),
            (m_col[2], m_col[6], m_col[10], m_col[14]),
            (m_col[3], m_col[7], m_col[11], m_col[15]),
        )
    )


def _encode_png_sequence_via_blender_vse(
    frames: list[Path],
    output_mp4: Path,
    fps: int,
    width_px: int,
    height_px: int,
) -> dict[str, Any]:
    """使用 Blender 内置 FFMPEG/H264 序列器将已校验 PNG 帧编码为真实可解码 MP4。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.resolution_x = width_px
    scene.render.resolution_y = height_px
    scene.render.resolution_percentage = 100
    scene.render.fps = fps
    scene.frame_start = 1
    scene.frame_end = len(frames)

    if not scene.sequence_editor:
        scene.sequence_editor_create()
    se = scene.sequence_editor
    if hasattr(se, "strips"):
        strips = se.strips
    elif hasattr(se, "sequences"):
        strips = se.sequences
    else:
        raise RuntimeError("Blender Sequence Editor API 不可用。")

    first_frame = frames[0]
    strip = strips.new_image(
        name="ArchCanvasFrames",
        filepath=str(first_frame),
        channel=1,
        frame_start=1,
    )
    for extra in frames[1:]:
        strip.elements.append(extra.name)

    # Blender 5.x 中 media_type 可能是 'VIDEO'，4.x 为 file_format = 'FFMPEG'
    scene.render.use_sequencer = True
    img_settings = scene.render.image_settings
    if hasattr(img_settings, "media_type"):
        try:
            img_settings.media_type = "VIDEO"
        except Exception:
            pass
    try:
        img_settings.file_format = "FFMPEG"
    except Exception:
        pass
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.use_file_extension = True
    scene.render.filepath = str(output_mp4.with_suffix(""))

    bpy.ops.render.render(animation=True)

    # Blender 动画渲染可能输出 <stem>0001-0003.mp4 或 <stem>.mp4，统一归位到 output_mp4
    if not output_mp4.is_file():
        candidates = sorted(output_mp4.parent.glob(f"{output_mp4.stem}*.mp4"))
        if candidates:
            candidates[0].rename(output_mp4)

    if not output_mp4.is_file():
        raise RuntimeError(f"Blender 视频编码未产出 MP4 文件：{output_mp4}")
    head = output_mp4.read_bytes()[:32]
    if b"ftyp" not in head:
        raise RuntimeError(f"产出的视频文件缺少合规 MP4 (ftyp) 容器头：{output_mp4}")

    return {
        "encoder": "blender_builtin_ffmpeg_h264",
        "outputPath": str(output_mp4),
        "actualFormat": "MP4",
        "validContainer": True,
        "byteSize": output_mp4.stat().st_size,
        "sha256": sha256_file(output_mp4),
    }


def run_render_camera_path(
    inputs: dict[str, Any], parameters: dict[str, Any], output_dir: Path, task_id: str
) -> Path:
    """模型相机路径逐帧渲染（支持中断后复用已校验帧 + 防穿模校验 + MP4 编码，总规格 §9.1 & D07/D08）。"""
    blend_path = Path(inputs["blendPath"])
    if not blend_path.is_file():
        raise FileNotFoundError(f"模型/场景文件不存在：{blend_path}")

    keyframes: list[dict[str, Any]] = inputs.get("keyframes", [])
    if len(keyframes) < 2:
        raise ValueError("相机路径至少需要 2 个已保存的相机关键帧。")

    fps = max(1, int(parameters.get("fps", 12)))
    duration_sec = max(0.25, float(parameters.get("durationSec", 1.0)))
    total_frames = max(2, int(round(fps * duration_sec)))
    width_px = int(parameters.get("widthPx", 640))
    height_px = int(parameters.get("heightPx", 360))
    # 持久化帧缓存目录（允许中断后从同一目录续传）
    frames_dir = Path(inputs.get("framesCacheDir") or (output_dir / "frames"))
    frames_dir.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.open_mainfile(filepath=str(blend_path), load_ui=False)
    ensure_studio_lighting()

    # 收集建筑墙体包围盒用于防穿模检查
    solid_boxes: list[tuple[float, float, float, float, float, float]] = []
    for obj in bpy.data.objects:
        if obj.type == "MESH" and obj.get("archcanvas_element_kind") in ("wall", "roof", "slab"):
            corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
            solid_boxes.append(
                (
                    min(v.x for v in corners),
                    max(v.x for v in corners),
                    min(v.y for v in corners),
                    max(v.y for v in corners),
                    min(v.z for v in corners),
                    max(v.z for v in corners),
                )
            )

    kf_mats = [_matrix_from_col_major([float(v) for v in kf["matrixWorld"]]) for kf in keyframes]
    kf_locs = [m.to_translation() for m in kf_mats]
    kf_quats = [m.to_quaternion() for m in kf_mats]

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new(name="ArchPathCamera")
    cam_obj = bpy.data.objects.new(name="ArchPathCamera", object_data=cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    first_persp = keyframes[0].get("perspective") or {}
    cam_data.type = "PERSP"
    cam_data.lens = float(first_persp.get("focalLengthMm", 35.0))
    cam_data.sensor_width = float(first_persp.get("sensorWidthMm", 36.0))
    cam_data.clip_start = 0.1
    cam_data.clip_end = 500.0

    scene.render.engine = select_available_render_engine(str(parameters.get("engine", "EEVEE")))
    scene.render.resolution_x = width_px
    scene.render.resolution_y = height_px
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    rendered_count = 0
    reused_count = 0
    collision_warnings: list[str] = []
    max_speed_mps = 0.0
    prev_loc: Vector | None = None
    frame_paths: list[Path] = []

    seg_count = len(keyframes) - 1
    for f_idx in range(total_frames):
        t_global = f_idx / float(total_frames - 1)
        # Smoothstep 缓动曲线
        t_ease = t_global * t_global * (3.0 - 2.0 * t_global)
        seg_pos = min(seg_count - 1, int(t_ease * seg_count))
        local_t = (t_ease * seg_count) - seg_pos
        if f_idx == total_frames - 1:
            seg_pos = seg_count - 1
            local_t = 1.0

        loc = kf_locs[seg_pos].lerp(kf_locs[seg_pos + 1], local_t)
        quat = kf_quats[seg_pos].slerp(kf_quats[seg_pos + 1], local_t)

        if prev_loc is not None:
            speed = (loc - prev_loc).length * fps
            if speed > max_speed_mps:
                max_speed_mps = speed
        prev_loc = loc.copy()

        # 检查是否穿墙
        for bx0, bx1, by0, by1, bz0, bz1 in solid_boxes:
            if bx0 <= loc.x <= bx1 and by0 <= loc.y <= by1 and bz0 <= loc.z <= bz1:
                collision_warnings.append(f"第 {f_idx + 1} 帧相机位置 ({loc.x:.2f}, {loc.y:.2f}, {loc.z:.2f}) 疑似穿入构件。")
                break

        frame_file = frames_dir / f"frame_{f_idx + 1:04d}.png"
        frame_paths.append(frame_file)

        # 断点恢复：若该帧已存在且通过 PNG 尺寸核验，直接复用不重复渲染（D08）
        reused = False
        if frame_file.is_file():
            try:
                fw, fh = read_png_dimensions(frame_file)
                if fw == width_px and fh == height_px:
                    reused = True
                    reused_count += 1
            except Exception:
                reused = False

        if not reused:
            mat = quat.to_matrix().to_4x4()
            mat.translation = loc
            cam_obj.matrix_world = mat
            scene.render.filepath = str(frame_file)
            bpy.ops.render.render(write_still=True)
            fw, fh = read_png_dimensions(frame_file)
            if fw != width_px or fh != height_px:
                raise RuntimeError(f"第 {f_idx + 1} 帧尺寸异常：{fw}x{fh}")
            rendered_count += 1

        emit(
            {
                "type": "progress",
                "taskId": task_id,
                "stage": "render_frames",
                "completed": f_idx + 1,
                "total": total_frames,
                "message": f"帧 {f_idx + 1}/{total_frames}（已渲染 {rendered_count}，断点复用 {reused_count}）",
            }
        )

    # 编码为真实可解码 MP4 视频（内置 Blender H.264 序列器，保证无外部 FFmpeg 也能输出真实 MP4）
    out_mp4 = output_dir / "camera_path.mp4"
    encode_info = _encode_png_sequence_via_blender_vse(
        frame_paths, out_mp4, fps=fps, width_px=width_px, height_px=height_px
    )

    report = {
        "schemaVersion": 1,
        "operation": "render_camera_path",
        "videoSource": "model_path_render",
        "blenderVersion": bpy.app.version_string,
        "fps": fps,
        "totalFrames": total_frames,
        "durationSec": round(total_frames / float(fps), 4),
        "actualWidthPx": width_px,
        "actualHeightPx": height_px,
        "renderedFrames": rendered_count,
        "reusedFrames": reused_count,
        "maxCameraSpeedMps": round(max_speed_mps, 3),
        "collisionWarnings": collision_warnings,
        "framesCacheDir": str(frames_dir),
        "mp4Path": str(out_mp4),
        "mp4Sha256": encode_info["sha256"],
        "mp4ByteSize": encode_info["byteSize"],
        "encoder": encode_info["encoder"],
        "validContainer": encode_info["validContainer"],
    }
    report_path = output_dir / "video_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def run_import_existing_model(
    inputs: dict[str, Any], _parameters: dict[str, Any], output_dir: Path, task_id: str
) -> Path:
    """安全导入已有 .blend（强制 --disable-autoexec），统计集合/对象包围盒并导出 preview.glb。"""
    src_path = Path(inputs["sourcePath"])
    if not src_path.is_file():
        raise FileNotFoundError(f"现有模型文件不存在：{src_path}")

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "load_existing_model",
            "completed": 1,
            "total": 3,
            "message": f"正在安全加载现有模型：{src_path.name}",
        }
    )

    ext = src_path.suffix.lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(src_path), load_ui=False)
    elif ext in (".glb", ".gltf"):
        clear_scene()
        bpy.ops.import_scene.gltf(filepath=str(src_path))
    else:
        raise ValueError(f"暂不支持直接导入 {ext}，当前支持 .blend 与 .glb/.gltf。")

    bpy.context.view_layer.update()

    mesh_objs = [o for o in bpy.data.objects if o.type == "MESH"]
    xs, ys, zs = [], [], []
    for o in mesh_objs:
        for c in o.bound_box:
            wc = o.matrix_world @ Vector(c)
            xs.append(wc.x)
            ys.append(wc.y)
            zs.append(wc.z)

    has_bounds = len(xs) > 0
    min_x, max_x = (min(xs), max(xs)) if has_bounds else (0.0, 0.0)
    min_y, max_y = (min(ys), max(ys)) if has_bounds else (0.0, 0.0)
    min_z, max_z = (min(zs), max(zs)) if has_bounds else (0.0, 0.0)

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "export_preview",
            "completed": 2,
            "total": 3,
            "message": "正在归档冻结 .blend 副本与 preview.glb",
        }
    )

    out_blend = output_dir / "model.blend"
    out_glb = output_dir / "preview.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(out_blend))
    bpy.ops.export_scene.gltf(filepath=str(out_glb), export_format="GLB", export_yup=True)

    report = {
        "schemaVersion": 1,
        "operation": "import_existing_model",
        "modelVersionId": inputs.get("modelVersionId", ""),
        "sourceFile": src_path.name,
        "autoexecDisabled": True,
        "blenderVersion": bpy.app.version_string,
        "meshObjectCount": len(mesh_objs),
        "collections": [c.name for c in bpy.data.collections],
        "measuredBoundsM": {
            "minX": round(min_x, 4),
            "maxX": round(max_x, 4),
            "minY": round(min_y, 4),
            "maxY": round(max_y, 4),
            "minZ": round(min_z, 4),
            "maxZ": round(max_z, 4),
            "widthM": round(max_x - min_x, 4),
            "depthM": round(max_y - min_y, 4),
            "heightM": round(max_z - min_z, 4),
        },
        "blendPath": str(out_blend),
        "glbPath": str(out_glb),
        "blendSha256": sha256_file(out_blend),
        "glbSha256": sha256_file(out_glb),
    }
    report_path = output_dir / "validation_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def run_calibrate_camera_projection(
    inputs: dict[str, Any], _parameters: dict[str, Any], output_dir: Path, _task_id: str
) -> Path:
    """C04 标定验证：将 1m 标定立方体 8 个顶点用 Blender 实际相机投影到 1920x1080 像素坐标。"""
    from bpy_extras.object_utils import world_to_camera_view  # type: ignore

    clear_scene()
    cam_snap = inputs["cameraSnapshot"]
    width_px = int(cam_snap["widthPx"])
    height_px = int(cam_snap["heightPx"])

    scene = bpy.context.scene
    scene.render.resolution_x = width_px
    scene.render.resolution_y = height_px
    scene.render.resolution_percentage = 100

    cam_data = bpy.data.cameras.new(name="CalibCamera")
    cam_obj = bpy.data.objects.new(name="CalibCamera", object_data=cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    cam_obj.matrix_world = _matrix_from_col_major([float(v) for v in cam_snap["matrixWorld"]])
    persp = cam_snap["perspective"]
    cam_data.type = "PERSP"
    cam_data.lens = float(persp["focalLengthMm"])
    cam_data.sensor_width = float(persp["sensorWidthMm"])
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.clip_start = float(cam_snap["nearM"])
    cam_data.clip_end = float(cam_snap["farM"])
    bpy.context.view_layer.update()

    points = inputs["worldPointsArch"]
    projected: list[list[float]] = []
    for pt in points:
        co = world_to_camera_view(scene, cam_obj, Vector((float(pt[0]), float(pt[1]), float(pt[2]))))
        # Blender world_to_camera_view 返回左下角为原点的 [0,1] 坐标 -> 转为左上角原点像素坐标
        px = float(co.x) * width_px
        py = (1.0 - float(co.y)) * height_px
        projected.append([round(px, 4), round(py, 4)])

    report_path = output_dir / "calibration_projection.json"
    report_path.write_text(
        json.dumps({"widthPx": width_px, "heightPx": height_px, "projectedPixels": projected}, indent=2),
        encoding="utf-8",
    )
    return report_path


def main() -> int:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]

    parser = argparse.ArgumentParser(description="ArchCanvas Blender Worker")
    parser.add_argument("--request", required=True, help="Path to worker request JSON")
    args = parser.parse_args(argv)

    request_path = Path(args.request)
    if not request_path.is_file():
        emit(
            {
                "type": "error",
                "taskId": "unknown",
                "code": "REQUEST_NOT_FOUND",
                "message": f"找不到 Blender 任务请求文件：{request_path}",
            }
        )
        return 2

    req = json.loads(request_path.read_text(encoding="utf-8"))
    task_id = str(req["taskId"])
    operation = str(req["operation"])
    inputs = json.loads(Path(req["inputManifestPath"]).read_text(encoding="utf-8"))
    output_dir = Path(req["outputDirectory"])
    parameters = req.get("parameters", {})
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        if operation == "build_model":
            report_path = run_build_model(inputs, parameters, output_dir, task_id)
        elif operation == "native_render":
            report_path = run_native_render(inputs, parameters, output_dir, task_id)
        elif operation == "export_model":
            report_path = run_export_model(inputs, parameters, output_dir, task_id)
        elif operation == "compose_site":
            report_path = run_compose_site(inputs, parameters, output_dir, task_id)
        elif operation == "render_camera_path":
            report_path = run_render_camera_path(inputs, parameters, output_dir, task_id)
        elif operation == "import_existing_model":
            report_path = run_import_existing_model(inputs, parameters, output_dir, task_id)
        elif operation == "calibrate_camera_projection":
            report_path = run_calibrate_camera_projection(inputs, parameters, output_dir, task_id)
        else:
            raise ValueError(f"未知的 Blender 操作：{operation}")

        emit(
            {
                "type": "progress",
                "taskId": task_id,
                "stage": "done",
                "completed": 1,
                "total": 1,
                "message": "Blender 任务完成",
            }
        )
        emit({"type": "completed", "taskId": task_id, "reportPath": str(report_path)})
        return 0
    except Exception as exc:
        print(f"[blender-worker] ERROR: {exc}", file=sys.stderr)
        emit(
            {
                "type": "error",
                "taskId": task_id,
                "code": "BLENDER_EXECUTION_ERROR",
                "message": str(exc),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
