#!/usr/bin/env python3
"""生成构境画布（ArchCanvas）G0/G1 合成已知尺寸 DXF 与向量 PDF 测试小样。

生成文件：
1. sample_room_10000mm.dxf — 10,000 mm x 6,000 mm 单层房间，墙厚 240 mm，南墙含 1,200 mm 门洞，$INSUNITS=4（毫米）
2. sample_room_10m.dxf     — 与上述同形 10.0 m x 6.0 m 房间，$INSUNITS=6（米），用于验证 A01/A02 不误乘 0.001
3. sample_room_vector.pdf  — 1:100 比例向量 PDF（10 m x 6 m 房间，对应 PDF 283.4646 pt x 170.0787 pt），验证向量 PDF 提取与校准
"""

from __future__ import annotations

from pathlib import Path
import ezdxf


def build_room_dxf(path: Path, scale: float, insunits: int) -> None:
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = insunits
    msp = doc.modelspace()

    doc.layers.add("WALL", color=7)
    doc.layers.add("DOOR", color=3)
    doc.layers.add("TITLEBLOCK", color=8)
    doc.layers.add("FURNITURE", color=5)

    w = 10.0 * scale
    h = 6.0 * scale
    t = 0.24 * scale
    door_start = 4.4 * scale
    door_end = 5.6 * scale

    # 外墙轮廓（南墙留出 1.2m 门洞）
    msp.add_line((0, 0), (door_start, 0), dxfattribs={"layer": "WALL"})
    msp.add_line((door_end, 0), (w, 0), dxfattribs={"layer": "WALL"})
    msp.add_line((w, 0), (w, h), dxfattribs={"layer": "WALL"})
    msp.add_line((w, h), (0, h), dxfattribs={"layer": "WALL"})
    msp.add_line((0, h), (0, 0), dxfattribs={"layer": "WALL"})

    # 内墙线（240mm 墙厚）
    msp.add_line((t, t), (door_start, t), dxfattribs={"layer": "WALL"})
    msp.add_line((door_end, t), (w - t, t), dxfattribs={"layer": "WALL"})
    msp.add_line((w - t, t), (w - t, h - t), dxfattribs={"layer": "WALL"})
    msp.add_line((w - t, h - t), (t, h - t), dxfattribs={"layer": "WALL"})
    msp.add_line((t, h - t), (t, t), dxfattribs={"layer": "WALL"})

    # 门洞封口与门扇圆弧
    msp.add_line((door_start, 0), (door_start, t), dxfattribs={"layer": "DOOR"})
    msp.add_line((door_end, 0), (door_end, t), dxfattribs={"layer": "DOOR"})
    msp.add_line(
        (door_start, t),
        (door_start, t + (door_end - door_start)),
        dxfattribs={"layer": "DOOR"},
    )
    msp.add_arc(
        center=(door_start, t),
        radius=(door_end - door_start),
        start_angle=0,
        end_angle=90,
        dxfattribs={"layer": "DOOR"},
    )

    # 家具测试线条（用于验证 A05：无家具模式下不变成建筑墙体）
    msp.add_line((2.0 * scale, 2.0 * scale), (3.5 * scale, 2.0 * scale), dxfattribs={"layer": "FURNITURE"})

    path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(str(path))


def build_vector_pdf(path: Path) -> None:
    """生成极简合规的 1:100 向量 PDF（10m x 6m 房间），无额外第三方 PDF 写入依赖。"""
    # 1:100 比例下：10m = 0.1m 图面 = 0.1 / 0.0254 * 72 = 283.464567 pt
    pt_per_m = (1.0 / 100.0) / 0.0254 * 72.0
    ox, oy = 100.0, 100.0
    w = 10.0 * pt_per_m
    h = 6.0 * pt_per_m
    t = 0.24 * pt_per_m
    ds = 4.4 * pt_per_m
    de = 5.6 * pt_per_m

    lines = [
        (ox, oy, ox + ds, oy),
        (ox + de, oy, ox + w, oy),
        (ox + w, oy, ox + w, oy + h),
        (ox + w, oy + h, ox, oy + h),
        (ox, oy + h, ox, oy),
        (ox + t, oy + t, ox + ds, oy + t),
        (ox + de, oy + t, ox + w - t, oy + t),
        (ox + w - t, oy + t, ox + w - t, oy + h - t),
        (ox + w - t, oy + h - t, ox + t, oy + h - t),
        (ox + t, oy + h - t, ox + t, oy + t),
    ]
    ops = ["0.5 w"]
    for x1, y1, x2, y2 in lines:
        ops.append(f"{x1:.4f} {y1:.4f} m {x2:.4f} {y2:.4f} l S")
    stream_bytes = ("\n".join(ops) + "\n").encode("ascii")

    objs: list[bytes] = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 420] /Contents 4 0 R >>\nendobj\n",
        f"4 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
        + stream_bytes
        + b"endstream\nendobj\n",
    ]

    header = b"%PDF-1.4\n"
    offsets = []
    body = bytearray(header)
    for obj in objs:
        offsets.append(len(body))
        body.extend(obj)

    xref_pos = len(body)
    body.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets:
        body.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    body.extend(
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    path.write_bytes(bytes(body))


def main() -> None:
    fixtures_dir = Path(__file__).resolve().parent
    build_room_dxf(fixtures_dir / "sample_room_10000mm.dxf", scale=1000.0, insunits=4)
    build_room_dxf(fixtures_dir / "sample_room_10m.dxf", scale=1.0, insunits=6)
    build_vector_pdf(fixtures_dir / "sample_room_vector.pdf")
    print(f"Generated DXF & Vector PDF fixtures in {fixtures_dir}")


if __name__ == "__main__":
    main()
