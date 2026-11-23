#!/usr/bin/env python3
"""构境画布（ArchCanvas）确定性图片导出器（G2）。

严格遵循总规格 §10.1 与 §17（D04 / D05）：
- 支持 PNG / JPEG / WebP，真实编码与回读解码验证（不凭后缀判断）。
- 支持精确 W×H、原图比例长边模式（如 1506×1045 长边 3840 -> 3840×2665）。
- 比例变化支持 preserve（默认不拉伸）/ crop / pad；JPEG 显式指定透明底色。
- 普通 Lanczos 放大必须如实标注 origin='resampled' 与 upscaleMethod='LANCZOS'，绝不冒充原生 4K UHD。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    cleaned = hex_str.strip().lstrip("#")
    if len(cleaned) != 6:
        return (255, 255, 255)
    return (int(cleaned[0:2], 16), int(cleaned[2:4], 16), int(cleaned[4:6], 16))


def export_image(req: dict[str, Any]) -> dict[str, Any]:
    src_path = Path(req["sourcePath"])
    if not src_path.is_file():
        raise FileNotFoundError(f"源图片不存在：{src_path}")

    out_path = Path(req["outputPath"])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    fmt = str(req.get("format", "PNG")).upper()
    if fmt == "JPG":
        fmt = "JPEG"
    if fmt not in ("PNG", "JPEG", "WEBP"):
        raise ValueError(f"G2 导出暂不支持格式 {fmt}，支持 PNG / JPEG / WEBP。")

    source_origin = str(req.get("sourceOrigin", "native_render"))
    resize_mode = str(req.get("resizeMode", "preserve"))  # preserve | crop | pad
    target_w = req.get("widthPx")
    target_h = req.get("heightPx")
    long_edge = req.get("longEdgePx")
    quality = int(req.get("quality", 92))
    bg_hex = str(req.get("backgroundHex", "#FFFFFF"))
    dpi = int(req.get("dpi", 300))

    with Image.open(src_path) as im:
        im.load()
        src_w, src_h = im.size
        work = im.copy()

    # 计算目标尺寸
    resized = False
    if long_edge is not None and int(long_edge) > 0:
        le = int(long_edge)
        if src_w >= src_h:
            new_w = le
            new_h = max(1, round(src_h * (le / src_w)))
        else:
            new_h = le
            new_w = max(1, round(src_w * (le / src_h)))
        if (new_w, new_h) != (src_w, src_h):
            work = work.resize((new_w, new_h), Image.Resampling.LANCZOS)
            resized = True
    elif target_w is not None and target_h is not None:
        tw, th = int(target_w), int(target_h)
        if (tw, th) != (src_w, src_h):
            if resize_mode == "crop":
                work = ImageOps.fit(work, (tw, th), method=Image.Resampling.LANCZOS)
            elif resize_mode == "pad":
                bg_rgb = hex_to_rgb(bg_hex)
                color = (*bg_rgb, 255) if work.mode in ("RGBA", "LA") else bg_rgb
                work = ImageOps.pad(work, (tw, th), method=Image.Resampling.LANCZOS, color=color)
            else:
                # preserve: 保持原图比例等比缩放，绝不拉伸变形
                work.thumbnail((tw, th), Image.Resampling.LANCZOS)
                if work.size != (tw, th) and (tw > src_w or th > src_h):
                    scale = min(tw / src_w, th / src_h)
                    new_w = max(1, round(src_w * scale))
                    new_h = max(1, round(src_h * scale))
                    work = im.resize((new_w, new_h), Image.Resampling.LANCZOS)
            resized = True

    # 处理透明度与色彩空间
    if fmt == "JPEG":
        if work.mode in ("RGBA", "LA") or (work.mode == "P" and "transparency" in work.info):
            rgba = work.convert("RGBA")
            bg = Image.new("RGB", rgba.size, hex_to_rgb(bg_hex))
            bg.paste(rgba, mask=rgba.split()[3])
            work = bg
        elif work.mode != "RGB":
            work = work.convert("RGB")
        work.save(out_path, format="JPEG", quality=quality, dpi=(dpi, dpi))
    elif fmt == "WEBP":
        if work.mode not in ("RGB", "RGBA"):
            work = work.convert("RGBA" if "A" in work.getbands() else "RGB")
        work.save(out_path, format="WEBP", quality=quality)
    else:
        work.save(out_path, format="PNG", dpi=(dpi, dpi))

    # 真实回读解码核验（不凭后缀判断）
    with Image.open(out_path) as verified:
        verified.verify()
    with Image.open(out_path) as verified2:
        actual_format = str(verified2.format or fmt).upper()
        actual_w, actual_h = verified2.size
        has_alpha = "A" in verified2.getbands()

    if resized:
        origin = "resampled"
        upscale_method = "LANCZOS" if (actual_w > src_w or actual_h > src_h) else "LANCZOS_DOWNSCALE"
    elif actual_format != src_path.suffix.lstrip(".").upper():
        origin = "format_converted"
        upscale_method = None
    else:
        origin = source_origin
        upscale_method = None

    max_edge = max(actual_w, actual_h)
    is_native_uhd = (origin in ("native_render", "provider_native")) and actual_w == 3840 and actual_h == 2160
    if max_edge >= 3840 and not is_native_uhd:
        resolution_label = f"长边 {max_edge}（{actual_w}×{actual_h}，非原生 4K UHD，来源={origin}）"
    else:
        resolution_label = f"{actual_w}×{actual_h}（来源={origin}）"

    return {
        "schemaVersion": 1,
        "outputPath": str(out_path),
        "actualFormat": actual_format,
        "actualWidthPx": actual_w,
        "actualHeightPx": actual_h,
        "sourceWidthPx": src_w,
        "sourceHeightPx": src_h,
        "hasAlpha": has_alpha,
        "dpiMetadata": dpi,
        "origin": origin,
        "upscaleMethod": upscale_method,
        "isNativeUhd4k": is_native_uhd,
        "resolutionLabel": resolution_label,
        "byteSize": out_path.stat().st_size,
        "sha256": sha256_file(out_path),
        "validationStatus": "passed",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="ArchCanvas Deterministic Image Exporter")
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    req_path = Path(args.request)
    req = json.loads(req_path.read_text(encoding="utf-8"))
    try:
        report = export_image(req)
        report_path = Path(req["reportPath"])
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        sys.stdout.write(json.dumps({"ok": True, "reportPath": str(report_path)}, ensure_ascii=False) + "\n")
        return 0
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
