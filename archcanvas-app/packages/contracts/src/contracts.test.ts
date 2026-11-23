import { describe, expect, it } from 'vitest';
import {
  CanvasGraphSchema,
  ProjectManifestSchema,
  SourceAssetSchema,
  WorkerEventSchema,
} from './index.js';

describe('@archcanvas/contracts', () => {
  it('validates a SourceAsset with sha256', () => {
    const parsed = SourceAssetSchema.parse({
      id: 'asset-1',
      kind: 'dxf',
      originalName: 'sample_10m.dxf',
      relativePath: 'sources/abcd_sample_10m.dxf',
      sha256: 'a'.repeat(64),
      byteSize: 2048,
      importedAt: new Date().toISOString(),
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe('dxf');
  });

  it('rejects invalid sha256 in SourceAsset', () => {
    expect(() =>
      SourceAssetSchema.parse({
        id: 'asset-bad',
        kind: 'dxf',
        originalName: 'bad.dxf',
        relativePath: 'sources/bad.dxf',
        sha256: 'not-a-hash',
        byteSize: 12,
        importedAt: new Date().toISOString(),
      })
    ).toThrow();
  });

  it('validates CanvasGraph and ProjectManifest defaults', () => {
    const graph = CanvasGraphSchema.parse({ nodes: [], edges: [] });
    expect(graph.viewport.zoom).toBe(1);

    const manifest = ProjectManifestSchema.parse({
      projectId: 'proj-1',
      name: '测试建筑项目',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.projectType).toBe('building');
  });

  it('parses discriminated WorkerEvent JSONL items', () => {
    const ev = WorkerEventSchema.parse({
      type: 'progress',
      taskId: 'task-1',
      stage: 'inspect_dxf',
      completed: 1,
      total: 3,
    });
    expect(ev.type).toBe('progress');
  });
});
