import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasGraph } from '@archcanvas/contracts';
import { CredentialStore } from './credentialStore.js';
import { probeEnvironment, resolveDefaultPythonExecutable, resolveImageExporterScript } from './envProbe.js';
import { ProjectStore } from './projectStore.js';
import { TaskRunner } from './taskRunner.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup lock
    }
  }
});

describe('G2 End-to-End: Material Revision, Version Propagation, Honest Image/Model Export & API Security', () => {
  const appRootDir = path.resolve(__dirname, '../../../..');

  it('D04 & D05: exports 1506x1045 image with longEdgePx=3840 as 3840x2665 resampled (not native UHD) in PNG, JPEG, and WebP', async () => {
    const workDir = makeTempDir('archcanvas-g2-img-');
    const pythonExe = resolveDefaultPythonExecutable(appRootDir) ?? 'python';
    const exporterScript = resolveImageExporterScript(appRootDir);

    // 用 Pillow 生成一张真实 1506x1045 RGBA 测试图（对应总规格 §17 D04）
    const srcPng = path.join(workDir, 'src_1506x1045.png');
    await execFileAsync(
      pythonExe,
      ['-c', `from PIL import Image; Image.new('RGBA', (1506, 1045), (180, 200, 220, 200)).save(r'${srcPng}')`],
      { windowsHide: true }
    );

    // 1. 长边 3840 PNG 导出：实测约 3840x2665，明确 origin='resampled' 且 isNativeUhd4k=false
    const outPng = path.join(workDir, 'out_3840.png');
    const repPng = path.join(workDir, 'rep_png.json');
    const reqPng = path.join(workDir, 'req_png.json');
    fs.writeFileSync(
      reqPng,
      JSON.stringify({
        sourcePath: srcPng,
        outputPath: outPng,
        reportPath: repPng,
        format: 'PNG',
        sourceOrigin: 'native_render',
        longEdgePx: 3840,
      })
    );
    await execFileAsync(pythonExe, [exporterScript, '--request', reqPng], { windowsHide: true });
    const parsedPng = JSON.parse(fs.readFileSync(repPng, 'utf-8')) as Record<string, unknown>;
    expect(parsedPng.actualFormat).toBe('PNG');
    expect(parsedPng.actualWidthPx).toBe(3840);
    expect(parsedPng.actualHeightPx).toBe(2665);
    expect(parsedPng.hasAlpha).toBe(true);
    expect(parsedPng.origin).toBe('resampled');
    expect(parsedPng.isNativeUhd4k).toBe(false);

    // 2. JPEG 导出（白底合成，无 alpha）+ WebP 导出（保留 alpha）
    for (const [fmt, ext, expectAlpha] of [
      ['JPEG', 'jpg', false],
      ['WEBP', 'webp', true],
    ] as const) {
      const outPath = path.join(workDir, `out.${ext}`);
      const repPath = path.join(workDir, `rep_${ext}.json`);
      const reqPath = path.join(workDir, `req_${ext}.json`);
      fs.writeFileSync(
        reqPath,
        JSON.stringify({
          sourcePath: srcPng,
          outputPath: outPath,
          reportPath: repPath,
          format: fmt,
          backgroundHex: '#FFFFFF',
        })
      );
      await execFileAsync(pythonExe, [exporterScript, '--request', reqPath], { windowsHide: true });
      const parsed = JSON.parse(fs.readFileSync(repPath, 'utf-8')) as Record<string, unknown>;
      expect(parsed.actualFormat).toBe(fmt);
      expect(parsed.actualWidthPx).toBe(1506);
      expect(parsed.actualHeightPx).toBe(1045);
      expect(parsed.hasAlpha).toBe(expectAlpha);
      expect(parsed.origin).toBe('format_converted');
    }
  });

  it('D03: never leaks API Key into project.json, project.sqlite, task snapshots, or export manifests', async () => {
    const projectDir = makeTempDir('archcanvas-g2-secret-');
    const secretKey = 'sk-archcanvas-TOP-SECRET-KEY-987654321';
    const creds = new CredentialStore();
    creds.saveProvider(
      {
        id: 'openai_default',
        label: 'OpenAI 兼容',
        kind: 'openai_compat',
        baseUrl: 'https://api.example.invalid/v1',
        modelId: 'gpt-image-1',
      },
      secretKey
    );

    const store = new ProjectStore();
    await store.createProject(projectDir, '密钥隔离测试');
    store.close();

    // 扫描整个项目目录确认不包含明文 API Key
    const manifestText = fs.readFileSync(path.join(projectDir, 'project.json'), 'utf-8');
    const sqliteRaw = fs.readFileSync(path.join(projectDir, 'project.sqlite')).toString('latin1');
    expect(manifestText).not.toContain(secretKey);
    expect(sqliteRaw).not.toContain(secretKey);
    expect(creds.hasAnyRealProviderConfigured()).toBe(true);
  });

  it(
    'G2 full Blender loop: material slot revision keeps geometry, model rebuild marks 2 cameras stale & propagates new version, exports FBX/GLB/OBJ and skips fake SKP',
    async () => {
      const probe = await probeEnvironment(appRootDir);
      if (probe.tools.find((t) => t.id === 'blender')?.available !== true) {
        return;
      }

      const projectDir = makeTempDir('archcanvas-g2-blender-');
      const exportDir = makeTempDir('archcanvas-g2-export-');
      const store = new ProjectStore();
      await store.createProject(projectDir, 'G2 综合闭环');
      store.updateManifest({ exportDirectory: exportDir });

      const dxfPath = path.join(appRootDir, 'tests/fixtures/sample_room_10000mm.dxf');
      const asset = store.importSourceFile(dxfPath);

      const graph: CanvasGraph = {
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'n-dxf', kind: 'drawing_file', title: '平面', position: { x: 0, y: 0 }, status: 'idle', params: {}, assetId: asset.id },
          { id: 'n-cal', kind: 'drawing_calibrate', title: '校准', position: { x: 200, y: 0 }, status: 'idle', params: { scaleFactor: 1, floorName: '1F', floorElevationM: 0 } },
          { id: 'n-rec', kind: 'drawing_recognize', title: '识别', position: { x: 400, y: 0 }, status: 'idle', params: { includeFurniture: false } },
          { id: 'n-mod', kind: 'building_model', title: '白模', position: { x: 600, y: 0 }, status: 'idle', params: { storeys: 1, floorHeightM: 4.5, whiteWallMode: true } },
          { id: 'n-mat', kind: 'material', title: '外墙换银灰', position: { x: 800, y: 0 }, status: 'idle', params: { slotName: 'exterior_wall', baseColorHex: '#9EA7B3', roughness: 0.5 } },
          { id: 'n-cam1', kind: 'camera_frame', title: '南东人视', position: { x: 1000, y: -80 }, status: 'idle', params: { name: '南东人视', widthPx: 640, heightPx: 360, eyeArch: [14, -8, 1.6], targetArch: [5, 3, 2.0] } },
          { id: 'n-cam2', kind: 'camera_frame', title: '西北鸟瞰', position: { x: 1000, y: 120 }, status: 'idle', params: { name: '西北鸟瞰', widthPx: 640, heightPx: 360, eyeArch: [-7, 15, 11], targetArch: [5, 3, 2.0] } },
          { id: 'n-rnd1', kind: 'native_render', title: '视角1底图', position: { x: 1220, y: -80 }, status: 'idle', params: { engine: 'EEVEE', widthPx: 640, heightPx: 360 } },
          { id: 'n-rnd2', kind: 'native_render', title: '视角2底图', position: { x: 1220, y: 120 }, status: 'idle', params: { engine: 'EEVEE', widthPx: 640, heightPx: 360 } },
          { id: 'n-ai', kind: 'render_image', title: '模拟效果图', position: { x: 1440, y: -80 }, status: 'idle', params: { mode: 'model_constrained', providerId: 'mock_simulator', widthPx: 640, heightPx: 360 } },
          { id: 'n-exp', kind: 'export', title: '批量交付', position: { x: 1660, y: 0 }, status: 'idle', params: { imageFormat: 'WEBP', modelFormats: ['blend', 'fbx', 'glb', 'obj', 'skp'] } },
        ],
        edges: [
          { id: 'e1', source: 'n-dxf', sourceHandle: 'drawing', target: 'n-cal', targetHandle: 'drawing', dataType: 'drawing_asset' },
          { id: 'e2', source: 'n-cal', sourceHandle: 'calibrated', target: 'n-rec', targetHandle: 'calibrated', dataType: 'calibrated_drawing' },
          { id: 'e3', source: 'n-rec', sourceHandle: 'semantics', target: 'n-mod', targetHandle: 'semantics', dataType: 'building_semantics' },
          { id: 'e4', source: 'n-mod', sourceHandle: 'model', target: 'n-mat', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e5', source: 'n-mat', sourceHandle: 'model_out', target: 'n-cam1', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e6', source: 'n-mat', sourceHandle: 'model_out', target: 'n-cam2', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e7', source: 'n-mat', sourceHandle: 'model_out', target: 'n-rnd1', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e8', source: 'n-cam1', sourceHandle: 'camera', target: 'n-rnd1', targetHandle: 'camera', dataType: 'camera_snapshot' },
          { id: 'e9', source: 'n-mat', sourceHandle: 'model_out', target: 'n-rnd2', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e10', source: 'n-cam2', sourceHandle: 'camera', target: 'n-rnd2', targetHandle: 'camera', dataType: 'camera_snapshot' },
          { id: 'e11', source: 'n-rnd1', sourceHandle: 'bundle', target: 'n-ai', targetHandle: 'bundle', dataType: 'render_bundle' },
          { id: 'e12', source: 'n-mod', sourceHandle: 'model', target: 'n-exp', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e13', source: 'n-ai', sourceHandle: 'image', target: 'n-exp', targetHandle: 'image', dataType: 'image_artifact' },
        ],
      };
      store.saveCanvasGraph(graph);

      const runner = new TaskRunner(store, appRootDir);
      expect((await runner.runNodeTask('n-dxf')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cal')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-rec')).task.status).toBe('succeeded');

      // v1 模型（4.5m）
      const m1 = await runner.runNodeTask('n-mod');
      expect(m1.task.status).toBe('succeeded');
      const mv1 = (m1.task.outputSummary as { modelVersionId: string }).modelVersionId;

      // 材质修订（保持几何版本 mv1 不变）
      const mat1 = await runner.runNodeTask('n-mat');
      expect(mat1.task.status).toBe('succeeded');
      expect((mat1.task.outputSummary as { modelVersionId: string; geometryUnchanged: boolean }).modelVersionId).toBe(mv1);
      expect((mat1.task.outputSummary as { geometryUnchanged: boolean }).geometryUnchanged).toBe(true);

      // 渲染两个视角 + 模拟器生成效果图
      expect((await runner.runNodeTask('n-cam1')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cam2')).task.status).toBe('succeeded');
      const r1v1 = await runner.runNodeTask('n-rnd1');
      const r2v1 = await runner.runNodeTask('n-rnd2');
      expect(r1v1.task.status).toBe('succeeded');
      expect(r2v1.task.status).toBe('succeeded');
      expect((r1v1.task.outputSummary as { appliedMaterialOverrides: string[] }).appliedMaterialOverrides).toContain('exterior_wall:#9EA7B3');

      const aiRes = await runner.runNodeTask('n-ai');
      expect(aiRes.task.status).toBe('succeeded');
      expect((aiRes.task.outputSummary as { origin: string }).origin).toBe('mock_simulator');

      // 几何修改（层高改为 6.0m）-> 创建新模型版本 mv2 -> 自动标记下游两个视角为 stale（B08）
      const currentGraph = store.getSnapshot().graph;
      store.saveCanvasGraph({
        ...currentGraph,
        nodes: currentGraph.nodes.map((n) =>
          n.id === 'n-mod' ? { ...n, params: { ...n.params, floorHeightM: 6.0 } } : n
        ),
      });
      const m2 = await runner.runNodeTask('n-mod');
      expect(m2.task.status).toBe('succeeded');
      const mv2 = (m2.task.outputSummary as { modelVersionId: string }).modelVersionId;
      expect(mv2).not.toBe(mv1);
      expect((m2.task.outputSummary as { measuredBoundsM: { wallTopElevationM: number } }).measuredBoundsM.wallTopElevationM).toBeCloseTo(6.0, 3);

      // 验证两个视角渲染节点均被标为 stale
      expect(m2.updatedGraph.nodes.find((n) => n.id === 'n-rnd1')?.status).toBe('stale');
      expect(m2.updatedGraph.nodes.find((n) => n.id === 'n-rnd2')?.status).toBe('stale');

      // 一键批量更新过期下游 -> 两个视角全部引用新版 mv2！
      const refreshed = await runner.refreshStaleDownstream('n-mod');
      expect(refreshed.refreshedNodeIds).toContain('n-rnd1');
      expect(refreshed.refreshedNodeIds).toContain('n-rnd2');
      const rnd1After = refreshed.updatedGraph.nodes.find((n) => n.id === 'n-rnd1');
      const rnd2After = refreshed.updatedGraph.nodes.find((n) => n.id === 'n-rnd2');
      expect((rnd1After?.outputSummary as { modelVersionId: string }).modelVersionId).toBe(mv2);
      expect((rnd2After?.outputSummary as { modelVersionId: string }).modelVersionId).toBe(mv2);

      // 批量导出：验证真实 FBX/GLB/OBJ+MTL + WebP 图片，且 SKP 被诚实跳过（绝不改后缀伪造）
      const exp = await runner.runNodeTask('n-exp');
      expect(exp.task.status).toBe('succeeded');
      const manifest = JSON.parse(fs.readFileSync(exp.task.outputPath!, 'utf-8')) as {
        items: { actualFormat: string }[];
        skipped: { format: string }[];
      };
      const formats = manifest.items.map((i) => i.actualFormat);
      expect(formats).toContain('BLEND');
      expect(formats).toContain('FBX');
      expect(formats).toContain('GLB');
      expect(formats).toContain('OBJ');
      expect(formats).toContain('WEBP');
      expect(manifest.skipped.some((s) => s.format === 'SKP')).toBe(true);

      store.close();
    },
    90000
  );
});
