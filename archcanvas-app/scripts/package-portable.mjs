#!/usr/bin/env node
/**
 * 构境画布（ArchCanvas）Windows 便携包与可重复构建清单生成脚本（G4 发布能力）
 * 收集已构建产物、受控工作脚本、合成小样，生成 release/archcanvas-portable-win64/ 与 build-manifest.json
 * （严禁打包任何 API Key 或本机绝对路径！）
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release/archcanvas-portable-win64');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.venv' || entry === '__pycache__' || entry === 'node_modules') continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

const mainBundle = path.join(rootDir, 'apps/desktop/dist/main/index.cjs');
const rendererIndex = path.join(rootDir, 'apps/desktop/dist/renderer/index.html');
if (!fs.existsSync(mainBundle) || !fs.existsSync(rendererIndex)) {
  console.error('请先执行 npm.cmd run build 生成主进程与前端构建产物。');
  process.exit(1);
}

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

copyRecursive(path.join(rootDir, 'apps/desktop/dist'), path.join(releaseDir, 'app/dist'));
copyRecursive(path.join(rootDir, 'workers'), path.join(releaseDir, 'workers'));
copyRecursive(path.join(rootDir, 'tests/fixtures'), path.join(releaseDir, 'fixtures'));
fs.copyFileSync(path.join(rootDir, 'README.md'), path.join(releaseDir, 'README.md'));
fs.copyFileSync(path.join(rootDir, 'scripts/diagnose.mjs'), path.join(releaseDir, 'diagnose.mjs'));

// 生成启动批处理（不写死任何机器绝对路径）
const startBat = `@echo off
chcp 65001 >nul
echo 启动构境画布 / ArchCanvas（便携版）...
where electron >nul 2>nul
if %errorlevel% neq 0 (
  echo 未在 PATH 中检测到 electron，请在工程根目录执行 npm.cmd run start 或配置 Electron 运行时。
  pause
  exit /b 1
)
electron "%~dp0app\\dist\\main\\index.cjs"
`;
fs.writeFileSync(path.join(releaseDir, 'ArchCanvas.bat'), startBat, 'utf-8');

let gitCommit = 'unknown';
try {
  gitCommit = execFileSync('C:\\Program Files\\Git\\cmd\\git.exe', ['-C', rootDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
} catch {
  // ignore
}

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else {
      const rel = path.relative(releaseDir, full).replace(/\\/g, '/');
      files.push({
        path: rel,
        byteSize: fs.statSync(full).size,
        sha256: sha256(full),
      });
    }
  }
}
walk(releaseDir);

const manifest = {
  schemaVersion: 1,
  product: '构境画布 / ArchCanvas',
  version: '0.1.0-g4',
  targetPlatform: 'win32-x64',
  builtAt: new Date().toISOString(),
  gitCommit,
  nodeVersion: process.version,
  declaredRuntimeRequirements: {
    os: 'Windows 10/11 x64',
    blender: 'Blender 4.x / 5.x（本地动态探测，用于白模/渲染/MP4）',
    python: 'Python 3.12 + ezdxf/shapely/pdfplumber/Pillow（uv 隔离）',
    optional: ['AutoCAD Core Console / ODA (DWG)', 'FFmpeg CLI (外部视频编码)', 'SketchUp (DAE 复核)'],
  },
  secretsIncluded: false,
  fileCount: files.length,
  files,
};

const manifestPath = path.join(releaseDir, 'build-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`已生成 Windows 便携包与可重复构建清单：${manifestPath}（共 ${files.length} 个文件）`);
