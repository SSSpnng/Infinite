#!/usr/bin/env python3
"""DWG 转换器适配层（CadConverter：probe -> convertToDxf -> inspectWarnings）。

遵循总规格 §15.2：
- 仅读取项目只读副本，绝不修改原始 DWG。
- 动态探测 AutoCAD Core Console (accoreconsole.exe) 或 ODA File Converter，绝不写死路径。
- 若检测到代理对象/转换告警，如实报告缺项。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any


def probe_dwg_converter(override_path: str | None = None) -> dict[str, Any]:
    candidates: list[Path] = []
    if override_path:
        candidates.append(Path(override_path))

    for root in (
        Path("C:/Program Files/Autodesk"),
        Path("D:/Program Files/Autodesk"),
    ):
        if root.is_dir():
            for child in root.iterdir():
                exe = child / "accoreconsole.exe"
                if exe.is_file():
                    candidates.append(exe)

    for root in (
        Path("C:/Program Files/ODA"),
        Path("D:/Program Files/ODA"),
    ):
        if root.is_dir():
            for child in root.iterdir():
                exe = child / "ODAFileConverter.exe"
                if exe.is_file():
                    candidates.append(exe)

    for cand in candidates:
        if cand.is_file():
            name_lower = cand.name.lower()
            kind = "accoreconsole" if "accoreconsole" in name_lower else "oda"
            return {"available": True, "kind": kind, "path": str(cand)}

    return {
        "available": False,
        "kind": None,
        "path": None,
        "error": "未检测到 AutoCAD Core Console 或 ODA File Converter，无法直接转换 DWG；请提供 DXF 或向量 PDF，或在设置中配置转换器路径。",
    }


def convert_dwg_to_dxf(
    dwg_path: Path,
    work_dir: Path,
    override_path: str | None = None,
) -> dict[str, Any]:
    probe = probe_dwg_converter(override_path)
    if not probe["available"]:
        raise RuntimeError(probe["error"])

    work_dir.mkdir(parents=True, exist_ok=True)
    dwg_copy = work_dir / dwg_path.name
    shutil.copy2(dwg_path, dwg_copy)
    out_dxf = work_dir / f"{dwg_path.stem}.dxf"

    exe = Path(probe["path"])
    warnings: list[str] = []

    if probe["kind"] == "accoreconsole":
        scr_path = work_dir / "convert.scr"
        dxf_posix = str(out_dxf).replace("\\", "/")
        scr_content = f"DXFOUT\n\"{dxf_posix}\"\nV\n2013\n16\nQUIT\nY\n"
        scr_path.write_text(scr_content, encoding="utf-8")

        proc = subprocess.run(
            [str(exe), "/i", str(dwg_copy), "/s", str(scr_path), "/l", "en-US"],
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        combined_log = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if "proxy" in combined_log.lower() or "aec" in combined_log.lower():
            warnings.append(
                "转换日志中检测到 AEC/代理对象提示，部分天正或专业图元可能未完全展开，请在识别结果中核对缺失墙体。"
            )
        if not out_dxf.is_file():
            raise RuntimeError(
                f"AutoCAD Core Console 转换 DWG 失败（退出码 {proc.returncode}）：未生成目标 DXF。"
            )
    else:
        in_dir = work_dir / "oda_in"
        out_dir = work_dir / "oda_out"
        in_dir.mkdir(exist_ok=True)
        out_dir.mkdir(exist_ok=True)
        shutil.copy2(dwg_copy, in_dir / dwg_copy.name)
        proc = subprocess.run(
            [str(exe), str(in_dir), str(out_dir), "ACAD2013", "DXF", "0", "1", dwg_copy.name],
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        candidate = out_dir / f"{dwg_path.stem}.dxf"
        if not candidate.is_file():
            raise RuntimeError(
                f"ODA File Converter 转换 DWG 失败（退出码 {proc.returncode}）：未生成目标 DXF。"
            )
        shutil.copy2(candidate, out_dxf)

    return {
        "converterKind": probe["kind"],
        "converterPath": probe["path"],
        "dxfPath": str(out_dxf),
        "warnings": warnings,
    }
