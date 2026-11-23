#!/usr/bin/env python3
"""构境画布（ArchCanvas）Python 几何工作进程（G0 + G1）。

支持操作：
- inspect_drawing: 解析 DXF / 向量 PDF / DWG（经 CadConverter 转换），提取图元、单位与包围盒
- calibrate_drawing: 计算原图到米制建筑坐标的变换（支持比例修正、两点尺寸、北向、楼层）
- recognize_drawing: 从已校准的 DXF / 向量 PDF 识别墙体、门洞与楼板，输出结构化 ArchitecturalElement JSON
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

from cad_converter import convert_dwg_to_dxf


INSUNITS_MAP: dict[int, tuple[str, float]] = {
    0: ("unitless", 1.0),
    1: ("inches", 0.0254),
    2: ("feet", 0.3048),
    4: ("millimeters", 0.001),
    5: ("centimeters", 0.01),
    6: ("meters", 1.0),
}

IGNORED_LAYER_KEYWORDS = ("title", "frame", "dim", "text", "annot", "axis", "grid", "图框", "标注", "轴网")
FURNITURE_LAYER_KEYWORDS = ("furn", "equip", "家具", "设备")
DOOR_LAYER_KEYWORDS = ("door", "window", "open", "门", "窗")


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_dxf_segments(doc: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], set[str], dict[str, int], int]:
    """提取 DXF 模型空间（含递归展开块 INSERT 与 OCS→WCS）中的 2D 线段和圆弧。"""
    msp = doc.modelspace()
    segments: list[dict[str, Any]] = []
    arcs: list[dict[str, Any]] = []
    layers: set[str] = set()
    entity_counts: dict[str, int] = {}
    proxy_count = 0

    def handle_entity(entity: Any, depth: int = 0) -> None:
        nonlocal proxy_count
        etype = entity.dxftype()
        entity_counts[etype] = entity_counts.get(etype, 0) + 1
        layer = str(getattr(entity.dxf, "layer", "0"))
        layers.add(layer)
        handle = str(getattr(entity.dxf, "handle", ""))

        if etype in ("ACAD_PROXY_ENTITY", "AEC_WALL", "TCH_WALL"):
            proxy_count += 1
            return

        if etype == "INSERT" and depth < 6:
            try:
                for virtual in entity.virtual_entities():
                    handle_entity(virtual, depth + 1)
            except Exception:
                proxy_count += 1
            return

        if etype == "LINE":
            s = entity.dxf.start
            e = entity.dxf.end
            segments.append(
                {
                    "id": handle or f"seg-{len(segments)}",
                    "layer": layer,
                    "x1": float(s.x),
                    "y1": float(s.y),
                    "x2": float(e.x),
                    "y2": float(e.y),
                }
            )
        elif etype == "LWPOLYLINE":
            try:
                pts = list(entity.get_points("xy"))
                ocs = entity.ocs()
                wcs_pts = [ocs.to_wcs((float(p[0]), float(p[1]), 0.0)) for p in pts]
                n = len(wcs_pts)
                limit = n if entity.closed else max(0, n - 1)
                for i in range(limit):
                    p1 = wcs_pts[i]
                    p2 = wcs_pts[(i + 1) % n]
                    segments.append(
                        {
                            "id": f"{handle}-{i}",
                            "layer": layer,
                            "x1": float(p1.x),
                            "y1": float(p1.y),
                            "x2": float(p2.x),
                            "y2": float(p2.y),
                        }
                    )
            except Exception:
                pass
        elif etype == "ARC":
            try:
                ocs = entity.ocs()
                c_ocs = entity.dxf.center
                r = float(entity.dxf.radius)
                sa = float(entity.dxf.start_angle) % 360.0
                ea = float(entity.dxf.end_angle) % 360.0
                sweep = (ea - sa) % 360.0
                if sweep == 0.0:
                    sweep = 360.0
                sample_angles = [sa, ea]
                for cardinal in (0.0, 90.0, 180.0, 270.0):
                    if 0.0 < ((cardinal - sa) % 360.0) < sweep:
                        sample_angles.append(cardinal)
                wcs_samples = []
                for ang in sample_angles:
                    rad = math.radians(ang)
                    pt_ocs = (
                        float(c_ocs.x) + r * math.cos(rad),
                        float(c_ocs.y) + r * math.sin(rad),
                        float(c_ocs.z),
                    )
                    w = ocs.to_wcs(pt_ocs)
                    wcs_samples.append((float(w.x), float(w.y)))
                c_wcs = ocs.to_wcs(c_ocs)
                arcs.append(
                    {
                        "id": handle or f"arc-{len(arcs)}",
                        "layer": layer,
                        "cx": float(c_wcs.x),
                        "cy": float(c_wcs.y),
                        "radius": r,
                        "samples": wcs_samples,
                    }
                )
            except Exception:
                pass
        elif etype == "CIRCLE":
            try:
                ocs = entity.ocs()
                c_wcs = ocs.to_wcs(entity.dxf.center)
                r = float(entity.dxf.radius)
                arcs.append(
                    {
                        "id": handle or f"circle-{len(arcs)}",
                        "layer": layer,
                        "cx": float(c_wcs.x),
                        "cy": float(c_wcs.y),
                        "radius": r,
                        "samples": [
                            (float(c_wcs.x) - r, float(c_wcs.y)),
                            (float(c_wcs.x) + r, float(c_wcs.y)),
                            (float(c_wcs.x), float(c_wcs.y) - r),
                            (float(c_wcs.x), float(c_wcs.y) + r),
                        ],
                    }
                )
            except Exception:
                pass

    for ent in msp:
        handle_entity(ent, 0)

    return segments, arcs, layers, entity_counts, proxy_count


def _compute_bounds(segments: list[dict[str, Any]], arcs: list[dict[str, Any]]) -> dict[str, float]:
    min_x, min_y = math.inf, math.inf
    max_x, max_y = -math.inf, -math.inf

    def upd(x: float, y: float) -> None:
        nonlocal min_x, min_y, max_x, max_y
        if x < min_x:
            min_x = x
        if y < min_y:
            min_y = y
        if x > max_x:
            max_x = x
        if y > max_y:
            max_y = y

    for seg in segments:
        upd(seg["x1"], seg["y1"])
        upd(seg["x2"], seg["y2"])
    for arc in arcs:
        for sx, sy in arc.get("samples", []):
            upd(sx, sy)

    has_bounds = math.isfinite(min_x) and math.isfinite(max_x)
    raw_w = (max_x - min_x) if has_bounds else 0.0
    raw_h = (max_y - min_y) if has_bounds else 0.0
    return {
        "minX": round(min_x, 6) if has_bounds else 0.0,
        "minY": round(min_y, 6) if has_bounds else 0.0,
        "maxX": round(max_x, 6) if has_bounds else 0.0,
        "maxY": round(max_y, 6) if has_bounds else 0.0,
        "width": round(raw_w, 6),
        "height": round(raw_h, 6),
    }


def inspect_dxf(file_path: Path, task_id: str, extra_warnings: list[str] | None = None) -> dict[str, Any]:
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "parse_dxf",
            "completed": 1,
            "total": 3,
            "message": f"正在解析 DXF 文件：{file_path.name}",
        }
    )

    import ezdxf  # type: ignore

    doc = ezdxf.readfile(str(file_path))
    insunits = int(doc.header.get("$INSUNITS", 0))
    unit_name, to_meters = INSUNITS_MAP.get(insunits, ("unknown", 1.0))

    segments, arcs, layers, entity_counts, proxy_count = _extract_dxf_segments(doc)

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "compute_bounds",
            "completed": 2,
            "total": 3,
            "message": "正在统计图层、块展开图元与米制包围盒",
        }
    )

    raw_bounds = _compute_bounds(segments, arcs)
    warnings = list(extra_warnings or [])
    if insunits == 0:
        warnings.append("DXF 未声明 $INSUNITS（无单位），请在图纸校准节点使用两点尺寸复核真实比例。")
    if proxy_count > 0:
        warnings.append(f"检测到 {proxy_count} 个未展开代理对象（Proxy/AEC），请核对缺失构件，不得将其视为空白空间。")

    return {
        "schemaVersion": 1,
        "format": "dxf",
        "sourceFile": file_path.name,
        "resolvedDxfPath": str(file_path),
        "dxfVersion": doc.dxfversion,
        "insunitsCode": insunits,
        "detectedUnit": unit_name,
        "unitToMeters": to_meters,
        "totalEntities": sum(entity_counts.values()),
        "entityCounts": entity_counts,
        "proxyEntityCount": proxy_count,
        "layers": sorted(layers),
        "rawBounds": raw_bounds,
        "metersBounds": {
            "widthM": round(raw_bounds["width"] * to_meters, 6),
            "heightM": round(raw_bounds["height"] * to_meters, 6),
        },
        "segments": segments,
        "arcs": arcs,
        "warnings": warnings,
    }


def inspect_pdf(file_path: Path, task_id: str, parameters: dict[str, Any]) -> dict[str, Any]:
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "parse_pdf",
            "completed": 1,
            "total": 3,
            "message": f"正在解析 PDF 图纸：{file_path.name}",
        }
    )

    import pdfplumber  # type: ignore

    page_index = int(parameters.get("pageIndex", 0))
    # 默认图纸比例（如 1:100 时，1 PDF pt = 1/72 inch = 0.0254/72 m，图面乘以 drawingScale）
    drawing_scale = float(parameters.get("drawingScale", 100.0))
    pt_to_sheet_m = 0.0254 / 72.0
    to_meters = pt_to_sheet_m * drawing_scale

    segments: list[dict[str, Any]] = []
    with pdfplumber.open(str(file_path)) as pdf:
        page_count = len(pdf.pages)
        if page_index < 0 or page_index >= page_count:
            raise ValueError(f"PDF 页码越界：请求第 {page_index + 1} 页，共 {page_count} 页。")
        page = pdf.pages[page_index]
        page_w = float(page.width)
        page_h = float(page.height)

        for idx, line in enumerate(page.lines or []):
            # pdfplumber 的 y0/y1 已经是自底向上坐标（与建筑 Y 向上一致）
            segments.append(
                {
                    "id": f"pdf-line-{idx}",
                    "layer": "PDF_VECTOR",
                    "x1": float(line["x0"]),
                    "y1": float(line["y0"]),
                    "x2": float(line["x1"]),
                    "y2": float(line["y1"]),
                }
            )
        for idx, rect in enumerate(page.rects or []):
            x0, y0, x1, y1 = float(rect["x0"]), float(rect["y0"]), float(rect["x1"]), float(rect["y1"])
            for j, (ax, ay, bx, by) in enumerate(
                [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]
            ):
                segments.append(
                    {
                        "id": f"pdf-rect-{idx}-{j}",
                        "layer": "PDF_VECTOR",
                        "x1": ax,
                        "y1": ay,
                        "x2": bx,
                        "y2": by,
                    }
                )

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "compute_bounds",
            "completed": 2,
            "total": 3,
            "message": "正在构建 PDF 页面到建筑坐标矩阵",
        }
    )

    is_scanned_likely = len(segments) == 0
    raw_bounds = _compute_bounds(segments, [])
    warnings: list[str] = []
    if is_scanned_likely:
        warnings.append(
            "该 PDF 页面未提取到矢量线段，疑似扫描件；已进入人工校准状态，不得自动声称准确尺寸。"
        )
    else:
        warnings.append(
            f"PDF 矢量按暂定图纸比例 1:{int(drawing_scale)} 换算，建议在「图纸校准」节点复核一条已知尺寸。"
        )

    return {
        "schemaVersion": 1,
        "format": "pdf",
        "sourceFile": file_path.name,
        "pageCount": page_count,
        "pageIndex": page_index,
        "pageSizePt": {"widthPt": page_w, "heightPt": page_h},
        "isScannedLikely": is_scanned_likely,
        "detectedUnit": f"pdf_pt_1:{int(drawing_scale)}",
        "unitToMeters": to_meters,
        "totalEntities": len(segments),
        "entityCounts": {"PDF_SEGMENT": len(segments)},
        "layers": ["PDF_VECTOR"] if segments else [],
        "rawBounds": raw_bounds,
        "metersBounds": {
            "widthM": round(raw_bounds["width"] * to_meters, 6),
            "heightM": round(raw_bounds["height"] * to_meters, 6),
        },
        "segments": segments,
        "arcs": [],
        "warnings": warnings,
    }


def run_calibrate(
    inspect_report: dict[str, Any], parameters: dict[str, Any], task_id: str
) -> dict[str, Any]:
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "calibrate_drawing",
            "completed": 1,
            "total": 2,
            "message": "正在计算图纸到米制建筑坐标的变换矩阵",
        }
    )
    scale_factor = float(parameters.get("scaleFactor", 1.0))
    if scale_factor <= 0:
        raise ValueError("比例修正系数 scaleFactor 必须大于 0。")
    north_deg = float(parameters.get("northAngleDeg", 0.0))
    floor_name = str(parameters.get("floorName", "1F"))
    floor_elev_m = float(parameters.get("floorElevationM", 0.0))

    base_to_m = float(inspect_report.get("unitToMeters", 1.0))
    effective_to_m = base_to_m * scale_factor
    raw_bounds = inspect_report.get("rawBounds", {})
    min_x = float(raw_bounds.get("minX", 0.0))
    min_y = float(raw_bounds.get("minY", 0.0))
    width_m = round(float(raw_bounds.get("width", 0.0)) * effective_to_m, 6)
    height_m = round(float(raw_bounds.get("height", 0.0)) * effective_to_m, 6)

    # 归一化到局部原点 (0, 0)，保存 worldOriginOffset（见总规格 §5.2）
    world_origin_offset = [round(min_x * effective_to_m, 6), round(min_y * effective_to_m, 6), floor_elev_m]

    calibrated_segments = []
    for seg in inspect_report.get("segments", []):
        calibrated_segments.append(
            {
                "id": seg["id"],
                "layer": seg["layer"],
                "x1": round((float(seg["x1"]) - min_x) * effective_to_m, 6),
                "y1": round((float(seg["y1"]) - min_y) * effective_to_m, 6),
                "x2": round((float(seg["x2"]) - min_x) * effective_to_m, 6),
                "y2": round((float(seg["y2"]) - min_y) * effective_to_m, 6),
            }
        )

    calibrated_arcs = []
    for arc in inspect_report.get("arcs", []):
        calibrated_arcs.append(
            {
                "id": arc["id"],
                "layer": arc["layer"],
                "cx": round((float(arc["cx"]) - min_x) * effective_to_m, 6),
                "cy": round((float(arc["cy"]) - min_y) * effective_to_m, 6),
                "radius": round(float(arc["radius"]) * effective_to_m, 6),
            }
        )

    return {
        "schemaVersion": 1,
        "operation": "calibrate_drawing",
        "sourceFile": inspect_report.get("sourceFile"),
        "format": inspect_report.get("format"),
        "detectedUnit": inspect_report.get("detectedUnit"),
        "baseUnitToMeters": base_to_m,
        "scaleFactor": scale_factor,
        "effectiveUnitToMeters": effective_to_m,
        "northAngleDeg": north_deg,
        "floorName": floor_name,
        "floorElevationM": floor_elev_m,
        "worldOriginOffset": world_origin_offset,
        "calibratedSizeM": {
            "widthM": width_m,
            "heightM": height_m,
        },
        "segments": calibrated_segments,
        "arcs": calibrated_arcs,
        "warnings": inspect_report.get("warnings", []),
    }


def _layer_matches(layer: str, keywords: tuple[str, ...]) -> bool:
    low = layer.lower()
    return any(k in low for k in keywords)


def run_recognize(
    calibrated: dict[str, Any], parameters: dict[str, Any], source_asset_id: str, task_id: str
) -> dict[str, Any]:
    """从已校准线段与门扇圆弧识别墙体、门洞和楼板，输出结构化建筑语义数据。"""
    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "filter_layers",
            "completed": 1,
            "total": 3,
            "message": "正在过滤图框、标注与可选家具图层",
        }
    )

    include_furniture = bool(parameters.get("includeFurniture", False))
    default_wall_t = float(parameters.get("wallThicknessDefaultM", 0.24))
    floor_id = str(calibrated.get("floorName", "1F"))
    floor_elev = float(calibrated.get("floorElevationM", 0.0))

    raw_segments: list[dict[str, Any]] = calibrated.get("segments", [])
    arcs: list[dict[str, Any]] = calibrated.get("arcs", [])

    wall_candidates: list[dict[str, Any]] = []
    unresolved_segments: list[dict[str, Any]] = []
    filtered_count = 0

    for seg in raw_segments:
        layer = str(seg.get("layer", "0"))
        if _layer_matches(layer, IGNORED_LAYER_KEYWORDS):
            filtered_count += 1
            continue
        if not include_furniture and _layer_matches(layer, FURNITURE_LAYER_KEYWORDS):
            filtered_count += 1
            continue
        if _layer_matches(layer, DOOR_LAYER_KEYWORDS):
            continue
        length = math.hypot(seg["x2"] - seg["x1"], seg["y2"] - seg["y1"])
        if length < 0.05:
            unresolved_segments.append(seg)
            continue
        wall_candidates.append(seg)

    emit(
        {
            "type": "progress",
            "taskId": task_id,
            "stage": "pair_walls_and_openings",
            "completed": 2,
            "total": 3,
            "message": "正在配对双线墙体、提取门洞并生成建筑构件",
        }
    )

    # 双线配对（支持水平与垂直双线墙，保留真实厚度；未配对长线段按默认墙厚建立）
    horiz: list[dict[str, Any]] = []
    vert: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []

    for seg in wall_candidates:
        dx = abs(seg["x2"] - seg["x1"])
        dy = abs(seg["y2"] - seg["y1"])
        if dy <= 0.02 and dx >= 0.1:
            x_min, x_max = sorted([seg["x1"], seg["x2"]])
            y_val = 0.5 * (seg["y1"] + seg["y2"])
            horiz.append({**seg, "a": x_min, "b": x_max, "c": y_val})
        elif dx <= 0.02 and dy >= 0.1:
            y_min, y_max = sorted([seg["y1"], seg["y2"]])
            x_val = 0.5 * (seg["x1"] + seg["x2"])
            vert.append({**seg, "a": y_min, "b": y_max, "c": x_val})
        else:
            other.append(seg)

    elements: list[dict[str, Any]] = []
    wall_counter = 0

    def pair_axis_segments(items: list[dict[str, Any]], is_horizontal: bool) -> None:
        nonlocal wall_counter
        used = [False] * len(items)
        for i in range(len(items)):
            if used[i]:
                continue
            s1 = items[i]
            best_j = -1
            best_dist = 999.0
            for j in range(i + 1, len(items)):
                if used[j]:
                    continue
                s2 = items[j]
                dist = abs(s1["c"] - s2["c"])
                if 0.08 <= dist <= 0.60:
                    overlap = min(s1["b"], s2["b"]) - max(s1["a"], s2["a"])
                    if overlap >= 0.2:
                        if dist < best_dist:
                            best_dist = dist
                            best_j = j

            wall_counter += 1
            wid = f"wall-{floor_id}-{wall_counter:03d}"
            if best_j != -1:
                used[i] = True
                used[best_j] = True
                s2 = items[best_j]
                c_mid = 0.5 * (s1["c"] + s2["c"])
                thickness = round(abs(s1["c"] - s2["c"]), 4)
                # 取外侧跨度，确保墙角对齐形成精确外包围盒
                span_a = min(s1["a"], s2["a"])
                span_b = max(s1["b"], s2["b"])
                start = [round(span_a, 6), round(c_mid, 6)] if is_horizontal else [round(c_mid, 6), round(span_a, 6)]
                end = [round(span_b, 6), round(c_mid, 6)] if is_horizontal else [round(c_mid, 6), round(span_b, 6)]
                elements.append(
                    {
                        "id": wid,
                        "buildingId": "bldg-main",
                        "floorId": floor_id,
                        "kind": "wall",
                        "geometry": {
                            "start": start,
                            "end": end,
                            "thicknessM": thickness,
                            "baseElevationM": floor_elev,
                            "axis": "horizontal" if is_horizontal else "vertical",
                        },
                        "materialSlotIds": ["exterior_wall"],
                        "evidence": [
                            {
                                "sourceAssetId": source_asset_id,
                                "entityIds": [s1["id"], s2["id"]],
                                "source": "drawing",
                                "confidence": 0.95,
                            }
                        ],
                        "assumptions": [],
                    }
                )
            else:
                used[i] = True
                start = [round(s1["a"], 6), round(s1["c"], 6)] if is_horizontal else [round(s1["c"], 6), round(s1["a"], 6)]
                end = [round(s1["b"], 6), round(s1["c"], 6)] if is_horizontal else [round(s1["c"], 6), round(s1["b"], 6)]
                elements.append(
                    {
                        "id": wid,
                        "buildingId": "bldg-main",
                        "floorId": floor_id,
                        "kind": "wall",
                        "geometry": {
                            "start": start,
                            "end": end,
                            "thicknessM": default_wall_t,
                            "baseElevationM": floor_elev,
                            "axis": "horizontal" if is_horizontal else "vertical",
                        },
                        "materialSlotIds": ["exterior_wall"],
                        "evidence": [
                            {
                                "sourceAssetId": source_asset_id,
                                "entityIds": [s1["id"]],
                                "source": "derived",
                                "confidence": 0.7,
                            }
                        ],
                        "assumptions": [f"单线墙体采用暂定墙厚 {default_wall_t} m"],
                    }
                )

    pair_axis_segments(horiz, True)
    pair_axis_segments(vert, False)

    # 斜墙直接保留为中心线墙
    for seg in other:
        wall_counter += 1
        elements.append(
            {
                "id": f"wall-{floor_id}-{wall_counter:03d}",
                "buildingId": "bldg-main",
                "floorId": floor_id,
                "kind": "wall",
                "geometry": {
                    "start": [round(seg["x1"], 6), round(seg["y1"], 6)],
                    "end": [round(seg["x2"], 6), round(seg["y2"], 6)],
                    "thicknessM": default_wall_t,
                    "baseElevationM": floor_elev,
                    "axis": "angled",
                },
                "materialSlotIds": ["exterior_wall"],
                "evidence": [
                    {
                        "sourceAssetId": source_asset_id,
                        "entityIds": [seg["id"]],
                        "source": "derived",
                        "confidence": 0.7,
                    }
                ],
                "assumptions": [f"斜向线段采用暂定墙厚 {default_wall_t} m"],
            }
        )

    # 识别门洞（通过门扇圆弧 + 墙端缺口）
    opening_counter = 0
    for arc in arcs:
        if _layer_matches(str(arc.get("layer", "")), DOOR_LAYER_KEYWORDS) or (0.6 <= float(arc.get("radius", 0)) <= 2.4):
            opening_counter += 1
            width_m = round(float(arc["radius"]), 4)
            elements.append(
                {
                    "id": f"opening-{floor_id}-{opening_counter:03d}",
                    "buildingId": "bldg-main",
                    "floorId": floor_id,
                    "kind": "opening",
                    "geometry": {
                        "openingType": "door",
                        "hinge": [arc["cx"], arc["cy"]],
                        "widthM": width_m,
                        "sillHeightM": 0.0,
                        "heightM": 2.1,
                    },
                    "materialSlotIds": ["door_frame"],
                    "evidence": [
                        {
                            "sourceAssetId": source_asset_id,
                            "entityIds": [arc["id"]],
                            "source": "drawing",
                            "confidence": 0.85,
                        }
                    ],
                    "assumptions": ["平面图未标注门洞高度，暂定 2.1 m（可在建模参数覆盖）"],
                }
            )

    # 楼板（采用校准后外包矩形）
    size = calibrated.get("calibratedSizeM", {"widthM": 0.0, "heightM": 0.0})
    w_m = float(size.get("widthM", 0.0))
    h_m = float(size.get("heightM", 0.0))
    if w_m > 0 and h_m > 0:
        elements.append(
            {
                "id": f"slab-{floor_id}-floor",
                "buildingId": "bldg-main",
                "floorId": floor_id,
                "kind": "slab",
                "geometry": {
                    "role": "floor",
                    "polygon": [[0.0, 0.0], [w_m, 0.0], [w_m, h_m], [0.0, h_m]],
                    "elevationM": floor_elev,
                    "thicknessM": 0.15,
                },
                "materialSlotIds": ["floor_slab"],
                "evidence": [
                    {
                        "sourceAssetId": source_asset_id,
                        "source": "derived",
                        "confidence": 0.9,
                    }
                ],
                "assumptions": ["楼板厚度暂定 0.15 m（位于底标高下方，不侵占净层高）"],
            }
        )

    assumptions = [
        "平面图纸不包含竖向层高与门窗洞高，建模时以用户指定的层高和暂定洞高为准。",
    ]
    if not include_furniture:
        assumptions.append("已按要求排除家具图层（无家具模式）。")

    # 平立剖开口交叉核对（总规格 §5.5 & A07）：如提供立面期望开口数/窗台高度，核对具体冲突而不悄悄补窗
    conflicts: list[dict[str, Any]] = []
    elevation_openings = parameters.get("elevationExpectedOpenings")
    plan_opening_count = sum(1 for e in elements if e["kind"] == "opening")
    if elevation_openings is not None:
        exp_cnt = int(elevation_openings)
        if exp_cnt != plan_opening_count:
            conflicts.append(
                {
                    "objectScope": f"{floor_id}_openings",
                    "planCount": plan_opening_count,
                    "elevationCount": exp_cnt,
                    "adoptedSource": "plan_drawing",
                    "resolution": "已保留平面实测开口，未自动补窗；请在核对立面修订日期后手动确认。",
                }
            )

    return {
        "schemaVersion": 1,
        "operation": "recognize_drawing",
        "sourceFile": calibrated.get("sourceFile"),
        "floorName": floor_id,
        "floorElevationM": floor_elev,
        "worldOriginOffset": calibrated.get("worldOriginOffset", [0.0, 0.0, 0.0]),
        "footprintSizeM": {"widthM": w_m, "depthM": h_m},
        "elements": elements,
        "summary": {
            "wallCount": sum(1 for e in elements if e["kind"] == "wall"),
            "openingCount": plan_opening_count,
            "slabCount": sum(1 for e in elements if e["kind"] == "slab"),
            "filteredEntityCount": filtered_count,
            "unresolvedSegmentCount": len(unresolved_segments),
            "conflictCount": len(conflicts),
        },
        "conflicts": conflicts,
        "unresolvedSegments": unresolved_segments,
        "assumptions": assumptions,
        "warnings": calibrated.get("warnings", []),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="ArchCanvas Geometry Worker")
    parser.add_argument("--request", required=True, help="Path to worker request JSON")
    args = parser.parse_args()

    request_path = Path(args.request)
    if not request_path.is_file():
        emit(
            {
                "type": "error",
                "taskId": "unknown",
                "code": "REQUEST_NOT_FOUND",
                "message": f"找不到任务请求文件：{request_path}",
            }
        )
        return 2

    req = json.loads(request_path.read_text(encoding="utf-8"))
    task_id = str(req["taskId"])
    operation = str(req["operation"])
    input_manifest_path = Path(req["inputManifestPath"])
    output_dir = Path(req["outputDirectory"])
    parameters = req.get("parameters", {})

    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        inputs = json.loads(input_manifest_path.read_text(encoding="utf-8"))

        if operation == "inspect_drawing":
            src_path = Path(inputs["sourcePath"])
            if not src_path.is_file():
                raise FileNotFoundError(f"源文件不存在：{src_path}")
            ext = src_path.suffix.lower()
            if ext == ".dxf":
                report = inspect_dxf(src_path, task_id)
            elif ext == ".pdf":
                report = inspect_pdf(src_path, task_id, parameters)
            elif ext == ".dwg":
                emit(
                    {
                        "type": "progress",
                        "taskId": task_id,
                        "stage": "convert_dwg",
                        "completed": 0,
                        "total": 3,
                        "message": "正在通过本地 DWG 转换器转换只读副本...",
                    }
                )
                conv = convert_dwg_to_dxf(
                    src_path,
                    output_dir / "dwg_convert",
                    override_path=inputs.get("dwgConverterPath"),
                )
                report = inspect_dxf(Path(conv["dxfPath"]), task_id, extra_warnings=conv["warnings"])
                report["originalFormat"] = "dwg"
                report["dwgConverter"] = conv["converterKind"]
            else:
                raise ValueError(f"不支持的图纸格式：{ext}。支持 DXF、PDF、DWG。")

            report_path = output_dir / "drawing_inspect.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            emit(
                {
                    "type": "artifact",
                    "taskId": task_id,
                    "kind": "drawing_inspect",
                    "path": str(report_path),
                    "sha256": sha256_file(report_path),
                }
            )
            emit(
                {
                    "type": "progress",
                    "taskId": task_id,
                    "stage": "done",
                    "completed": 3,
                    "total": 3,
                    "message": "图纸解析完成",
                }
            )
            emit({"type": "completed", "taskId": task_id, "reportPath": str(report_path)})
            return 0

        if operation == "calibrate_drawing":
            upstream_path = Path(inputs["inspectReportPath"])
            if not upstream_path.is_file():
                raise FileNotFoundError(f"上游图纸检查结果不存在：{upstream_path}")
            inspect_report = json.loads(upstream_path.read_text(encoding="utf-8"))
            calibrated = run_calibrate(inspect_report, parameters, task_id)
            out_path = output_dir / "calibrated_drawing.json"
            out_path.write_text(json.dumps(calibrated, ensure_ascii=False, indent=2), encoding="utf-8")
            emit(
                {
                    "type": "artifact",
                    "taskId": task_id,
                    "kind": "calibrated_drawing",
                    "path": str(out_path),
                    "sha256": sha256_file(out_path),
                }
            )
            emit(
                {
                    "type": "progress",
                    "taskId": task_id,
                    "stage": "done",
                    "completed": 2,
                    "total": 2,
                    "message": "图纸校准完成",
                }
            )
            emit({"type": "completed", "taskId": task_id, "reportPath": str(out_path)})
            return 0

        if operation == "recognize_drawing":
            upstream_path = Path(inputs["calibratedPath"])
            if not upstream_path.is_file():
                raise FileNotFoundError(f"上游校准结果不存在：{upstream_path}")
            calibrated = json.loads(upstream_path.read_text(encoding="utf-8"))
            source_asset_id = str(inputs.get("sourceAssetId", "unknown"))
            semantics = run_recognize(calibrated, parameters, source_asset_id, task_id)
            out_path = output_dir / "building_semantics.json"
            out_path.write_text(json.dumps(semantics, ensure_ascii=False, indent=2), encoding="utf-8")
            emit(
                {
                    "type": "artifact",
                    "taskId": task_id,
                    "kind": "building_semantics",
                    "path": str(out_path),
                    "sha256": sha256_file(out_path),
                }
            )
            emit(
                {
                    "type": "progress",
                    "taskId": task_id,
                    "stage": "done",
                    "completed": 3,
                    "total": 3,
                    "message": "建筑语义识别完成",
                }
            )
            emit({"type": "completed", "taskId": task_id, "reportPath": str(out_path)})
            return 0

        raise ValueError(f"未知操作类型：{operation}")
    except Exception as exc:
        print(f"[geometry-worker] ERROR: {exc}", file=sys.stderr)
        emit(
            {
                "type": "error",
                "taskId": task_id,
                "code": "WORKER_EXECUTION_ERROR",
                "message": str(exc),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
