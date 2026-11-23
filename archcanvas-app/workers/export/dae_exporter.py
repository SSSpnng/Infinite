#!/usr/bin/env python3
"""独立 COLLADA 1.4.1 (.dae) 序列化器（适配 Blender 5.x 移除内置 COLLADA I/O，见总规格 §10.2 & §15.3）。

从 Blender 场景对象（三角化后的网格、法线、世界变换、材质颜色与米制 Z-UP 单位）
直接生成符合 COLLADA 1.4.1 规范的 .dae XML 文件，用于 SketchUp 兼容导入验证。
"""

from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


COLLADA_NS = "http://www.collada.org/2005/11/COLLADASchema"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_collada_141(
    meshes: list[dict[str, Any]],
    output_path: Path,
    up_axis: str = "Z_UP",
) -> dict[str, Any]:
    """将结构化三角网格列表序列化为合规 COLLADA 1.4.1 (.dae)。

    每个 mesh 项包含：
    - id: str
    - name: str
    - positions: list[float] (3 * N, 世界坐标米)
    - normals: list[float] (3 * M)
    - triangles: list[int] (pos_idx, norm_idx 交替, 共 6 * T)
    - colorRgba: tuple[float, float, float, float]
    """
    ET.register_namespace("", COLLADA_NS)
    root = ET.Element(
        f"{{{COLLADA_NS}}}COLLADA",
        attrib={"version": "1.4.1"},
    )

    asset = ET.SubElement(root, f"{{{COLLADA_NS}}}asset")
    contributor = ET.SubElement(asset, f"{{{COLLADA_NS}}}contributor")
    ET.SubElement(contributor, f"{{{COLLADA_NS}}}authoring_tool").text = "ArchCanvas COLLADA 1.4.1 Exporter"
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ET.SubElement(asset, f"{{{COLLADA_NS}}}created").text = now_iso
    ET.SubElement(asset, f"{{{COLLADA_NS}}}modified").text = now_iso
    ET.SubElement(asset, f"{{{COLLADA_NS}}}unit", attrib={"name": "meter", "meter": "1.0"})
    ET.SubElement(asset, f"{{{COLLADA_NS}}}up_axis").text = up_axis

    lib_effects = ET.SubElement(root, f"{{{COLLADA_NS}}}library_effects")
    lib_materials = ET.SubElement(root, f"{{{COLLADA_NS}}}library_materials")
    lib_geoms = ET.SubElement(root, f"{{{COLLADA_NS}}}library_geometries")
    lib_scenes = ET.SubElement(root, f"{{{COLLADA_NS}}}library_visual_scenes")
    vscene = ET.SubElement(
        lib_scenes,
        f"{{{COLLADA_NS}}}visual_scene",
        attrib={"id": "ArchCanvasScene", "name": "ArchCanvasScene"},
    )

    total_triangles = 0

    for idx, m in enumerate(meshes):
        safe_id = f"mesh_{idx}_{''.join(c if c.isalnum() else '_' for c in str(m['id']))}"
        eff_id = f"eff_{safe_id}"
        mat_id = f"mat_{safe_id}"
        geom_id = f"geom_{safe_id}"
        rgba = m.get("colorRgba", (0.85, 0.85, 0.85, 1.0))

        # Effect
        eff = ET.SubElement(lib_effects, f"{{{COLLADA_NS}}}effect", attrib={"id": eff_id})
        prof = ET.SubElement(eff, f"{{{COLLADA_NS}}}profile_COMMON")
        tech = ET.SubElement(prof, f"{{{COLLADA_NS}}}technique", attrib={"sid": "common"})
        lambert = ET.SubElement(tech, f"{{{COLLADA_NS}}}lambert")
        diff = ET.SubElement(lambert, f"{{{COLLADA_NS}}}diffuse")
        ET.SubElement(diff, f"{{{COLLADA_NS}}}color").text = (
            f"{rgba[0]:.4f} {rgba[1]:.4f} {rgba[2]:.4f} {rgba[3]:.4f}"
        )

        # Material
        mat = ET.SubElement(
            lib_materials, f"{{{COLLADA_NS}}}material", attrib={"id": mat_id, "name": mat_id}
        )
        ET.SubElement(mat, f"{{{COLLADA_NS}}}instance_effect", attrib={"url": f"#{eff_id}"})

        # Geometry
        positions: list[float] = m["positions"]
        normals: list[float] = m["normals"]
        tri_indices: list[int] = m["triangles"]
        tri_count = len(tri_indices) // 6
        total_triangles += tri_count

        geom = ET.SubElement(
            lib_geoms, f"{{{COLLADA_NS}}}geometry", attrib={"id": geom_id, "name": str(m["name"])}
        )
        mesh_el = ET.SubElement(geom, f"{{{COLLADA_NS}}}mesh")

        pos_src_id = f"{geom_id}_pos"
        pos_arr_id = f"{geom_id}_pos_arr"
        pos_src = ET.SubElement(mesh_el, f"{{{COLLADA_NS}}}source", attrib={"id": pos_src_id})
        pos_arr = ET.SubElement(
            pos_src,
            f"{{{COLLADA_NS}}}float_array",
            attrib={"id": pos_arr_id, "count": str(len(positions))},
        )
        pos_arr.text = " ".join(f"{v:.5f}" for v in positions)
        pos_tc = ET.SubElement(pos_src, f"{{{COLLADA_NS}}}technique_common")
        pos_acc = ET.SubElement(
            pos_tc,
            f"{{{COLLADA_NS}}}accessor",
            attrib={"source": f"#{pos_arr_id}", "count": str(len(positions) // 3), "stride": "3"},
        )
        for axis in ("X", "Y", "Z"):
            ET.SubElement(pos_acc, f"{{{COLLADA_NS}}}param", attrib={"name": axis, "type": "float"})

        nrm_src_id = f"{geom_id}_nrm"
        nrm_arr_id = f"{geom_id}_nrm_arr"
        nrm_src = ET.SubElement(mesh_el, f"{{{COLLADA_NS}}}source", attrib={"id": nrm_src_id})
        nrm_arr = ET.SubElement(
            nrm_src,
            f"{{{COLLADA_NS}}}float_array",
            attrib={"id": nrm_arr_id, "count": str(len(normals))},
        )
        nrm_arr.text = " ".join(f"{v:.5f}" for v in normals)
        nrm_tc = ET.SubElement(nrm_src, f"{{{COLLADA_NS}}}technique_common")
        nrm_acc = ET.SubElement(
            nrm_tc,
            f"{{{COLLADA_NS}}}accessor",
            attrib={"source": f"#{nrm_arr_id}", "count": str(len(normals) // 3), "stride": "3"},
        )
        for axis in ("X", "Y", "Z"):
            ET.SubElement(nrm_acc, f"{{{COLLADA_NS}}}param", attrib={"name": axis, "type": "float"})

        verts_id = f"{geom_id}_verts"
        verts_el = ET.SubElement(mesh_el, f"{{{COLLADA_NS}}}vertices", attrib={"id": verts_id})
        ET.SubElement(verts_el, f"{{{COLLADA_NS}}}input", attrib={"semantic": "POSITION", "source": f"#{pos_src_id}"})

        tris_el = ET.SubElement(
            mesh_el,
            f"{{{COLLADA_NS}}}triangles",
            attrib={"material": mat_id, "count": str(tri_count)},
        )
        ET.SubElement(tris_el, f"{{{COLLADA_NS}}}input", attrib={"semantic": "VERTEX", "source": f"#{verts_id}", "offset": "0"})
        ET.SubElement(tris_el, f"{{{COLLADA_NS}}}input", attrib={"semantic": "NORMAL", "source": f"#{nrm_src_id}", "offset": "1"})
        ET.SubElement(tris_el, f"{{{COLLADA_NS}}}p").text = " ".join(str(i) for i in tri_indices)

        # Visual scene node
        node_el = ET.SubElement(
            vscene, f"{{{COLLADA_NS}}}node", attrib={"id": f"node_{safe_id}", "name": str(m["name"]), "type": "NODE"}
        )
        inst_geom = ET.SubElement(node_el, f"{{{COLLADA_NS}}}instance_geometry", attrib={"url": f"#{geom_id}"})
        bind_mat = ET.SubElement(inst_geom, f"{{{COLLADA_NS}}}bind_material")
        bm_tc = ET.SubElement(bind_mat, f"{{{COLLADA_NS}}}technique_common")
        ET.SubElement(bm_tc, f"{{{COLLADA_NS}}}instance_material", attrib={"symbol": mat_id, "target": f"#{mat_id}"})

    scene_el = ET.SubElement(root, f"{{{COLLADA_NS}}}scene")
    ET.SubElement(scene_el, f"{{{COLLADA_NS}}}instance_visual_scene", attrib={"url": "#ArchCanvasScene"})

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(str(output_path), encoding="utf-8", xml_declaration=True)

    return {
        "format": "DAE",
        "colladaVersion": "1.4.1",
        "path": str(output_path),
        "meshCount": len(meshes),
        "triangleCount": total_triangles,
        "byteSize": output_path.stat().st_size,
        "sha256": sha256_file(output_path),
        "compatibilityNote": "独立 COLLADA 1.4.1 交换文件（米制 Z-UP，兼容 SketchUp 导入；非原生 .skp）",
    }
