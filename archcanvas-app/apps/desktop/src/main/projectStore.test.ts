import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasGraph } from '@archcanvas/contracts';
import { ProjectStore } from './projectStore.js';
import { TaskRunner } from './taskRunner.js';
import { probeEnvironment } from './envProbe.js';

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
      // ignore cleanup error on Windows
    }
  }
});

describe('G0 ProjectStore + TaskRunner + EnvProbe end-to-end', () => {
  const appRootDir = path.resolve(__dirname, '../../../..');

  it('creates project, imports 10,000mm & 10m DXF fixtures, runs Python inspect+calibrate+export, and restores after reopen', async () => {
    const projectDir = makeTempDir('archcanvas-g0-中文 路径-');
    const exportDir = makeTempDir('archcanvas-g0-export-');

    const store = new ProjectStore();
    await store.createProject(projectDir, 'G0 闭环验证项目');
    store.updateManifest({ exportDirectory: exportDir });

    // Import 10,000 mm DXF fixture
    const fixtureMm = path.join(appRootDir, 'tests/fixtures/sample_room_10000mm.dxf');
    const assetMm = store.importSourceFile(fixtureMm);
    expect(assetMm.kind).toBe('dxf');
    expect(assetMm.sha256).toHaveLength(64);

    // Import 10 m DXF fixture (A02: verify no erroneous * 0.001)
    const fixtureM = path.join(appRootDir, 'tests/fixtures/sample_room_10m.dxf');
    const assetM = store.importSourceFile(fixtureM);

    const graph: CanvasGraph = {
      schemaVersion: 1,
      viewport: { x: 10, y: 20, zoom: 1.2 },
      nodes: [
        {
          id: 'n-dxf-mm',
          kind: 'drawing_file',
          title: '10000mm小样',
          position: { x: 0, y: 0 },
          status: 'idle',
          params: {},
          assetId: assetMm.id,
        },
        {
          id: 'n-dxf-m',
          kind: 'drawing_file',
          title: '10m小样',
          position: { x: 0, y: 200 },
          status: 'idle',
          params: {},
          assetId: assetM.id,
        },
        {
          id: 'n-cal',
          kind: 'drawing_calibrate',
          title: '一层校准',
          position: { x: 300, y: 0 },
          status: 'idle',
          params: { scaleFactor: 1.0, northAngleDeg: 0, floorName: '1F', floorElevationM: 0 },
        },
        {
          id: 'n-exp',
          kind: 'export',
          title: '导出清单',
          position: { x: 600, y: 0 },
          status: 'idle',
          params: {},
        },
        {
          id: 'n-ai',
          kind: 'render_image',
          title: 'AI效果图',
          position: { x: 600, y: 200 },
          status: 'unconfigured',
          params: {},
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'n-dxf-mm',
          sourceHandle: 'drawing',
          target: 'n-cal',
          targetHandle: 'drawing',
          dataType: 'drawing_asset',
        },
        {
          id: 'e2',
          source: 'n-cal',
          sourceHandle: 'calibrated',
          target: 'n-exp',
          targetHandle: 'drawing',
          dataType: 'calibrated_drawing',
        },
      ],
    };
    store.saveCanvasGraph(graph);

    const runner = new TaskRunner(store, appRootDir);

    // 1. Inspect 10,000 mm DXF
    const r1 = await runner.runNodeTask('n-dxf-mm');
    expect(r1.task.status).toBe('succeeded');
    expect((r1.task.outputSummary as { metersBounds: { widthM: number; heightM: number } }).metersBounds.widthM).toBe(10);
    expect((r1.task.outputSummary as { metersBounds: { widthM: number; heightM: number } }).metersBounds.heightM).toBe(6);

    // 2. Inspect 10 m DXF — must ALSO be 10m x 6m (not 0.01m!)
    const r2 = await runner.runNodeTask('n-dxf-m');
    expect(r2.task.status).toBe('succeeded');
    expect((r2.task.outputSummary as { metersBounds: { widthM: number; heightM: number } }).metersBounds.widthM).toBe(10);
    expect((r2.task.outputSummary as { metersBounds: { widthM: number; heightM: number } }).metersBounds.heightM).toBe(6);

    // 3. Calibrate
    const r3 = await runner.runNodeTask('n-cal');
    expect(r3.task.status).toBe('succeeded');
    expect((r3.task.outputSummary as { calibratedSizeM: { widthM: number } }).calibratedSizeM.widthM).toBe(10);

    // 4. Export to exportDir
    const r4 = await runner.runNodeTask('n-exp');
    expect(r4.task.status).toBe('succeeded');
    expect(r4.task.outputPath).toBeTruthy();
    expect(fs.existsSync(r4.task.outputPath!)).toBe(true);

    // 5. Unconfigured AI node must report unsupported_dependency honestly
    const rAi = await runner.runNodeTask('n-ai');
    expect(rAi.task.status).toBe('unsupported_dependency');
    expect(rAi.task.errorCode).toBe('AI_PROVIDER_UNCONFIGURED');

    // 6. Close and reopen project to verify full persistence (nodes, edges, params, assets, tasks)
    store.close();
    const reopened = new ProjectStore();
    const snap = await reopened.openProject(projectDir);
    expect(snap.manifest.name).toBe('G0 闭环验证项目');
    expect(snap.manifest.exportDirectory).toBe(exportDir);
    expect(snap.graph.nodes).toHaveLength(5);
    expect(snap.graph.edges).toHaveLength(2);
    expect(snap.assets).toHaveLength(2);
    expect(snap.tasks.length).toBeGreaterThanOrEqual(5);
    reopened.close();
  });

  it('rejects invalid project path and path traversal clearly', async () => {
    const store = new ProjectStore();
    const emptyDir = makeTempDir('archcanvas-invalid-');
    await expect(store.openProject(emptyDir)).rejects.toThrow('project.json');

    await store.createProject(emptyDir, '路径安全检查');
    expect(() => store.resolveInsideProject('../../outside.txt')).toThrow('非法路径访问');
    store.close();
  });

  it('probes local environment dynamically without hardcoded paths', async () => {
    const report = await probeEnvironment(appRootDir);
    expect(report.aiProvidersConfigured).toBe(false);
    const py = report.tools.find((t) => t.id === 'python');
    const bl = report.tools.find((t) => t.id === 'blender');
    const dwg = report.tools.find((t) => t.id === 'dwg_converter');
    expect(py?.available).toBe(true);
    expect(bl).toBeDefined();
    expect(bl?.available || Boolean(bl?.error)).toBe(true);
    expect(dwg).toBeDefined();
  });
});
