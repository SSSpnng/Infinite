import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EnvironmentProbeReport, ToolProbeItem } from '@archcanvas/contracts';

const execFileAsync = promisify(execFile);

export interface ToolPathOverrides {
  blenderPath?: string;
  pythonPath?: string;
  dwgConverterPath?: string;
  ffmpegPath?: string;
}

async function runQuickCommand(
  executable: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr: '', error: msg };
  }
}

function findFirstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function scanSubdirExecutables(parentDirs: string[], exeName: string, maxDepth = 2): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) {
        results.push(full);
      } else if (entry.isDirectory() && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };
  for (const root of parentDirs) {
    walk(root, 0);
  }
  return results;
}

export function resolveGeometryWorkerScript(appRootDir: string): string {
  const candidates = [
    path.resolve(appRootDir, 'workers/geometry/worker.py'),
    path.resolve(__dirname, '../../../../workers/geometry/worker.py'),
    path.resolve(process.cwd(), 'workers/geometry/worker.py'),
  ];
  return findFirstExisting(candidates) ?? candidates[0];
}

export function resolveBlenderWorkerScript(appRootDir: string): string {
  const candidates = [
    path.resolve(appRootDir, 'workers/blender/blender_worker.py'),
    path.resolve(__dirname, '../../../../workers/blender/blender_worker.py'),
    path.resolve(process.cwd(), 'workers/blender/blender_worker.py'),
  ];
  return findFirstExisting(candidates) ?? candidates[0];
}

export function resolveImageExporterScript(appRootDir: string): string {
  const candidates = [
    path.resolve(appRootDir, 'workers/export/image_exporter.py'),
    path.resolve(__dirname, '../../../../workers/export/image_exporter.py'),
    path.resolve(process.cwd(), 'workers/export/image_exporter.py'),
  ];
  return findFirstExisting(candidates) ?? candidates[0];
}

export function resolveBlenderExecutable(overridePath?: string): string | undefined {
  const candidates: string[] = [];
  if (overridePath) candidates.push(overridePath);
  candidates.push(
    ...scanSubdirExecutables(
      ['C:\\Program Files\\Blender Foundation', 'D:\\Blender', 'C:\\Blender', 'E:\\Blender'],
      'blender.exe',
      2
    )
  );
  return findFirstExisting(candidates);
}

export function resolveDefaultPythonExecutable(
  appRootDir: string,
  overridePath?: string
): string | undefined {
  if (overridePath && fs.existsSync(overridePath)) return overridePath;
  const venvCandidates = [
    path.resolve(appRootDir, 'workers/geometry/.venv/Scripts/python.exe'),
    path.resolve(__dirname, '../../../../workers/geometry/.venv/Scripts/python.exe'),
    path.resolve(process.cwd(), 'workers/geometry/.venv/Scripts/python.exe'),
  ];
  return findFirstExisting(venvCandidates);
}

async function probePython(appRootDir: string, overridePath?: string): Promise<ToolProbeItem> {
  const venvPython = resolveDefaultPythonExecutable(appRootDir, overridePath);
  const exe = venvPython ?? 'python';
  const ver = await runQuickCommand(exe, ['--version']);
  if (!ver.ok) {
    return {
      id: 'python',
      label: 'Python 几何工作环境',
      available: false,
      required: true,
      path: overridePath,
      error: '未找到可用的 Python 解释器，请在设置中指定路径或运行 uv sync。',
    };
  }

  const pkgCheck = await runQuickCommand(exe, [
    '-c',
    "import importlib.util as u, json; pkgs=['ezdxf','shapely','pdfplumber']; print(json.dumps({p: bool(u.find_spec(p)) for p in pkgs}))",
  ]);
  let details = venvPython ? '使用项目隔离 .venv' : '使用系统 Python';
  let allDeps = false;
  if (pkgCheck.ok) {
    try {
      const parsed = JSON.parse(pkgCheck.stdout) as Record<string, boolean>;
      const missing = Object.entries(parsed)
        .filter(([, ok]) => !ok)
        .map(([k]) => k);
      allDeps = missing.length === 0;
      details = allDeps
        ? `${details}（ezdxf / shapely / pdfplumber 就绪）`
        : `${details}（缺少依赖：${missing.join(', ')}）`;
    } catch {
      // keep default details
    }
  }

  return {
    id: 'python',
    label: 'Python 几何工作环境',
    available: ver.ok && allDeps,
    required: true,
    path: venvPython ?? 'python (PATH)',
    version: ver.stdout || ver.stderr,
    details,
    error: allDeps ? undefined : '缺少必要的几何解析依赖，请在 workers/geometry 目录执行 uv sync。',
  };
}

async function probeBlender(overridePath?: string): Promise<ToolProbeItem> {
  const candidates: string[] = [];
  if (overridePath) candidates.push(overridePath);

  const discovered = scanSubdirExecutables(
    ['C:\\Program Files\\Blender Foundation', 'D:\\Blender', 'C:\\Blender', 'E:\\Blender'],
    'blender.exe',
    2
  );
  candidates.push(...discovered);

  const foundPath = findFirstExisting(candidates);
  const exe = foundPath ?? 'blender';
  const res = await runQuickCommand(exe, ['--version'], 8000);
  if (!res.ok) {
    return {
      id: 'blender',
      label: 'Blender 建模与渲染后端',
      available: false,
      required: true,
      path: foundPath ?? overridePath,
      error: foundPath
        ? `已发现可执行文件，但执行 --version 失败：${res.error ?? '未知错误'}`
        : '未检测到 Blender，请安装 Blender 4.x/5.x 并在设置中指定 blender.exe 路径。',
    };
  }
  const firstLine = res.stdout.split(/\r?\n/)[0]?.trim() || 'Blender';
  const is5x = /Blender\s+5\./i.test(firstLine);
  return {
    id: 'blender',
    label: 'Blender 建模与渲染后端',
    available: true,
    required: true,
    path: foundPath ?? 'blender (PATH)',
    version: firstLine,
    details: is5x
      ? 'Blender 5.x 已就绪（注意：5.x 不含内置 COLLADA，将使用独立交换路线）'
      : 'Blender 独立进程就绪',
  };
}

async function probeDwgConverter(overridePath?: string): Promise<ToolProbeItem> {
  const candidates: string[] = [];
  if (overridePath) candidates.push(overridePath);

  candidates.push(
    ...scanSubdirExecutables(
      ['C:\\Program Files\\Autodesk', 'D:\\Program Files\\Autodesk'],
      'accoreconsole.exe',
      2
    ),
    ...scanSubdirExecutables(
      ['C:\\Program Files\\ODA', 'D:\\Program Files\\ODA'],
      'ODAFileConverter.exe',
      2
    )
  );

  const found = findFirstExisting(candidates);
  if (!found) {
    return {
      id: 'dwg_converter',
      label: 'DWG 转换组件（AutoCAD / ODA）',
      available: false,
      required: false,
      error: '未检测到 AutoCAD Core Console 或 ODA 转换器；DXF 与向量 PDF 不受影响。',
    };
  }
  const kind = path.basename(found).toLowerCase().includes('accoreconsole')
    ? 'AutoCAD Core Console'
    : 'ODA File Converter';
  return {
    id: 'dwg_converter',
    label: 'DWG 转换组件（AutoCAD / ODA）',
    available: true,
    required: false,
    path: found,
    details: `检测到 ${kind}，可用于只读副本 DWG→DXF 转换`,
  };
}

async function probeFfmpeg(overridePath?: string): Promise<ToolProbeItem> {
  const exe = overridePath && fs.existsSync(overridePath) ? overridePath : 'ffmpeg';
  const res = await runQuickCommand(exe, ['-version']);
  if (!res.ok) {
    return {
      id: 'ffmpeg',
      label: 'FFmpeg 视频编码器',
      available: false,
      required: false,
      error: '未检测到 FFmpeg（仅影响 G4 视频编码，不影响本地建模与图片出图）。',
    };
  }
  const firstLine = res.stdout.split(/\r?\n/)[0]?.trim() || 'ffmpeg';
  return {
    id: 'ffmpeg',
    label: 'FFmpeg 视频编码器',
    available: true,
    required: false,
    path: overridePath ?? 'ffmpeg (PATH)',
    version: firstLine,
    details: '可用于模型路径帧序列视频编码',
  };
}

async function probeOptionalApp(
  id: string,
  label: string,
  roots: string[],
  exeName: string,
  missingHint: string
): Promise<ToolProbeItem> {
  const found = findFirstExisting(scanSubdirExecutables(roots, exeName, 2));
  if (!found) {
    return {
      id,
      label,
      available: false,
      required: false,
      error: missingHint,
    };
  }
  return {
    id,
    label,
    available: true,
    required: false,
    path: found,
    details: '已检测到本机安装，可用于兼容导出实测验证',
  };
}

async function probeGpu(): Promise<EnvironmentProbeReport['gpu']> {
  const res = await runQuickCommand('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version',
    '--format=csv,noheader,nounits',
  ]);
  if (!res.ok || !res.stdout) {
    return { available: false };
  }
  const firstLine = res.stdout.split(/\r?\n/)[0] ?? '';
  const [name, vramStr, driverVersion] = firstLine.split(',').map((s) => s.trim());
  return {
    available: Boolean(name),
    name,
    vramMb: vramStr ? Number(vramStr) : undefined,
    driverVersion,
  };
}

export async function probeEnvironment(
  appRootDir: string,
  overrides: ToolPathOverrides = {}
): Promise<EnvironmentProbeReport> {
  const [gpu, python, blender, dwg, ffmpeg, sketchup, max3d] = await Promise.all([
    probeGpu(),
    probePython(appRootDir, overrides.pythonPath),
    probeBlender(overrides.blenderPath),
    probeDwgConverter(overrides.dwgConverterPath),
    probeFfmpeg(overrides.ffmpegPath),
    probeOptionalApp(
      'sketchup',
      'SketchUp（可选导入验证）',
      ['C:\\Program Files\\SketchUp', 'D:\\Program Files\\SketchUp'],
      'SketchUp.exe',
      '未检测到 SketchUp；仍可导出通用 GLB/FBX/OBJ 格式。'
    ),
    probeOptionalApp(
      '3dsmax',
      '3ds Max（可选原生 MAX）',
      ['C:\\Program Files\\Autodesk', 'D:\\Program Files\\Autodesk'],
      '3dsmax.exe',
      '未检测到 3ds Max；原生 MAX 导出保持禁用，可使用 FBX/OBJ 兼容路线。'
    ),
  ]);

  return {
    probedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    gpu,
    tools: [python, blender, dwg, ffmpeg, sketchup, max3d],
    aiProvidersConfigured: false,
  };
}
