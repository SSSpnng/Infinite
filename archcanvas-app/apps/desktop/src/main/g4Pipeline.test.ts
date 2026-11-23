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

describe('G4 End-to-End: Camera Path MP4 Video (D07), Frame Resume (D08), Generative Video Tracking & Project Relocation (D09)', () => {
  const appRootDir = path.resolve(__dirname, '../../../..');

  it(
    'renders real decodable MP4 from frozen model, reuses cached frames on resume (D08), tracks generative video review_required, and survives project relocation (D09)',
    async () => {
      const probe = await probeEnvironment(appRootDir);
      if (probe.tools.find((t) => t.id === 'blender')?.available !== true) {
        return;
      }

      const projectDir = makeTempDir('archcanvas-g4-orig-');
      const store = new ProjectStore();
      await store.createProject(projectDir, 'G4 视频与迁移验收');

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
          { id: 'n-cam1', kind: 'camera_frame', title: '起点人视', position: { x: 820, y: -60 }, status: 'idle', params: { name: '起点人视', widthPx: 320, heightPx: 180, eyeArch: [14, -8, 1.6], targetArch: [5, 3, 2.0] } },
          { id: 'n-cam2', kind: 'camera_frame', title: '终点鸟瞰', position: { x: 820, y: 100 }, status: 'idle', params: { name: '终点鸟瞰', widthPx: 320, heightPx: 180, eyeArch: [10, -12, 8.0], targetArch: [5, 3, 2.0] } },
          { id: 'n-path', kind: 'camera_path', title: '漫游路径', position: { x: 1060, y: 20 }, status: 'idle', params: { fps: 6, durationSec: 0.5, widthPx: 320, heightPx: 180, engine: 'EEVEE' } },
          { id: 'n-vid-model', kind: 'video', title: '模型路径成片', position: { x: 1300, y: -40 }, status: 'idle', params: { mode: 'model_path' } },
          { id: 'n-vid-gen', kind: 'video', title: '生成式视频模拟', position: { x: 1300, y: 120 }, status: 'idle', params: { mode: 'generative', providerId: 'mock_simulator', prompt: '平滑推进建筑主入口', durationSec: 4, fps: 24 } },
        ],
        edges: [
          { id: 'e1', source: 'n-dxf', sourceHandle: 'drawing', target: 'n-cal', targetHandle: 'drawing', dataType: 'drawing_asset' },
          { id: 'e2', source: 'n-cal', sourceHandle: 'calibrated', target: 'n-rec', targetHandle: 'calibrated', dataType: 'calibrated_drawing' },
          { id: 'e3', source: 'n-rec', sourceHandle: 'semantics', target: 'n-mod', targetHandle: 'semantics', dataType: 'building_semantics' },
          { id: 'e4', source: 'n-mod', sourceHandle: 'model', target: 'n-cam1', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e5', source: 'n-mod', sourceHandle: 'model', target: 'n-cam2', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e6', source: 'n-mod', sourceHandle: 'model', target: 'n-path', targetHandle: 'model', dataType: 'model_version' },
          { id: 'e7', source: 'n-cam1', sourceHandle: 'camera', target: 'n-path', targetHandle: 'cameras', dataType: 'camera_snapshot' },
          { id: 'e8', source: 'n-cam2', sourceHandle: 'camera', target: 'n-path', targetHandle: 'cameras', dataType: 'camera_snapshot' },
          { id: 'e9', source: 'n-path', sourceHandle: 'video', target: 'n-vid-model', targetHandle: 'video_in', dataType: 'video_artifact' },
        ],
      };
      store.saveCanvasGraph(graph);

      const runner = new TaskRunner(store, appRootDir);
      expect((await runner.runNodeTask('n-dxf')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cal')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-rec')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-mod')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cam1')).task.status).toBe('succeeded');
      expect((await runner.runNodeTask('n-cam2')).task.status).toBe('succeeded');

      // 1. 首次渲染相机路径（3 帧 @ 6 fps, 0.5s, 320x180 -> 真实 MP4）
      const pathRun1 = await runner.runNodeTask('n-path');
      expect(pathRun1.task.status, pathRun1.task.errorMessage).toBe('succeeded');
      const p1 = pathRun1.task.outputSummary as {
        totalFrames: number;
        fps: number;
        durationSec: number;
        actualWidthPx: number;
        actualHeightPx: number;
        renderedFrames: number;
        reusedFrames: number;
        validContainer: boolean;
        mp4Path: string;
      };
      expect(p1.totalFrames).toBe(3);
      expect(p1.fps).toBe(6);
      expect(p1.durationSec).toBeCloseTo(0.5, 2);
      expect(p1.actualWidthPx).toBe(320);
      expect(p1.actualHeightPx).toBe(180);
      expect(p1.renderedFrames).toBe(3);
      expect(p1.reusedFrames).toBe(0);
      expect(p1.validContainer).toBe(true);

      // 2. 中断恢复测试（D08）：删掉第 3 帧模拟中途中断，再重跑 -> 必须复用前 2 帧，只渲染 1 帧！
      const pathNode = pathRun1.updatedGraph.nodes.find((n) => n.id === 'n-path');
      const framesCacheRel = (pathNode?.outputSummary as { framesCacheRel: string }).framesCacheRel;
      const frame3Abs = path.join(store.resolveInsideProject(framesCacheRel), 'frame_0003.png');
      fs.unlinkSync(frame3Abs);

      const pathRun2 = await runner.runNodeTask('n-path');
      expect(pathRun2.task.status).toBe('succeeded');
      const p2 = pathRun2.task.outputSummary as { renderedFrames: number; reusedFrames: number };
      expect(p2.reusedFrames).toBe(2);
      expect(p2.renderedFrames).toBe(1);

      // 3. 验证模型路径视频 vs 生成式视频来源与复核状态独立标识
      const vModel = await runner.runNodeTask('n-vid-model');
      expect(vModel.task.status).toBe('succeeded');
      expect((vModel.task.outputSummary as { videoSource: string }).videoSource).toBe('model_path_render');

      const vGen = await runner.runNodeTask('n-vid-gen');
      expect(vGen.task.status).toBe('succeeded');
      expect((vGen.task.outputSummary as { videoSource: string; validationStatus: string }).videoSource).toBe('mock_generative_video');
      expect((vGen.task.outputSummary as { validationStatus: string }).validationStatus).toBe('review_required');

      // 4. 项目整体迁移到含中文与空格的新目录（D09），确认相对路径资源全部可重定位
      store.close();
      const relocatedDir = path.join(makeTempDir('archcanvas-g4-迁移 位置-'), '已迁移项目');
      fs.cpSync(projectDir, relocatedDir, { recursive: true });

      const reopened = new ProjectStore();
      const snap = await reopened.openProject(relocatedDir);
      expect(snap.manifest.name).toBe('G4 视频与迁移验收');
      expect(snap.graph.nodes).toHaveLength(9);
      const mp4Rel = (snap.graph.nodes.find((n) => n.id === 'n-vid-model')?.outputSummary as { mp4RelPath: string }).mp4RelPath;
      expect(fs.existsSync(reopened.resolveInsideProject(mp4Rel))).toBe(true);
      reopened.close();
    },
    120000
  );
});
