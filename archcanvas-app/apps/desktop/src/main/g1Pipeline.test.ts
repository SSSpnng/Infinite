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
      // ignore cleanup lock
    }
  }
});

describe('G1 End-to-End: DXF & Vector PDF -> Recognition -> Blender 4.5m Model -> Dual Camera Native PNG', () => {
  const appRootDir = path.resolve(__dirname, '../../../..');

  it('extracts 10m x 6m walls and slab from synthetic Vector PDF', async () => {
    const projectDir = makeTempDir('archcanvas-g1-pdf-');
    const store = new ProjectStore();
    await store.createProject(projectDir, 'G1 向量 PDF 验收');

    const pdfPath = path.join(appRootDir, 'tests/fixtures/sample_room_vector.pdf');
    const asset = store.importSourceFile(pdfPath);
    expect(asset.kind).toBe('pdf');

    const graph: CanvasGraph = {
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n-pdf',
          kind: 'drawing_file',
          title: '向量PDF',
          position: { x: 0, y: 0 },
          status: 'idle',
          params: { drawingScale: 100 },
          assetId: asset.id,
        },
        {
          id: 'n-cal',
          kind: 'drawing_calibrate',
          title: 'PDF校准',
          position: { x: 250, y: 0 },
          status: 'idle',
          params: { scaleFactor: 1.0, northAngleDeg: 0, floorName: '1F', floorElevationM: 0 },
        },
        {
          id: 'n-rec',
          kind: 'drawing_recognize',
          title: 'PDF识别',
          position: { x: 500, y: 0 },
          status: 'idle',
          params: { includeFurniture: false, wallThicknessDefaultM: 0.24 },
        },
      ],
      edges: [
        { id: 'e1', source: 'n-pdf', sourceHandle: 'drawing', target: 'n-cal', targetHandle: 'drawing', dataType: 'drawing_asset' },
        { id: 'e2', source: 'n-cal', sourceHandle: 'calibrated', target: 'n-rec', targetHandle: 'calibrated', dataType: 'calibrated_drawing' },
      ],
    };
    store.saveCanvasGraph(graph);

    const runner = new TaskRunner(store, appRootDir);
    const r1 = await runner.runNodeTask('n-pdf');
    expect(r1.task.status).toBe('succeeded');
    expect((r1.task.outputSummary as { isScannedLikely: boolean }).isScannedLikely).toBe(false);

    const r2 = await runner.runNodeTask('n-cal');
    expect(r2.task.status).toBe('succeeded');
    expect((r2.task.outputSummary as { calibratedSizeM: { widthM: number } }).calibratedSizeM.widthM).toBeCloseTo(10, 2);

    const r3 = await runner.runNodeTask('n-rec');
    expect(r3.task.status).toBe('succeeded');
    const summary = (r3.task.outputSummary as { summary: { wallCount: number; slabCount: number } }).summary;
    expect(summary.wallCount).toBeGreaterThanOrEqual(4);
    expect(summary.slabCount).toBe(1);
    store.close();
  });

  it(
    'runs full DXF -> Recognize -> Blender 4.5m white model -> Dual Camera Native PNG -> Export -> Reopen',
    async () => {
      const projectDir = makeTempDir('archcanvas-g1-dxf-');
      const exportDir = makeTempDir('archcanvas-g1-export-');
      const store = new ProjectStore();
      await store.createProject(projectDir, 'G1 真实建模闭环');
      store.updateManifest({ exportDirectory: exportDir });

      const dxfPath = path.join(appRootDir, 'tests/fixtures/sample_room_10000mm.dxf');
      const asset = store.importSourceFile(dxfPath);

      const graph: CanvasGraph = {
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'n-dxf', kind: 'drawing_file', title: '10000mm平面', position: { x: 0, y: 0 }, status: 'idle', params: {}, assetId: asset.id },
          { id: 'n-cal', kind: 'drawing_calibrate', title: '比例校准', position: { x: 240, y: 0 }, status: 'idle', params: { scaleFactor: 1, floorName: '1F', floorElevationM: 0 } },
          { id: 'n-rec', kind: 'drawing_recognize', title: '墙洞识别', position: { x: 480, y: 0 }, status: 'idle', params: { includeFurniture: false, wallThicknessDefaultM: 0.24 } },
          { id: 'n-mod', kind: 'building_model', title: '单层4.5m白模', position: { x: 720, y: 0 }, status: 'idle', params: { storeys: 1, floorHeightM: 4.5, whiteWallMode: true, defaultDoorHeightM: 2.1, includeRoofCap: true } },
          { id: 'n-cam1', kind: 'camera_frame', title: '南东人视1.6m', position: { x: 960, y: -80 }, status: 'idle', params: { name: '南东人视1.6m', projection: 'perspective', focalLengthMm: 35, widthPx: 640, heightPx: 360, eyeArch: [14, -8, 1.6], targetArch: [5, 3, 2.0] } },
          { id: 'n-cam2', kind: 'camera_frame', title: '西北鸟瞰', position: { x: 960, y: 120 }, status: 'idle', params: { name: '西北鸟瞰', projection: 'perspective', focalLengthMm: 35, widthPx: 640, heightPx: 360, eyeArch: [-7, 15, 11], targetArch: [5, 3, 2.0] } },
          { id: 'n-rnd1', kind: 'native_render', title: '人视原生图', position: { x: 1220, y: -80 }, status: 'idle', params: { engine: 'EEVEE', widthPx: 640, heightPx: 360 } },
          { id: 'n-rnd2', kind: 'native_render', title: '鸟瞰原生图', position: { x: 1220, y: 120 }, status: 'idle', params: { engine: 'EEVEE', widthPx: 640, heightPx: 360, hideRoofCap: true } },
          { id: 'n-exp', kind: 'export', title: '导出交付', position: { x: 1480, y: 20 }, status: 'idle', params: {} },
        ],
        edges: [
          { id: 'e1', source: 'n-dxf', sourceHandle: 'drawing', target: 'n-cal', targetHandle: 'drawing', dataType: 'drawing_asset' },
          { id: 'e2', source: 'n-cal', sourceHandle: 'calibrated', target: 'n-rec', targetHandle: 'calibrated', dataType: 'calibrated_drawing' },
          { id: 'e3', source: 'n-rec', sourceHandle: 'semantics', target: 'n-mod', targetHandle: 'semantics', dataType: 'building_semantics' },
          { id: 'e4', source: 'n-mod', sourceHandle: 'model', target: 'n-cam1', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e5', source: 'n-mod', sourceHandle: 'model', target: 'n-cam2', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e6', source: 'n-mod', sourceHandle: 'model', target: 'n-rnd1', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e7', source: 'n-cam1', sourceHandle: 'camera', target: 'n-rnd1', targetHandle: 'camera', dataType: 'camera_snapshot' },
          { id: 'e8', source: 'n-mod', sourceHandle: 'model', target: 'n-rnd2', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e9', source: 'n-cam2', sourceHandle: 'camera', target: 'n-rnd2', targetHandle: 'camera', dataType: 'camera_snapshot' },
          { id: 'e10', source: 'n-mod', sourceHandle: 'model', target: 'n-exp', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e11', source: 'n-rnd1', sourceHandle: 'image', target: 'n-exp', targetHandle: 'image', dataType: 'image_artifact' },
        ],
      };
      store.saveCanvasGraph(graph);

      const runner = new TaskRunner(store, appRootDir);
      expect((await runner.runNodeTask('n-dxf')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cal')).task.status).toBe('succeeded');
      const recRes = await runner.runNodeTask('n-rec');
      expect(recRes.task.status).toBe('succeeded');
      const recSummary = (recRes.task.outputSummary as { summary: { wallCount: number; openingCount: number; filteredEntityCount: number } }).summary;
      expect(recSummary.wallCount).toBe(5);
      expect(recSummary.openingCount).toBe(1);
      expect(recSummary.filteredEntityCount).toBeGreaterThanOrEqual(1); // FURNITURE excluded

      // Check whether Blender is runnable in this process (sandbox blocks D:\Blender; real desktop runs it)
      const probe = await probeEnvironment(appRootDir);
      const blenderReady = probe.tools.find((t) => t.id === 'blender')?.available === true;
      if (!blenderReady) {
        store.close();
        return;
      }

      const modRes = await runner.runNodeTask('n-mod');
      expect(modRes.task.status).toBe('succeeded');
      const modOut = modRes.task.outputSummary as {
        measuredBoundsM: { widthM: number; depthM: number; wallTopElevationM: number };
        validation: { passed: boolean; allManifold: boolean };
      };
      expect(modOut.validation.passed).toBe(true);
      expect(modOut.validation.allManifold).toBe(true);
      expect(modOut.measuredBoundsM.widthM).toBeCloseTo(10.0, 2);
      expect(modOut.measuredBoundsM.depthM).toBeCloseTo(6.0, 2);
      expect(modOut.measuredBoundsM.wallTopElevationM).toBeCloseTo(4.5, 3);

      expect((await runner.runNodeTask('n-cam1')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cam2')).task.status).toBe('succeeded');

      const rnd1 = await runner.runNodeTask('n-rnd1');
      expect(rnd1.task.status).toBe('succeeded');
      const rnd2 = await runner.runNodeTask('n-rnd2');
      expect(rnd2.task.status).toBe('succeeded');

      const out1 = rnd1.task.outputSummary as { actualWidthPx: number; actualHeightPx: number; pngSha256: string };
      const out2 = rnd2.task.outputSummary as { actualWidthPx: number; actualHeightPx: number; pngSha256: string };
      expect(out1.actualWidthPx).toBe(640);
      expect(out1.actualHeightPx).toBe(360);
      expect(out2.actualWidthPx).toBe(640);
      expect(out2.actualHeightPx).toBe(360);
      expect(out1.pngSha256).not.toBe(out2.pngSha256);

      const expRes = await runner.runNodeTask('n-exp');
      expect(expRes.task.status).toBe('succeeded');
      expect(fs.existsSync(expRes.task.outputPath!)).toBe(true);

      // Reopen project to confirm full persistence
      store.close();
      const reopened = new ProjectStore();
      const snap = await reopened.openProject(projectDir);
      expect(snap.graph.nodes).toHaveLength(9);
      expect(snap.graph.nodes.find((n) => n.id === 'n-mod')?.status).toBe('succeeded');
      reopened.close();
    },
    60000
  );
});
