import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasGraph } from '@archcanvas/contracts';
import { probeEnvironment } from './envProbe.js';
import { ProjectStore } from './projectStore.js';
import { TaskRunner } from './taskRunner.js';

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

describe('G3 End-to-End: Elevation Conflict (A07), Gable Roof/Ramp/Rail/Grille (B03-B07), L-Courtyard (C01), Local Edit & COLLADA 1.4.1 DAE', () => {
  const appRootDir = path.resolve(__dirname, '../../../..');

  it('A07: detects plan vs elevation opening count conflict explicitly without silently adding windows', async () => {
    const projectDir = makeTempDir('archcanvas-g3-a07-');
    const store = new ProjectStore();
    await store.createProject(projectDir, 'G3 平立剖冲突检查');
    const dxfPath = path.join(appRootDir, 'tests/fixtures/sample_room_10000mm.dxf');
    const asset = store.importSourceFile(dxfPath);

    const graph: CanvasGraph = {
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'n-dxf', kind: 'drawing_file', title: '平面', position: { x: 0, y: 0 }, status: 'idle', params: {}, assetId: asset.id },
        { id: 'n-cal', kind: 'drawing_calibrate', title: '校准', position: { x: 200, y: 0 }, status: 'idle', params: { scaleFactor: 1, floorName: '1F', floorElevationM: 0 } },
        { id: 'n-rec', kind: 'drawing_recognize', title: '平立剖核对', position: { x: 400, y: 0 }, status: 'idle', params: { includeFurniture: false, elevationExpectedOpenings: 3 } },
      ],
      edges: [
        { id: 'e1', source: 'n-dxf', sourceHandle: 'drawing', target: 'n-cal', targetHandle: 'drawing', dataType: 'drawing_asset' },
        { id: 'e2', source: 'n-cal', sourceHandle: 'calibrated', target: 'n-rec', targetHandle: 'calibrated', dataType: 'calibrated_drawing' },
      ],
    };
    store.saveCanvasGraph(graph);
    const runner = new TaskRunner(store, appRootDir);
    await runner.runNodeTask('n-dxf');
    await runner.runNodeTask('n-cal');
    const rec = await runner.runNodeTask('n-rec');
    expect(rec.task.status).toBe('succeeded');
    const out = rec.task.outputSummary as {
      summary: { openingCount: number; conflictCount: number };
      conflicts: { planCount: number; elevationCount: number; adoptedSource: string }[];
    };
    expect(out.summary.openingCount).toBe(1);
    expect(out.summary.conflictCount).toBe(1);
    expect(out.conflicts[0]?.elevationCount).toBe(3);
    expect(out.conflicts[0]?.adoptedSource).toBe('plan_drawing');
    store.close();
  });

  it(
    'G3 full Blender verification: gable roof, ramp grounding, wall-side rail removal, grounded grille, L-courtyard ortho+aerial render, local_edit & COLLADA 1.4.1 DAE',
    async () => {
      const probe = await probeEnvironment(appRootDir);
      if (probe.tools.find((t) => t.id === 'blender')?.available !== true) {
        return;
      }

      const projectDir = makeTempDir('archcanvas-g3-blender-');
      const exportDir = makeTempDir('archcanvas-g3-export-');
      const store = new ProjectStore();
      await store.createProject(projectDir, 'G3 场地与建筑深化');
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
          {
            id: 'n-mod',
            kind: 'building_model',
            title: '坡屋顶+坡道+落地格栅',
            position: { x: 600, y: 0 },
            status: 'idle',
            params: {
              storeys: 1,
              floorHeightM: 4.5,
              whiteWallMode: true,
              roofStyle: 'gable',
              ridgeHeightM: 1.8,
              eaveOverhangM: 0.6,
              includeSteps: true,
              includeRamp: true,
              rampStartElevationM: 0.3,
              rampEndElevationM: 0.0,
              removeRailSides: ['wall_side'],
              includeDrainageApron: true,
              includeGrille: true,
              grilleBottomElevationM: 0.0,
            },
          },
          {
            id: 'n-site',
            kind: 'site_compose',
            title: 'L型内院组合',
            position: { x: 840, y: 0 },
            status: 'idle',
            params: { enableLHostBuilding: true, courtyardGapM: 4.0 },
          },
          {
            id: 'n-cam-ortho',
            kind: 'camera_frame',
            title: '正交南立面',
            position: { x: 1080, y: -80 },
            status: 'idle',
            params: { name: '正交南立面', projection: 'orthographic', widthPx: 640, heightPx: 360, eyeArch: [5, -18, 4], targetArch: [5, 3, 4] },
          },
          {
            id: 'n-cam-aerial',
            kind: 'camera_frame',
            title: 'L型场地鸟瞰',
            position: { x: 1080, y: 120 },
            status: 'idle',
            params: { name: 'L型场地鸟瞰', projection: 'perspective', widthPx: 640, heightPx: 360, eyeArch: [22, -16, 18], targetArch: [4, 4, 3] },
          },
          { id: 'n-rnd-ortho', kind: 'native_render', title: '正交图', position: { x: 1300, y: -80 }, status: 'idle', params: { engine: 'EEVEE', widthPx: 640, heightPx: 360 } },
          { id: 'n-rnd-aerial', kind: 'native_render', title: '鸟瞰图', position: { x: 1300, y: 120 }, status: 'idle', params: { engine: 'EEVEE', widthPx: 640, heightPx: 360 } },
          { id: 'n-edit-img', kind: 'local_edit', title: '仅图修补', position: { x: 1520, y: 120 }, status: 'idle', params: { scope: 'image_only', instruction: '去除临时标线' } },
          { id: 'n-exp', kind: 'export', title: 'SU兼容DAE导出', position: { x: 1520, y: -80 }, status: 'idle', params: { modelFormats: ['dae', 'skp'] } },
        ],
        edges: [
          { id: 'e1', source: 'n-dxf', sourceHandle: 'drawing', target: 'n-cal', targetHandle: 'drawing', dataType: 'drawing_asset' },
          { id: 'e2', source: 'n-cal', sourceHandle: 'calibrated', target: 'n-rec', targetHandle: 'calibrated', dataType: 'calibrated_drawing' },
          { id: 'e3', source: 'n-rec', sourceHandle: 'semantics', target: 'n-mod', targetHandle: 'semantics', dataType: 'building_semantics' },
          { id: 'e4', source: 'n-mod', sourceHandle: 'model', target: 'n-site', targetHandle: 'models', dataType: 'model_version' },
          { id: 'e5', source: 'n-site', sourceHandle: 'scene', target: 'n-cam-ortho', targetHandle: 'scene', dataType: 'scene_version' },
          { id: 'e6', source: 'n-site', sourceHandle: 'scene', target: 'n-cam-aerial', targetHandle: 'scene', dataType: 'scene_version' },
          { id: 'e7', source: 'n-site', sourceHandle: 'scene', target: 'n-rnd-ortho', targetHandle: 'scene', dataType: 'scene_version' },
          { id: 'e8', source: 'n-cam-ortho', sourceHandle: 'camera', target: 'n-rnd-ortho', targetHandle: 'camera', dataType: 'camera_snapshot' },
          { id: 'e9', source: 'n-site', sourceHandle: 'scene', target: 'n-rnd-aerial', targetHandle: 'scene', dataType: 'scene_version' },
          { id: 'e10', source: 'n-cam-aerial', sourceHandle: 'camera', target: 'n-rnd-aerial', targetHandle: 'camera', dataType: 'camera_snapshot' },
          { id: 'e11', source: 'n-rnd-aerial', sourceHandle: 'image', target: 'n-edit-img', targetHandle: 'image', dataType: 'image_artifact' },
          { id: 'e12', source: 'n-mod', sourceHandle: 'model', target: 'n-exp', targetHandle: 'model', dataType: 'model_version' },
        ],
      };
      store.saveCanvasGraph(graph);

      const runner = new TaskRunner(store, appRootDir);
      expect((await runner.runNodeTask('n-dxf')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cal')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-rec')).task.status).toBe('succeeded');

      // 1. 验证坡屋顶 (4.5 + 1.8 = 6.3m)、分边扶手（仅保留 outer，删除 wall_side）、坡道接地 (0.0m)、格栅落地 (0.0m)
      const mod = await runner.runNodeTask('n-mod');
      expect(mod.task.status).toBe('succeeded');
      const val = (mod.task.outputSummary as {
        validation: {
          passed: boolean;
          roofMaxZ: number;
          railSidesPresent: string[];
          grilleMinZ: number;
          rampMinZ: number;
        };
      }).validation;
      expect(val.passed).toBe(true);
      expect(val.roofMaxZ).toBeCloseTo(6.3, 3);
      expect(val.railSidesPresent).toEqual(['Ramp_Rail_outer']);
      expect(val.grilleMinZ).toBeCloseTo(0.0, 3);
      expect(val.rampMinZ).toBeCloseTo(0.0, 3);

      // 2. 验证 L 型内院包裹空间约束 (C01)
      const site = await runner.runNodeTask('n-site');
      expect(site.task.status).toBe('succeeded');
      const constraint = (site.task.outputSummary as {
        spatialConstraint: { type: string; passed: boolean; clearanceWestM: number; clearanceNorthM: number };
      }).spatialConstraint;
      expect(constraint.type).toBe('l_courtyard_enclosure');
      expect(constraint.passed).toBe(true);
      expect(constraint.clearanceWestM).toBeCloseTo(4.0, 2);
      expect(constraint.clearanceNorthM).toBeCloseTo(4.0, 2);

      // 3. 从组合场景渲染正交与鸟瞰两张图
      expect((await runner.runNodeTask('n-cam-ortho')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cam-aerial')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-rnd-ortho')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-rnd-aerial')).task.status).toBe('succeeded');

      // 4. 仅图片修饰必须显式标明 syncedToModel: false
      const editRes = await runner.runNodeTask('n-edit-img');
      expect(editRes.task.status).toBe('succeeded');
      expect((editRes.task.outputSummary as { syncedToModel: boolean }).syncedToModel).toBe(false);

      // 5. 独立 COLLADA 1.4.1 (.dae) 导出验证（Blender 5.2.3 下不调用已删除的 collada_export）+ SKP 诚实跳过
      const exp = await runner.runNodeTask('n-exp');
      expect(exp.task.status).toBe('succeeded');
      const manifest = JSON.parse(fs.readFileSync(exp.task.outputPath!, 'utf-8')) as {
        items: { actualFormat: string; destinationPath: string }[];
        skipped: { format: string }[];
      };
      const daeItem = manifest.items.find((i) => i.actualFormat === 'DAE');
      expect(daeItem).toBeDefined();
      const daeXml = fs.readFileSync(daeItem!.destinationPath, 'utf-8');
      expect(daeXml).toContain('version="1.4.1"');
      expect(daeXml).toContain('meter="1.0"');
      expect(daeXml).toContain('<up_axis>Z_UP</up_axis>');
      expect(manifest.skipped.some((s) => s.format === 'SKP')).toBe(true);

      store.close();
    },
    90000
  );
});
