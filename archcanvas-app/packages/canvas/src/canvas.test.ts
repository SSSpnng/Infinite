import { describe, expect, it } from 'vitest';
import type { CanvasGraph } from '@archcanvas/contracts';
import { markDownstreamStale, validateConnection } from './index.js';

function makeBaseGraph(): CanvasGraph {
  return {
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'n1',
        kind: 'drawing_file',
        title: '图纸文件',
        position: { x: 0, y: 0 },
        status: 'succeeded',
        params: {},
      },
      {
        id: 'n2',
        kind: 'drawing_calibrate',
        title: '图纸校准',
        position: { x: 300, y: 0 },
        status: 'succeeded',
        params: {},
      },
      {
        id: 'n3',
        kind: 'export',
        title: '导出交付',
        position: { x: 600, y: 0 },
        status: 'succeeded',
        params: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'n1',
        sourceHandle: 'drawing',
        target: 'n2',
        targetHandle: 'drawing',
        dataType: 'drawing_asset',
      },
      {
        id: 'e2',
        source: 'n2',
        sourceHandle: 'calibrated',
        target: 'n3',
        targetHandle: 'drawing',
        dataType: 'calibrated_drawing',
      },
    ],
  };
}

describe('@archcanvas/canvas', () => {
  it('accepts compatible port connections', () => {
    const g = makeBaseGraph();
    g.edges = [];
    const res = validateConnection(g, {
      source: 'n1',
      sourceHandle: 'drawing',
      target: 'n2',
      targetHandle: 'drawing',
    });
    expect(res.valid).toBe(true);
    expect(res.dataType).toBe('drawing_asset');
  });

  it('rejects incompatible port types with clear Chinese message', () => {
    const g = makeBaseGraph();
    g.edges = [];
    const res = validateConnection(g, {
      source: 'n1',
      sourceHandle: 'drawing',
      target: 'n3',
      targetHandle: 'model',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('端口类型不兼容');
  });

  it('marks changed node and downstream nodes as stale', () => {
    const g = makeBaseGraph();
    const updated = markDownstreamStale(g, 'n1');
    expect(updated.nodes.every((n) => n.status === 'stale')).toBe(true);
  });
});
