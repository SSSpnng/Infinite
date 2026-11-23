import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import type {
  CameraSnapshot,
  CanvasEdge,
  CanvasGraph,
  CanvasNode,
  EnvironmentProbeReport,
  NodeKind,
  ProjectManifest,
  Ref,
  SourceAsset,
  TaskRecord,
} from '@archcanvas/contracts';
import {
  NODE_REGISTRY,
  getNodeDefinition,
  markDownstreamStale,
  validateConnection,
} from '@archcanvas/canvas';
import { Viewport3D } from '@archcanvas/viewer';
import { ArchNodeCard, type ArchNodeFlowData } from './ArchNodeCard.js';
import { SettingsModal } from './SettingsModal.js';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

const NODE_TYPES = { archNode: ArchNodeCard };

const G0_PALETTE_KINDS: NodeKind[] = [
  'drawing_file',
  'drawing_calibrate',
  'drawing_recognize',
  'building_model',
  'site_compose',
  'material',
  'camera_frame',
  'native_render',
  'reference_image',
  'prompt',
  'render_image',
  'local_edit',
  'camera_path',
  'video',
  'export',
];

const TASK_STATUS_LABEL: Record<TaskRecord['status'], { text: string; cls: string }> = {
  draft: { text: '草稿', cls: 'badge' },
  queued: { text: '排队中', cls: 'badge' },
  validating: { text: '校验中', cls: 'badge' },
  running: { text: '运行中', cls: 'badge badge-warn' },
  collecting: { text: '归档中', cls: 'badge badge-warn' },
  checking: { text: '检查中', cls: 'badge badge-warn' },
  succeeded: { text: '已完成', cls: 'badge badge-ok' },
  needs_input: { text: '待输入', cls: 'badge badge-warn' },
  unsupported_dependency: { text: '缺少依赖/未配置', cls: 'badge badge-warn' },
  cancel_requested: { text: '取消中', cls: 'badge badge-warn' },
  cancelled: { text: '已取消', cls: 'badge' },
  failed: { text: '失败', cls: 'badge badge-err' },
};

export const App: React.FC = () => {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [graph, setGraph] = useState<CanvasGraph>({
    schemaVersion: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const [assets, setAssets] = useState<SourceAsset[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [probeReport, setProbeReport] = useState<EnvironmentProbeReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [viewerModal, setViewerModal] = useState<{
    modelNodeId: string;
    sceneRef: Ref;
    glbBuffer: ArrayBuffer;
  } | null>(null);
  const [previewPngDataUrl, setPreviewPngDataUrl] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [toast, setToast] = useState<{ kind: 'error' | 'info'; message: string } | null>(null);

  const showToast = useCallback((kind: 'error' | 'info', message: string) => {
    setToast({ kind, message });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  }, []);

  const runProbe = useCallback(
    async (overrides?: ProjectManifest['toolOverrides']) => {
      setProbing(true);
      try {
        const res = await window.archcanvas.probeEnvironment(overrides);
        if (res.ok) {
          setProbeReport(res.data);
        } else {
          showToast('error', `环境探测失败：${res.error.message}`);
        }
      } finally {
        setProbing(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    void runProbe();
    const unsub = window.archcanvas.onTaskUpdated((updatedTask) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === updatedTask.id);
        if (idx === -1) return [updatedTask, ...prev];
        const copy = [...prev];
        copy[idx] = updatedTask;
        return copy;
      });
    });
    return unsub;
  }, [runProbe]);

  const persistGraph = useCallback(
    async (nextGraph: CanvasGraph) => {
      setGraph(nextGraph);
      if (!projectDir) return;
      const res = await window.archcanvas.saveCanvasGraph(nextGraph);
      if (!res.ok) {
        showToast('error', `保存画布失败：${res.error.message}`);
      }
    },
    [projectDir, showToast]
  );

  const handleCreateProject = useCallback(async () => {
    const dirRes = await window.archcanvas.selectDirectory('选择新项目的存放文件夹');
    if (!dirRes.ok || !dirRes.data) return;
    const folderName = dirRes.data.split(/[\\/]/).filter(Boolean).pop() || '新建建筑项目';
    const res = await window.archcanvas.createProject({
      projectDir: dirRes.data,
      name: folderName,
      projectType: 'building',
    });
    if (!res.ok) {
      showToast('error', res.error.message);
      return;
    }
    setProjectDir(res.data.projectDir);
    setManifest(res.data.manifest);
    setGraph(res.data.graph);
    setAssets(res.data.assets);
    setTasks(res.data.tasks);
    setSelectedNodeId(null);
    showToast('info', `已创建项目：${res.data.manifest.name}`);
  }, [showToast]);

  const handleOpenProject = useCallback(async () => {
    const dirRes = await window.archcanvas.selectDirectory('选择已有构境画布项目目录');
    if (!dirRes.ok || !dirRes.data) return;
    const res = await window.archcanvas.openProject({ projectDir: dirRes.data });
    if (!res.ok) {
      showToast('error', res.error.message);
      return;
    }
    setProjectDir(res.data.projectDir);
    setManifest(res.data.manifest);
    setGraph(res.data.graph);
    setAssets(res.data.assets);
    setTasks(res.data.tasks);
    setSelectedNodeId(null);
    void runProbe(res.data.manifest.toolOverrides);
    showToast('info', `已打开项目：${res.data.manifest.name}（恢复 ${res.data.graph.nodes.length} 个节点）`);
  }, [runProbe, showToast]);

  const addNode = useCallback(
    (kind: NodeKind, extra?: Partial<CanvasNode>) => {
      if (!projectDir) {
        showToast('error', '请先新建或打开一个项目。');
        return;
      }
      const def = getNodeDefinition(kind);
      const id = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const count = graph.nodes.length;
      const newNode: CanvasNode = {
        id,
        kind,
        title: extra?.title ?? def.label,
        position: extra?.position ?? { x: 80 + (count % 4) * 280, y: 80 + Math.floor(count / 4) * 180 },
        status: kind === 'render_image' ? 'unconfigured' : 'idle',
        params: { ...def.defaultParams, ...(extra?.params ?? {}) },
        assetId: extra?.assetId,
      };
      const next: CanvasGraph = {
        ...graph,
        nodes: [...graph.nodes, newNode],
      };
      void persistGraph(next);
      setSelectedNodeId(id);
    },
    [graph, persistGraph, projectDir, showToast]
  );

  const importAndCreateNode = useCallback(
    async (filePath: string, dropPos?: { x: number; y: number }) => {
      if (!projectDir) {
        showToast('error', '请先新建或打开项目后再拖入文件。');
        return;
      }
      const res = await window.archcanvas.importSourceFile(filePath);
      if (!res.ok) {
        showToast('error', res.error.message);
        return;
      }
      const asset = res.data;
      setAssets((prev) => [asset, ...prev]);
      const nodeKind: NodeKind =
        asset.kind === 'image'
          ? 'reference_image'
          : asset.kind === 'model'
            ? 'existing_model'
            : 'drawing_file';
      addNode(nodeKind, {
        title: asset.originalName,
        assetId: asset.id,
        position: dropPos,
      });
      showToast('info', `已导入只读项目副本：${asset.originalName}`);
    },
    [addNode, projectDir, showToast]
  );

  const handleImportDialog = useCallback(async () => {
    if (!projectDir) {
      showToast('error', '请先新建或打开项目。');
      return;
    }
    const pick = await window.archcanvas.selectSourceFile();
    if (!pick.ok || !pick.data) return;
    await importAndCreateNode(pick.data);
  }, [importAndCreateNode, projectDir, showToast]);

  const handleImportSyntheticFixture = useCallback(
    async (fixtureName: 'sample_room_10000mm.dxf' | 'sample_room_10m.dxf' | 'sample_room_vector.pdf') => {
      if (!projectDir) {
        showToast('error', '请先新建或打开项目。');
        return;
      }
      const res = await window.archcanvas.importSyntheticFixture(fixtureName);
      if (!res.ok) {
        showToast('error', res.error.message);
        return;
      }
      const asset = res.data;
      setAssets((prev) => [asset, ...prev]);
      addNode('drawing_file', {
        title: asset.originalName,
        assetId: asset.id,
      });
      showToast('info', `已加载合成测试小样：${asset.originalName}`);
    },
    [addNode, projectDir, showToast]
  );

  const handleOpen3DViewport = useCallback(
    async (modelNode: CanvasNode) => {
      const summary = modelNode.outputSummary as Record<string, unknown> | undefined;
      const glbRelPath = typeof summary?.glbRelPath === 'string' ? summary.glbRelPath : null;
      const modelVersionId = typeof summary?.modelVersionId === 'string' ? summary.modelVersionId : null;
      const blendSha256 = typeof summary?.blendSha256 === 'string' ? summary.blendSha256 : null;
      if (!glbRelPath || !modelVersionId || !blendSha256) {
        showToast('error', '请先运行该「建筑模型」节点生成 .glb 预览模型后再打开 3D 视口。');
        return;
      }
      const res = await window.archcanvas.readProjectFile(glbRelPath);
      if (!res.ok) {
        showToast('error', `加载 GLB 失败：${res.error.message}`);
        return;
      }
      setViewerModal({
        modelNodeId: modelNode.id,
        sceneRef: { id: modelVersionId, version: modelVersionId, sha256: blendSha256 },
        glbBuffer: base64ToArrayBuffer(res.data.base64),
      });
    },
    [showToast]
  );

  const handleSaveCameraFromViewport = useCallback(
    (snapshot: CameraSnapshot) => {
      if (!viewerModal) return;
      const modelNode = graph.nodes.find((n) => n.id === viewerModal.modelNodeId);
      const existingCamCount = graph.nodes.filter((n) => n.kind === 'camera_frame').length;
      const camNodeId = `node-cam-${Date.now().toString(36)}`;
      const newCamNode: CanvasNode = {
        id: camNodeId,
        kind: 'camera_frame',
        title: snapshot.name,
        position: {
          x: (modelNode?.position.x ?? 400) + 300,
          y: (modelNode?.position.y ?? 100) + existingCamCount * 170,
        },
        status: 'idle',
        params: {
          name: snapshot.name,
          projection: snapshot.projection,
          widthPx: snapshot.widthPx,
          heightPx: snapshot.heightPx,
          cameraSnapshot: snapshot,
        },
      };
      const newEdge: CanvasEdge = {
        id: `edge-${Date.now().toString(36)}`,
        source: viewerModal.modelNodeId,
        sourceHandle: 'model',
        target: camNodeId,
        targetHandle: 'model',
        dataType: 'model_version',
      };
      const nextGraph: CanvasGraph = {
        ...graph,
        nodes: [...graph.nodes, newCamNode],
        edges: [...graph.edges, newEdge],
      };
      void persistGraph(nextGraph).then(() => window.archcanvas.runNodeTask(camNodeId)).then((res) => {
        if (res && res.ok) {
          setGraph(res.data.updatedGraph);
        }
      });
      setSelectedNodeId(camNodeId);
      showToast('info', `已保存相机视角「${snapshot.name}」为画框节点。`);
    },
    [graph, persistGraph, showToast, viewerModal]
  );

  const handleRunNode = useCallback(
    async (nodeId: string) => {
      const res = await window.archcanvas.runNodeTask(nodeId);
      if (!res.ok) {
        showToast('error', res.error.message);
        return;
      }
      setGraph(res.data.updatedGraph);
      if (res.data.task.status === 'succeeded') {
        showToast('info', `任务完成：${res.data.task.title}`);
      } else if (res.data.task.errorMessage) {
        showToast('error', res.data.task.errorMessage);
      }
    },
    [showToast]
  );

  const handleSelectExportDirectory = useCallback(async () => {
    if (!projectDir) {
      showToast('error', '请先新建或打开项目。');
      return;
    }
    const dirRes = await window.archcanvas.selectDirectory('选择项目默认导出目录');
    if (!dirRes.ok || !dirRes.data) return;
    const upd = await window.archcanvas.updateSettings({ exportDirectory: dirRes.data });
    if (upd.ok) {
      setManifest(upd.data);
      showToast('info', `导出目录已设为：${dirRes.data}`);
    } else {
      showToast('error', upd.error.message);
    }
  }, [projectDir, showToast]);

  const handleSaveSettings = useCallback(
    async (patch: {
      exportDirectory?: string;
      toolOverrides?: ProjectManifest['toolOverrides'];
    }) => {
      if (!projectDir) return;
      const upd = await window.archcanvas.updateSettings(patch);
      if (upd.ok) {
        setManifest(upd.data);
        showToast('info', '本地工具配置已保存到项目。');
      } else {
        showToast('error', upd.error.message);
      }
    },
    [projectDir, showToast]
  );

  const flowNodes: Node<ArchNodeFlowData>[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'archNode',
        position: n.position,
        selected: n.id === selectedNodeId,
        data: { node: n, onRunNode: handleRunNode },
      })),
    [graph.nodes, handleRunNode, selectedNodeId]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
        animated: false,
        style: { stroke: '#60a5fa', strokeWidth: 2 },
      })),
    [graph.edges]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<ArchNodeFlowData>>[]) => {
      const updatedFlowNodes = applyNodeChanges(changes, flowNodes);
      const posMap = new Map(updatedFlowNodes.map((fn) => [fn.id, fn.position]));
      const removedIds = new Set(
        changes.filter((c) => c.type === 'remove').map((c) => c.id)
      );
      const hasDragEndOrRemove = changes.some(
        (c) => (c.type === 'position' && c.dragging === false) || c.type === 'remove'
      );

      const nextNodes = graph.nodes
        .filter((n) => !removedIds.has(n.id))
        .map((n) => ({
          ...n,
          position: posMap.get(n.id) ?? n.position,
        }));
      const nextEdges =
        removedIds.size > 0
          ? graph.edges.filter(
              (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
            )
          : graph.edges;

      const nextGraph: CanvasGraph = { ...graph, nodes: nextNodes, edges: nextEdges };
      if (hasDragEndOrRemove) {
        void persistGraph(nextGraph);
      } else {
        setGraph(nextGraph);
      }
    },
    [flowNodes, graph, persistGraph]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const updated = applyEdgeChanges(changes, flowEdges);
      const remainingIds = new Set(updated.map((e) => e.id));
      const nextEdges = graph.edges.filter((e) => remainingIds.has(e.id));
      if (nextEdges.length !== graph.edges.length) {
        void persistGraph({ ...graph, edges: nextEdges });
      }
    },
    [flowEdges, graph, persistGraph]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle ||
        !connection.targetHandle
      ) {
        return;
      }
      const check = validateConnection(graph, {
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
      });
      if (!check.valid || !check.dataType) {
        showToast('error', check.reason ?? '不允许的连线。');
        return;
      }
      const newEdge: CanvasEdge = {
        id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
        dataType: check.dataType,
      };
      const nextGraph = markDownstreamStale(
        { ...graph, edges: [...graph.edges, newEdge] },
        connection.target
      );
      void persistGraph(nextGraph);
    },
    [graph, persistGraph, showToast]
  );

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId]
  );

  useEffect(() => {
    const summary = selectedNode?.outputSummary as Record<string, unknown> | undefined;
    const pngRel = typeof summary?.pngRelPath === 'string' ? summary.pngRelPath : null;
    if (!pngRel) {
      setPreviewPngDataUrl(null);
      return;
    }
    let active = true;
    void window.archcanvas.readProjectFile(pngRel).then((res) => {
      if (active && res.ok) {
        setPreviewPngDataUrl(`data:image/png;base64,${res.data.base64}`);
      }
    });
    return () => {
      active = false;
    };
  }, [selectedNode]);

  const updateSelectedNodeParam = useCallback(
    (key: string, value: unknown) => {
      if (!selectedNode) return;
      const patchedGraph: CanvasGraph = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === selectedNode.id
            ? { ...n, params: { ...n.params, [key]: value } }
            : n
        ),
      };
      const withStale = markDownstreamStale(patchedGraph, selectedNode.id);
      void persistGraph(withStale);
    },
    [graph, persistGraph, selectedNode]
  );

  const blenderTool = probeReport?.tools.find((t) => t.id === 'blender');
  const pythonTool = probeReport?.tools.find((t) => t.id === 'python');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">构境画布 / ArchCanvas</span>
          <button className="primary" onClick={handleCreateProject}>
            新建项目
          </button>
          <button onClick={handleOpenProject}>打开项目</button>
          <button onClick={handleImportDialog} disabled={!projectDir}>
            导入图纸/素材
          </button>
          <button
            onClick={() => void handleImportSyntheticFixture('sample_room_10000mm.dxf')}
            disabled={!projectDir}
          >
            加载合成 DXF
          </button>
          <button
            onClick={() => void handleImportSyntheticFixture('sample_room_vector.pdf')}
            disabled={!projectDir}
          >
            加载合成向量 PDF
          </button>
          <button onClick={handleSelectExportDirectory} disabled={!projectDir}>
            导出目录
          </button>
        </div>

        <div className="topbar-right">
          {manifest ? (
            <span className="badge badge-ok" title={projectDir ?? ''}>
              项目：{manifest.name}
            </span>
          ) : (
            <span className="badge">未打开项目</span>
          )}
          <span className={pythonTool?.available ? 'badge badge-ok' : 'badge badge-err'}>
            Python: {pythonTool?.available ? '就绪' : '缺失'}
          </span>
          <span className={blenderTool?.available ? 'badge badge-ok' : 'badge badge-err'}>
            Blender: {blenderTool?.available ? '就绪' : '缺失'}
          </span>
          <span className={probeReport?.aiProvidersConfigured ? 'badge badge-ok' : 'badge badge-warn'}>
            AI: {probeReport?.aiProvidersConfigured ? '已配置' : '未配置服务'}
          </span>
          <button onClick={() => setShowSettings(true)}>环境与设置</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="section-title">核心节点库</div>
          {G0_PALETTE_KINDS.map((kind) => {
            const def = NODE_REGISTRY[kind];
            return (
              <button
                key={kind}
                className="node-palette-btn"
                disabled={!projectDir}
                onClick={() => addNode(kind)}
              >
                <strong>
                  {def.label}
                  {def.executableInG0 ? ' ●' : ''}
                </strong>
                <small>{def.description}</small>
              </button>
            );
          })}

          <div className="section-title">项目素材库（{assets.length}）</div>
          {assets.length === 0 ? (
            <div style={{ color: '#9aa7b8', fontSize: 12 }}>
              暂无导入素材。可将 DXF / PDF / DWG / 图片直接拖入画布。
            </div>
          ) : (
            assets.map((a) => (
              <div
                key={a.id}
                style={{
                  padding: '6px 8px',
                  border: '1px solid #2d3748',
                  borderRadius: 6,
                  marginBottom: 6,
                  background: '#0f1216',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 12 }}>{a.originalName}</div>
                <div style={{ fontSize: 11, color: '#9aa7b8' }}>
                  {a.kind.toUpperCase()} · {(a.byteSize / 1024).toFixed(1)} KB · #{a.sha256.slice(0, 8)}
                </div>
              </div>
            ))
          )}
        </aside>

        <main
          className="canvas-area"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingFile(true);
          }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingFile(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;
            const filePath = window.archcanvas.getPathForFile(files[0]!);
            if (filePath) {
              void importAndCreateNode(filePath, { x: 160, y: 120 });
            } else {
              showToast('error', '无法读取拖入文件的本地路径。');
            }
          }}
        >
          {toast && <div className={`toast-banner ${toast.kind}`}>{toast.message}</div>}
          {isDraggingFile && <div className="drop-overlay">松开以导入到当前项目只读素材库</div>}

          {!projectDir ? (
            <div className="empty-state">
              <h2 style={{ margin: 0, color: '#eef2f7' }}>欢迎使用构境画布（ArchCanvas）</h2>
              <div style={{ maxWidth: 460 }}>
                纯本地优先的建筑设计无限画布。无 API Key 也可完成图纸导入、单位校准、Blender 建模与原生交付。
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="primary" onClick={handleCreateProject}>
                  新建本地项目
                </button>
                <button onClick={handleOpenProject}>打开已有项目</button>
                <button onClick={() => setShowSettings(true)}>检查本机环境</button>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_ev, n) => setSelectedNodeId(n.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              fitView
            >
              <Background gap={20} size={1} color="#26303d" />
              <Controls />
              <MiniMap style={{ background: '#161b22' }} />
            </ReactFlow>
          )}
        </main>

        <aside className="inspector">
          <div className="section-title">属性与参数</div>
          {!selectedNode ? (
            <div style={{ color: '#9aa7b8', fontSize: 12 }}>
              点击画布中的任意节点以编辑参数、查看真实文件输出或执行任务。
              {manifest?.exportDirectory && (
                <div style={{ marginTop: 12 }}>
                  <div>默认导出目录：</div>
                  <div style={{ color: '#93c5fd', wordBreak: 'break-all', marginTop: 4 }}>
                    {manifest.exportDirectory}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="field">
                <label>节点标题</label>
                <input
                  value={selectedNode.title}
                  onChange={(e) => {
                    const nextGraph: CanvasGraph = {
                      ...graph,
                      nodes: graph.nodes.map((n) =>
                        n.id === selectedNode.id ? { ...n, title: e.target.value } : n
                      ),
                    };
                    void persistGraph(nextGraph);
                  }}
                />
              </div>

              {selectedNode.kind === 'drawing_calibrate' && (
                <>
                  <div className="field">
                    <label>比例修正系数（scaleFactor）</label>
                    <input
                      type="number"
                      step="0.01"
                      value={Number(selectedNode.params.scaleFactor ?? 1)}
                      onChange={(e) =>
                        updateSelectedNodeParam('scaleFactor', Number(e.target.value) || 1)
                      }
                    />
                  </div>
                  <div className="field">
                    <label>楼层名称</label>
                    <input
                      value={String(selectedNode.params.floorName ?? '1F')}
                      onChange={(e) => updateSelectedNodeParam('floorName', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>楼层底标高（米）</label>
                    <input
                      type="number"
                      step="0.1"
                      value={Number(selectedNode.params.floorElevationM ?? 0)}
                      onChange={(e) =>
                        updateSelectedNodeParam('floorElevationM', Number(e.target.value) || 0)
                      }
                    />
                  </div>
                  <div className="field">
                    <label>北向偏角（度）</label>
                    <input
                      type="number"
                      step="1"
                      value={Number(selectedNode.params.northAngleDeg ?? 0)}
                      onChange={(e) =>
                        updateSelectedNodeParam('northAngleDeg', Number(e.target.value) || 0)
                      }
                    />
                  </div>
                </>
              )}

              {selectedNode.kind === 'drawing_recognize' && (
                <>
                  <div className="field">
                    <label>默认墙厚（米，仅单线墙使用）</label>
                    <input
                      type="number"
                      step="0.02"
                      value={Number(selectedNode.params.wallThicknessDefaultM ?? 0.24)}
                      onChange={(e) =>
                        updateSelectedNodeParam('wallThicknessDefaultM', Number(e.target.value) || 0.24)
                      }
                    />
                  </div>
                  <div className="field">
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={Boolean(selectedNode.params.includeFurniture ?? false)}
                        onChange={(e) => updateSelectedNodeParam('includeFurniture', e.target.checked)}
                      />
                      包含家具图层（默认无家具）
                    </label>
                  </div>
                </>
              )}

              {selectedNode.kind === 'building_model' && (
                <>
                  <div className="field">
                    <label>层数（storeys）</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={Number(selectedNode.params.storeys ?? 1)}
                      onChange={(e) =>
                        updateSelectedNodeParam('storeys', Math.max(1, Number(e.target.value) || 1))
                      }
                    />
                  </div>
                  <div className="field">
                    <label>层高（米，floorHeightM）</label>
                    <input
                      type="number"
                      step="0.1"
                      value={Number(selectedNode.params.floorHeightM ?? 4.5)}
                      onChange={(e) =>
                        updateSelectedNodeParam('floorHeightM', Number(e.target.value) || 4.5)
                      }
                    />
                  </div>
                  <div className="field">
                    <label>暂定门洞高度（米）</label>
                    <input
                      type="number"
                      step="0.1"
                      value={Number(selectedNode.params.defaultDoorHeightM ?? 2.1)}
                      onChange={(e) =>
                        updateSelectedNodeParam('defaultDoorHeightM', Number(e.target.value) || 2.1)
                      }
                    />
                  </div>
                  <div className="field">
                    <label>屋顶形式</label>
                    <select
                      value={String(selectedNode.params.roofStyle ?? 'flat')}
                      onChange={(e) => updateSelectedNodeParam('roofStyle', e.target.value)}
                    >
                      <option value="flat">平屋顶（可揭顶）</option>
                      <option value="gable">双坡屋顶（真实屋脊与出檐）</option>
                    </select>
                  </div>
                  {selectedNode.params.roofStyle === 'gable' && (
                    <div className="field" style={{ display: 'flex', gap: 6 }}>
                      <div style={{ flex: 1 }}>
                        <label>屋脊高（米）</label>
                        <input
                          type="number"
                          step="0.1"
                          value={Number(selectedNode.params.ridgeHeightM ?? 1.8)}
                          onChange={(e) => updateSelectedNodeParam('ridgeHeightM', Number(e.target.value))}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label>出檐（米）</label>
                        <input
                          type="number"
                          step="0.1"
                          value={Number(selectedNode.params.eaveOverhangM ?? 0.6)}
                          onChange={(e) => updateSelectedNodeParam('eaveOverhangM', Number(e.target.value))}
                        />
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={Boolean(selectedNode.params.includeSteps ?? false)}
                        onChange={(e) => updateSelectedNodeParam('includeSteps', e.target.checked)}
                      />
                      生成入口台阶（独立于坡道）
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={Boolean(selectedNode.params.includeRamp ?? false)}
                        onChange={(e) => updateSelectedNodeParam('includeRamp', e.target.checked)}
                      />
                      生成连续坡道与分边扶手
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={Boolean(selectedNode.params.includeDrainageApron ?? false)}
                        onChange={(e) => updateSelectedNodeParam('includeDrainageApron', e.target.checked)}
                      />
                      生成散水（独立材料槽）
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={Boolean(selectedNode.params.includeGrille ?? false)}
                        onChange={(e) => updateSelectedNodeParam('includeGrille', e.target.checked)}
                      />
                      生成落地格栅（核对底标高不悬空）
                    </label>
                  </div>
                  <div className="field">
                    <button
                      className="primary"
                      style={{ width: '100%', marginBottom: 6 }}
                      onClick={() => void handleOpen3DViewport(selectedNode)}
                    >
                      打开 3D 视口浏览并保存相机
                    </button>
                    <button
                      style={{ width: '100%' }}
                      onClick={async () => {
                        const res = await window.archcanvas.refreshStaleDownstream(selectedNode.id);
                        if (res.ok) {
                          setGraph(res.data.updatedGraph);
                          showToast('info', `已批量刷新 ${res.data.refreshedNodeIds.length} 个过期下游视角/节点。`);
                        } else {
                          showToast('error', res.error.message);
                        }
                      }}
                    >
                      批量更新过期下游视角
                    </button>
                  </div>
                </>
              )}

              {selectedNode.kind === 'site_compose' && (
                <>
                  <div className="field">
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={selectedNode.params.enableLHostBuilding !== false}
                        onChange={(e) => updateSelectedNodeParam('enableLHostBuilding', e.target.checked)}
                      />
                      启用 L 型主楼内院包裹约束
                    </label>
                  </div>
                  <div className="field">
                    <label>内院与两翼净距（米）</label>
                    <input
                      type="number"
                      step="0.5"
                      value={Number(selectedNode.params.courtyardGapM ?? 4.0)}
                      onChange={(e) => updateSelectedNodeParam('courtyardGapM', Number(e.target.value))}
                    />
                  </div>
                  <div className="field">
                    <button
                      className="primary"
                      style={{ width: '100%' }}
                      onClick={() => void handleOpen3DViewport(selectedNode)}
                    >
                      打开组合场地 3D 视口
                    </button>
                  </div>
                </>
              )}

              {selectedNode.kind === 'local_edit' && (
                <>
                  <div className="field">
                    <label>修改类型（严禁混淆几何修订与图片修饰）</label>
                    <select
                      value={String(selectedNode.params.scope ?? 'image_only')}
                      onChange={(e) => updateSelectedNodeParam('scope', e.target.value)}
                    >
                      <option value="image_only">仅图片修饰（明示未同步模型）</option>
                      <option value="geometry">模型构件修改（写回模型并同步全部视角）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>修改说明</label>
                    <input
                      value={String(selectedNode.params.instruction ?? '')}
                      onChange={(e) => updateSelectedNodeParam('instruction', e.target.value)}
                      placeholder="例如：去掉临时管线 / 坡道左端接地"
                    />
                  </div>
                </>
              )}

              {selectedNode.kind === 'material' && (
                <>
                  <div className="field">
                    <label>目标材料槽（仅改材质，不改几何与门窗）</label>
                    <select
                      value={String(selectedNode.params.slotName ?? 'exterior_wall')}
                      onChange={(e) => updateSelectedNodeParam('slotName', e.target.value)}
                    >
                      <option value="exterior_wall">外墙墙板（exterior_wall）</option>
                      <option value="grille">建筑格栅（grille）</option>
                      <option value="floor_slab">地面/楼板（floor_slab）</option>
                      <option value="roof_cap">屋顶/顶板（roof_cap）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>目标色值（Hex）</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="color"
                        style={{ width: 42, padding: 2 }}
                        value={String(selectedNode.params.baseColorHex ?? '#D9DDE2')}
                        onChange={(e) => updateSelectedNodeParam('baseColorHex', e.target.value)}
                      />
                      <input
                        value={String(selectedNode.params.baseColorHex ?? '#D9DDE2')}
                        onChange={(e) => updateSelectedNodeParam('baseColorHex', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>粗糙度（0–1）</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={Number(selectedNode.params.roughness ?? 0.65)}
                      onChange={(e) => updateSelectedNodeParam('roughness', Number(e.target.value))}
                    />
                  </div>
                </>
              )}

              {selectedNode.kind === 'reference_image' && (
                <>
                  <div className="field">
                    <label>参考图显式角色（严禁越权改几何）</label>
                    <select
                      value={String(selectedNode.params.role ?? 'lighting_style')}
                      onChange={(e) => updateSelectedNodeParam('role', e.target.value)}
                    >
                      <option value="camera">仅视角/构图参考（不复制旧立面）</option>
                      <option value="material">仅材质/颜色参考</option>
                      <option value="lighting_style">仅光影/天气风格参考</option>
                      <option value="landscape_layout">仅景观布局参考</option>
                      <option value="edit_target">局部编辑底图</option>
                      <option value="geometry_evidence">几何证据</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>权重（0–1）</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="1"
                      value={Number(selectedNode.params.weight ?? 0.7)}
                      onChange={(e) => updateSelectedNodeParam('weight', Number(e.target.value))}
                    />
                  </div>
                </>
              )}

              {selectedNode.kind === 'prompt' && (
                <>
                  <div className="field">
                    <label>保持项（不可改变的建筑事实）</label>
                    <input
                      value={String(selectedNode.params.keep ?? '')}
                      onChange={(e) => updateSelectedNodeParam('keep', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>本次明确修改项</label>
                    <input
                      value={String(selectedNode.params.modify ?? '')}
                      onChange={(e) => updateSelectedNodeParam('modify', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>负向限制</label>
                    <input
                      value={String(selectedNode.params.negative ?? '')}
                      onChange={(e) => updateSelectedNodeParam('negative', e.target.value)}
                    />
                  </div>
                </>
              )}

              {selectedNode.kind === 'render_image' && (
                <>
                  <div className="field">
                    <label>表现模式</label>
                    <select
                      value={String(selectedNode.params.mode ?? 'model_constrained')}
                      onChange={(e) => updateSelectedNodeParam('mode', e.target.value)}
                    >
                      <option value="model_constrained">模型约束增强（须复核几何）</option>
                      <option value="concept_exploration">概念效果探索（非严格按图）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>图像生成服务</label>
                    <select
                      value={String(selectedNode.params.providerId ?? 'unconfigured')}
                      onChange={(e) => updateSelectedNodeParam('providerId', e.target.value)}
                    >
                      <option value="unconfigured">未配置服务</option>
                      <option value="mock_simulator">内置测试模拟器（仅联调）</option>
                      <option value="openai_default">OpenAI 兼容服务（需在设置配置 Key）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>请求尺寸（须受模型能力支持，不伪造原生 4K）</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="number"
                        value={Number(selectedNode.params.widthPx ?? 1024)}
                        onChange={(e) => updateSelectedNodeParam('widthPx', Number(e.target.value))}
                      />
                      <input
                        type="number"
                        value={Number(selectedNode.params.heightPx ?? 1024)}
                        onChange={(e) => updateSelectedNodeParam('heightPx', Number(e.target.value))}
                      />
                    </div>
                  </div>
                  {previewPngDataUrl && (
                    <div className="field">
                      <label>效果图预览（须与底图核对门窗轮廓）</label>
                      <img
                        src={previewPngDataUrl}
                        alt="效果图预览"
                        style={{ width: '100%', borderRadius: 6, border: '1px solid #2d3748' }}
                      />
                    </div>
                  )}
                </>
              )}

              {selectedNode.kind === 'native_render' && (
                <>
                  <div className="field">
                    <label>渲染引擎</label>
                    <select
                      value={String(selectedNode.params.engine ?? 'EEVEE')}
                      onChange={(e) => updateSelectedNodeParam('engine', e.target.value)}
                    >
                      <option value="EEVEE">EEVEE（快速白模预览）</option>
                      <option value="CYCLES">Cycles（光线追踪）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>输出宽度（px）</label>
                    <input
                      type="number"
                      value={Number(selectedNode.params.widthPx ?? 1280)}
                      onChange={(e) =>
                        updateSelectedNodeParam('widthPx', Math.max(256, Number(e.target.value) || 1280))
                      }
                    />
                  </div>
                  <div className="field">
                    <label>输出高度（px）</label>
                    <input
                      type="number"
                      value={Number(selectedNode.params.heightPx ?? 720)}
                      onChange={(e) =>
                        updateSelectedNodeParam('heightPx', Math.max(256, Number(e.target.value) || 720))
                      }
                    />
                  </div>
                  <div className="field">
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: 'auto', marginRight: 6 }}
                        checked={Boolean(selectedNode.params.hideRoofCap ?? false)}
                        onChange={(e) => updateSelectedNodeParam('hideRoofCap', e.target.checked)}
                      />
                      揭顶显示（隐藏顶板，不修改模型）
                    </label>
                  </div>
                  {previewPngDataUrl && (
                    <div className="field">
                      <label>原生渲染结果预览</label>
                      <img
                        src={previewPngDataUrl}
                        alt="原生渲染预览"
                        style={{
                          width: '100%',
                          borderRadius: 6,
                          border: '1px solid #2d3748',
                          display: 'block',
                        }}
                      />
                    </div>
                  )}
                </>
              )}

              {selectedNode.kind === 'camera_path' && (
                <>
                  <div className="field">
                    <label>帧率（fps）</label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={Number(selectedNode.params.fps ?? 12)}
                      onChange={(e) => updateSelectedNodeParam('fps', Number(e.target.value) || 12)}
                    />
                  </div>
                  <div className="field">
                    <label>时长（秒，支持断点续传已校验帧）</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0.5"
                      value={Number(selectedNode.params.durationSec ?? 1.0)}
                      onChange={(e) =>
                        updateSelectedNodeParam('durationSec', Number(e.target.value) || 1.0)
                      }
                    />
                  </div>
                  <div className="field" style={{ display: 'flex', gap: 6 }}>
                    <div style={{ flex: 1 }}>
                      <label>宽（px）</label>
                      <input
                        type="number"
                        value={Number(selectedNode.params.widthPx ?? 640)}
                        onChange={(e) => updateSelectedNodeParam('widthPx', Number(e.target.value))}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label>高（px）</label>
                      <input
                        type="number"
                        value={Number(selectedNode.params.heightPx ?? 360)}
                        onChange={(e) => updateSelectedNodeParam('heightPx', Number(e.target.value))}
                      />
                    </div>
                  </div>
                </>
              )}

              {selectedNode.kind === 'video' && (
                <>
                  <div className="field">
                    <label>视频路线（严格区分模型路径与生成式）</label>
                    <select
                      value={String(selectedNode.params.mode ?? 'model_path')}
                      onChange={(e) => updateSelectedNodeParam('mode', e.target.value)}
                    >
                      <option value="model_path">模型路径渲染（结构稳定）</option>
                      <option value="generative">生成式视频（须复核跨帧漂移）</option>
                    </select>
                  </div>
                  {selectedNode.params.mode === 'generative' && (
                    <div className="field">
                      <label>视频服务适配器</label>
                      <select
                        value={String(selectedNode.params.providerId ?? 'unconfigured')}
                        onChange={(e) => updateSelectedNodeParam('providerId', e.target.value)}
                      >
                        <option value="unconfigured">未配置服务</option>
                        <option value="mock_simulator">内置视频测试模拟器</option>
                        <option value="openai_default">OpenAI 兼容视频服务</option>
                      </select>
                    </div>
                  )}
                </>
              )}

              {selectedNode.kind === 'export' && (
                <>
                  <div className="field">
                    <label>当前导出目录</label>
                    <div style={{ fontSize: 11, color: '#93c5fd', wordBreak: 'break-all', marginBottom: 6 }}>
                      {manifest?.exportDirectory ?? '项目默认 exports/'}
                    </div>
                    <button onClick={handleSelectExportDirectory}>更改导出目录</button>
                  </div>
                  <div className="field">
                    <label>图片导出格式（真实编码与回读校验）</label>
                    <select
                      value={String(selectedNode.params.imageFormat ?? 'PNG')}
                      onChange={(e) => updateSelectedNodeParam('imageFormat', e.target.value)}
                    >
                      <option value="PNG">PNG（支持透明通道）</option>
                      <option value="JPEG">JPEG（白底合成）</option>
                      <option value="WEBP">WebP（高压缩比）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>长边像素（留空保持原尺寸；放大如实标为重采样）</label>
                    <input
                      type="number"
                      placeholder="例如 3840（长边 4K，非原生 UHD）"
                      value={selectedNode.params.longEdgePx ? Number(selectedNode.params.longEdgePx) : ''}
                      onChange={(e) =>
                        updateSelectedNodeParam(
                          'longEdgePx',
                          e.target.value ? Number(e.target.value) : undefined
                        )
                      }
                    />
                  </div>
                  <div className="field">
                    <label>模型导出格式（不改后缀伪造 SKP/MAX）</label>
                    <select
                      value={
                        Array.isArray(selectedNode.params.modelFormats)
                          ? (selectedNode.params.modelFormats as string[]).join(',')
                          : 'blend,glb,fbx,obj'
                      }
                      onChange={(e) =>
                        updateSelectedNodeParam('modelFormats', e.target.value.split(','))
                      }
                    >
                      <option value="blend,glb">BLEND + GLB（默认）</option>
                      <option value="blend,glb,fbx,obj,dae">
                        BLEND + GLB + FBX + OBJ/MTL + DAE（兼容 SU / 3ds Max）
                      </option>
                    </select>
                  </div>
                </>
              )}

              <div className="section-title">真实输出摘要</div>
              {selectedNode.outputSummary ? (
                <div className="kv-box">
                  {JSON.stringify(selectedNode.outputSummary, null, 2)}
                </div>
              ) : (
                <div style={{ color: '#9aa7b8', fontSize: 12 }}>尚未产出执行结果。</div>
              )}
            </div>
          )}
        </aside>
      </div>

      <section className="task-panel">
        <div className="task-panel-header">
          <span>任务队列（{tasks.length}）</span>
          <span style={{ color: '#9aa7b8', fontWeight: 400, fontSize: 11 }}>
            调整画布布局不触发任务；仅点击“运行节点”后实际执行
          </span>
        </div>
        <div className="task-list">
          {tasks.length === 0 ? (
            <div style={{ color: '#9aa7b8', fontSize: 12, paddingTop: 8 }}>
              暂无任务记录。连接「图纸文件 → 图纸校准 → 导出交付」并点击运行节点以验证真实数据链。
            </div>
          ) : (
            tasks.map((task) => {
              const st = TASK_STATUS_LABEL[task.status] ?? TASK_STATUS_LABEL.draft;
              return (
                <div key={task.id} className="task-row">
                  <span className={st.cls}>{st.text}</span>
                  <span title={task.errorMessage ?? task.title}>
                    {task.title}
                    {task.errorMessage ? ` — ${task.errorMessage}` : ''}
                  </span>
                  <span style={{ color: '#9aa7b8' }}>
                    {task.stage ?? '-'}
                    {task.completed != null && task.total != null
                      ? ` (${task.completed}/${task.total})`
                      : ''}
                  </span>
                  <span
                    style={{
                      color: '#93c5fd',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={task.outputPath ?? ''}
                  >
                    {task.outputPath ?? '-'}
                  </span>
                  <div>
                    {task.status === 'running' && (
                      <button onClick={() => void window.archcanvas.cancelTask(task.id)}>
                        取消
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {viewerModal && (
        <div className="modal-backdrop" onClick={() => setViewerModal(null)}>
          <div
            className="modal-card"
            style={{ width: 960, height: 680 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>3D 模型视口（Three.js 预览 · 建筑 Z-up 相机对齐）</span>
              <button onClick={() => setViewerModal(null)}>关闭视口</button>
            </div>
            <div className="modal-body" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <Viewport3D
                glbBuffer={viewerModal.glbBuffer}
                sceneRef={viewerModal.sceneRef}
                onSaveCamera={handleSaveCameraFromViewport}
              />
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          report={probeReport}
          manifest={manifest}
          probing={probing}
          onReprobe={runProbe}
          onSaveSettings={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
};
