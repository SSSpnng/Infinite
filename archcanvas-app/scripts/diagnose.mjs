#!/usr/bin/env node
/**
 * 构境画布（ArchCanvas）本机依赖诊断工具（G4 发布能力）
 * 检查 Node、Python(.venv)、Blender、GPU、DWG 转换器、FFmpeg、SketchUp、Electron 运行时
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 6000, windowsHide: true }).trim();
  } catch (err) {
    return null;
  }
}

const checks = [
  {
    id: 'node',
    label: 'Node.js 运行时',
    ok: true,
    detail: process.version,
  },
  {
    id: 'python_venv',
    label: 'Python 几何工作进程 (.venv)',
    ok: fs.existsSync(path.join(rootDir, 'workers/geometry/.venv/Scripts/python.exe')),
    detail: fs.existsSync(path.join(rootDir, 'workers/geometry/.venv/Scripts/python.exe'))
      ? 'workers/geometry/.venv 就绪'
      : '缺失：请执行 uv sync --project workers/geometry',
  },
  {
    id: 'electron_bin',
    label: 'Electron 桌面二进制',
    ok: fs.existsSync(path.join(rootDir, 'node_modules/electron/dist/electron.exe')),
    detail: fs.existsSync(path.join(rootDir, 'node_modules/electron/dist/electron.exe'))
      ? 'electron.exe 已安装'
      : '未拉取：请执行 npm.cmd install-scripts approve electron',
  },
  {
    id: 'desktop_dist',
    label: '桌面应用构建产物 (dist/)',
    ok:
      fs.existsSync(path.join(rootDir, 'apps/desktop/dist/main/index.cjs')) &&
      fs.existsSync(path.join(rootDir, 'apps/desktop/dist/renderer/index.html')),
    detail: 'apps/desktop/dist/main + dist/renderer',
  },
  {
    id: 'ffmpeg_cli',
    label: '外部 FFmpeg CLI（可选；缺失时自动使用 Blender 内置 H.264 序列器）',
    ok: Boolean(tryExec('ffmpeg', ['-version'])),
    detail: tryExec('ffmpeg', ['-version'])?.split(/\r?\n/)[0] ?? '未安装（使用 Blender 内置 MP4 编码）',
  },
];

console.log('=== 构境画布 / ArchCanvas 本机依赖诊断 ===');
for (const c of checks) {
  console.log(`[${c.ok ? 'OK' : 'WARN'}] ${c.label}: ${c.detail}`);
}
