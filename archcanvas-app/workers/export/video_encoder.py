#!/usr/bin/env python3
"""构境画布（ArchCanvas）视频编码适配层（G4，总规格 §9.1 & D07）。

优先使用本机探测到的 FFmpeg CLI 编码 PNG 帧序列为 H.264 MP4 并用 ffprobe 实测参数；
若未检测到外部 FFmpeg，则明确回报 available=False，由上层决定回退至 Blender 内置 VSE 编码或提示缺项。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def probe_ffmpeg(override_path: str | None = None) -> tuple[str | None, str | None]:
    if override_path and Path(override_path).is_file():
        ff = str(Path(override_path))
        probe = str(Path(override_path).with_name("ffprobe.exe"))
        return ff, probe if Path(probe).is_file() else shutil.which("ffprobe")
    return shutil.which("ffmpeg"), shutil.which("ffprobe")


def verify_mp4_header(mp4_path: Path) -> bool:
    """校验文件是否具备合规 ISO BMFF / MP4 文件头（ftyp box）。"""
    if not mp4_path.is_file() or mp4_path.stat().st_size < 32:
        return False
    head = mp4_path.read_bytes()[:32]
    return b"ftyp" in head


def encode_frames_with_ffmpeg(
    frames_dir: Path,
    output_mp4: Path,
    fps: int,
    override_ffmpeg: str | None = None,
) -> dict[str, Any]:
    ffmpeg_exe, ffprobe_exe = probe_ffmpeg(override_ffmpeg)
    if not ffmpeg_exe:
        raise FileNotFoundError("未检测到外部 FFmpeg 可执行文件。")

    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    pattern = str(frames_dir / "frame_%04d.png")
    cmd = [
        ffmpeg_exe,
        "-y",
        "-framerate",
        str(fps),
        "-i",
        pattern,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_mp4),
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode != 0 or not verify_mp4_header(output_mp4):
        raise RuntimeError(f"FFmpeg 编码失败：{proc.stderr[-300:]}")

    probed: dict[str, Any] = {}
    if ffprobe_exe:
        p = subprocess.run(
            [
                ffprobe_exe,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_frames",
                "-show_entries",
                "stream=width,height,nb_read_frames,r_frame_rate,duration",
                "-of",
                "json",
                str(output_mp4),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if p.returncode == 0:
            try:
                data = json.loads(p.stdout)
                probed = (data.get("streams") or [{}])[0]
            except Exception:
                pass

    return {
        "encoder": "ffmpeg_cli",
        "outputPath": str(output_mp4),
        "actualFormat": "MP4",
        "validContainer": True,
        "byteSize": output_mp4.stat().st_size,
        "sha256": sha256_file(output_mp4),
        "probed": probed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="ArchCanvas Video Encoder")
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    req = json.loads(Path(args.request).read_text(encoding="utf-8"))
    try:
        res = encode_frames_with_ffmpeg(
            Path(req["framesDir"]),
            Path(req["outputMp4"]),
            int(req.get("fps", 24)),
            req.get("ffmpegPath"),
        )
        sys.stdout.write(json.dumps({"ok": True, "result": res}, ensure_ascii=False) + "\n")
        return 0
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
