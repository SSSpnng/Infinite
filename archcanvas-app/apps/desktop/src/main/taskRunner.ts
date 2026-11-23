import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  CameraSnapshotSchema,
  SCHEMA_VERSION,
  WorkerEventSchema,
  type CameraSnapshot,
  type CanvasGraph,
  type CanvasNode,
  type ReferenceRole,
  type TaskRecord,
  type Vec3,
  type WorkerRequest,
} from '@archcanvas/contracts';
import {
  compileArchitecturalPrompt,
  MockSimulatorAdapter,
  MockVideoSimulatorAdapter,
  OpenAiCompatAdapter,
  OpenAiCompatVideoAdapter,
  type ProviderAdapter,
  type ReferenceInputItem,
} from '@archcanvas/providers';
import {
  resolveBlenderExecutable,
  resolveBlenderWorkerScript,
  resolveDefaultPythonExecutable,
  resolveGeometryWorkerScript,
  resolveImageExporterScript,
} from './envProbe.js';
import { CredentialStore } from './credentialStore.js';
import { computeFileSha256, type ProjectStore } from './projectStore.js';

const execFileAsync = promisify(execFile);

export type TaskUpdateListener = (task: TaskRecord) => void;

function buildDefaultArchLookAtMatrix(
  eye: Vec3,
  target: Vec3,
  up: Vec3 = [0, 0, 1]
): number[] {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  const zAxis = norm(sub(eye, target));
  let xRaw = cross(up, zAxis);
  if (Math.hypot(xRaw[0], xRaw[1], xRaw[2]) < 1e-6) {
    xRaw = cross([0, 1, 0], zAxis);
  }
  const xAxis = norm(xRaw);
  const yAxis = norm(cross(zAxis, xAxis));

  return [
    xAxis[0], xAxis[1], xAxis[2], 0,
    yAxis[0], yAxis[1], yAxis[2], 0,
    zAxis[0], zAxis[1], zAxis[2], 0,
    eye[0], eye[1], eye[2], 1,
  ];
}

export class TaskRunner {
  private activeProcesses = new Map<string, ChildProcess>();
  private listeners = new Set<TaskUpdateListener>();
  private readonly adapters: Record<'openai_compat' | 'mock_simulator', ProviderAdapter> = {
    openai_compat: new OpenAiCompatAdapter(),
    mock_simulator: new MockSimulatorAdapter(),
  };

  constructor(
    private readonly store: ProjectStore,
    private readonly appRootDir: string,
    private readonly credentials: CredentialStore = new CredentialStore()
  ) {}

  public onTaskUpdate(listener: TaskUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitUpdate(task: TaskRecord): void {
    this.store.upsertTask(task);
    for (const listener of this.listeners) {
      listener(task);
    }
  }

  public cancelTask(taskId: string): boolean {
    const child = this.activeProcesses.get(taskId);
    if (!child) return false;
    child.kill();
    this.activeProcesses.delete(taskId);
    return true;
  }

  public getAdapter(kind: 'openai_compat' | 'mock_simulator'): ProviderAdapter {
    return this.adapters[kind];
  }

  /**
   * 批量刷新某模型节点下游所有过期（stale）的相机与原生渲染节点（总规格 §3.5 & §17 B08）
   */
  public async refreshStaleDownstream(
    rootNodeId: string
  ): Promise<{ updatedGraph: CanvasGraph; refreshedNodeIds: string[] }> {
    const snap = this.store.getSnapshot();
    const order = this.collectDownstreamTopoOrder(snap.graph, rootNodeId);
    const refreshedNodeIds: string[] = [];

    for (const nodeId of order) {
      const currentSnap = this.store.getSnapshot();
      const node = currentSnap.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.status !== 'stale') continue;
      if (['material', 'camera_frame', 'native_render', 'render_image'].includes(node.kind)) {
        await this.runNodeTask(nodeId);
        refreshedNodeIds.push(nodeId);
      }
    }

    return {
      updatedGraph: this.store.getSnapshot().graph,
      refreshedNodeIds,
    };
  }

  private collectDownstreamTopoOrder(graph: CanvasGraph, startId: string): string[] {
    const reachable = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of graph.edges) {
        if (e.source === cur && !reachable.has(e.target)) {
          reachable.add(e.target);
          queue.push(e.target);
        }
      }
    }
    const priority: Record<string, number> = {
      material: 1,
      camera_frame: 2,
      native_render: 3,
      render_image: 4,
      export: 5,
    };
    return Array.from(reachable).sort((a, b) => {
      const na = graph.nodes.find((n) => n.id === a);
      const nb = graph.nodes.find((n) => n.id === b);
      return (priority[na?.kind ?? ''] ?? 99) - (priority[nb?.kind ?? ''] ?? 99);
    });
  }

  private markDownstreamOutdated(
    graph: CanvasGraph,
    sourceNodeId: string,
    reason: string
  ): CanvasGraph {
    const downstream = new Set(this.collectDownstreamTopoOrder(graph, sourceNodeId));
    if (downstream.size === 0) return graph;
    const nextNodes = graph.nodes.map((n) => {
      if (!downstream.has(n.id)) return n;
      if (n.status === 'idle' || n.status === 'unconfigured') return n;
      return {
        ...n,
        status: 'stale' as const,
        outputSummary: n.outputSummary
          ? { ...n.outputSummary, outdated: true, staleReason: reason }
          : { outdated: true, staleReason: reason },
      };
    });
    return this.store.saveCanvasGraph({ ...graph, nodes: nextNodes });
  }

  public async runNodeTask(nodeId: string): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const snapshot = this.store.getSnapshot();
    const projectDir = snapshot.projectDir;
    const manifest = snapshot.manifest;
    const graph = snapshot.graph;

    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`找不到画布节点：${nodeId}`);
    }

    if (node.kind === 'drawing_file') {
      return this.runInspectDrawing(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'drawing_calibrate') {
      return this.runCalibrateDrawing(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'drawing_recognize') {
      return this.runRecognizeDrawing(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'building_model') {
      return this.runBuildModel(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'existing_model') {
      return this.runImportExistingModel(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'site_compose') {
      return this.runComposeSite(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'material') {
      return this.runMaterialNode(node, graph, manifest.projectId);
    }
    if (node.kind === 'camera_frame') {
      return this.runCameraFrame(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'native_render') {
      return this.runNativeRender(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'reference_image') {
      return this.runReferenceImageNode(node, graph, manifest.projectId);
    }
    if (node.kind === 'prompt') {
      return this.runPromptNode(node, graph, manifest.projectId);
    }
    if (node.kind === 'render_image') {
      return this.runAiRenderImage(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'local_edit') {
      return this.runLocalEdit(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'camera_path') {
      return this.runCameraPath(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'video') {
      return this.runVideoNode(node, graph, projectDir, manifest.projectId);
    }
    if (node.kind === 'export') {
      return this.runExportNode(node, graph, projectDir, manifest.projectId, manifest.exportDirectory);
    }

    const now = new Date().toISOString();
    const pendingTask: TaskRecord = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId: manifest.projectId,
      nodeId: node.id,
      operation: node.kind,
      title: `执行「${node.title}」`,
      status: 'unsupported_dependency',
      createdAt: now,
      finishedAt: now,
      inputSnapshot: { nodeId: node.id, kind: node.kind },
      errorCode: 'GATE_NOT_YET_ENABLED',
      errorMessage: `节点「${node.title}」将在后续关卡（G3/G4）接入。`,
    };
    this.emitUpdate(pendingTask);
    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'idle',
      lastError: pendingTask.errorMessage,
    });
    return { task: pendingTask, updatedGraph: nextGraph };
  }

  private updateNodeInGraph(
    graph: CanvasGraph,
    nodeId: string,
    patch: Partial<CanvasNode>
  ): CanvasGraph {
    const next: CanvasGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
    };
    return this.store.saveCanvasGraph(next);
  }

  private async runInspectDrawing(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    if (!node.assetId) {
      throw new Error(`节点「${node.title}」尚未绑定导入的图纸文件。`);
    }
    const asset = this.store.getAssetById(node.assetId);
    if (!asset) {
      throw new Error(`找不到关联的图纸资产：${node.assetId}`);
    }
    const sourcePath = this.store.resolveInsideProject(asset.relativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`项目内图纸文件丢失：${asset.relativePath}`);
    }

    const manifest = this.store.getManifest();
    const { task, reportPath, reportData } = await this.executePythonWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'inspect_drawing',
      title: `解析图纸：${asset.originalName}`,
      inputs: {
        sourcePath,
        assetId: asset.id,
        sha256: asset.sha256,
        dwgConverterPath: manifest?.toolOverrides?.dwgConverterPath,
      },
      parameters: node.params,
      archiveSubdir: 'drawings',
      archiveFileName: `${node.id}_inspect.json`,
    });

    const summarySlim = reportData
      ? {
          format: reportData.format,
          sourceFile: reportData.sourceFile,
          detectedUnit: reportData.detectedUnit,
          totalEntities: reportData.totalEntities,
          metersBounds: reportData.metersBounds,
          layers: reportData.layers,
          warnings: reportData.warnings,
        }
      : undefined;

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: reportPath,
      outputSummary: summarySlim,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runCalibrateDrawing(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'drawing'
    );
    if (!incoming) {
      throw new Error(`节点「${node.title}」缺少上游「图纸资源」连线。`);
    }
    const sourceNode = graph.nodes.find((n) => n.id === incoming.source);
    if (!sourceNode?.outputArtifactPath) {
      throw new Error(`请先执行上游节点「${sourceNode?.title ?? incoming.source}」生成图纸解析结果。`);
    }
    const inspectReportPath = this.store.resolveInsideProject(sourceNode.outputArtifactPath);
    if (!fs.existsSync(inspectReportPath)) {
      throw new Error(`上游图纸解析文件不存在：${sourceNode.outputArtifactPath}`);
    }

    const { task, reportPath, reportData } = await this.executePythonWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'calibrate_drawing',
      title: `校准图纸：${node.title}`,
      inputs: {
        inspectReportPath,
        upstreamNodeId: sourceNode.id,
        sourceAssetId: sourceNode.assetId ?? 'unknown',
      },
      parameters: node.params,
      archiveSubdir: 'drawings',
      archiveFileName: `${node.id}_calibrated.json`,
    });

    const summarySlim = reportData
      ? {
          sourceFile: reportData.sourceFile,
          floorName: reportData.floorName,
          floorElevationM: reportData.floorElevationM,
          calibratedSizeM: reportData.calibratedSizeM,
          effectiveUnitToMeters: reportData.effectiveUnitToMeters,
          warnings: reportData.warnings,
        }
      : undefined;

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: reportPath,
      outputSummary: summarySlim,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runRecognizeDrawing(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'calibrated'
    );
    if (!incoming) {
      throw new Error(`节点「${node.title}」缺少上游「校准图纸」连线。`);
    }
    const calNode = graph.nodes.find((n) => n.id === incoming.source);
    if (!calNode?.outputArtifactPath) {
      throw new Error(`请先执行上游节点「${calNode?.title ?? incoming.source}」。`);
    }
    const calibratedPath = this.store.resolveInsideProject(calNode.outputArtifactPath);
    if (!fs.existsSync(calibratedPath)) {
      throw new Error(`上游校准文件不存在：${calNode.outputArtifactPath}`);
    }

    const { task, reportPath, reportData } = await this.executePythonWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'recognize_drawing',
      title: `识别建筑语义：${node.title}`,
      inputs: { calibratedPath, sourceAssetId: calNode.id },
      parameters: node.params,
      archiveSubdir: 'drawings',
      archiveFileName: `${node.id}_semantics.json`,
    });

    const summarySlim = reportData
      ? {
          floorName: reportData.floorName,
          footprintSizeM: reportData.footprintSizeM,
          summary: reportData.summary,
          assumptions: reportData.assumptions,
        }
      : undefined;

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: reportPath,
      outputSummary: summarySlim,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runBuildModel(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'semantics'
    );
    if (!incoming) {
      throw new Error(`节点「${node.title}」缺少上游「建筑语义数据」连线。`);
    }
    const semNode = graph.nodes.find((n) => n.id === incoming.source);
    if (!semNode?.outputArtifactPath) {
      throw new Error(`请先执行上游节点「${semNode?.title ?? incoming.source}」。`);
    }
    const semanticsPath = this.store.resolveInsideProject(semNode.outputArtifactPath);
    if (!fs.existsSync(semanticsPath)) {
      throw new Error(`上游建筑语义文件不存在：${semNode.outputArtifactPath}`);
    }

    const prevVersionId = (node.outputSummary as Record<string, unknown> | undefined)
      ?.modelVersionId as string | undefined;
    const modelVersionId = `mv-${crypto.randomUUID().slice(0, 8)}`;

    const { task, archivedReportRel, reportData } = await this.executeBlenderWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'build_model',
      title: `Blender 建模：${node.title} (${modelVersionId})`,
      inputs: { semanticsPath, modelVersionId, parentModelVersionId: prevVersionId },
      parameters: node.params,
      archiveSubdir: path.posix.join('models', modelVersionId),
      filesToArchive: ['model.blend', 'preview.glb', 'validation_report.json'],
      primaryReportName: 'validation_report.json',
    });

    const modelSummary = reportData
      ? {
          modelVersionId,
          parentModelVersionId: prevVersionId,
          blenderVersion: reportData.blenderVersion,
          measuredBoundsM: reportData.measuredBoundsM,
          validation: reportData.validation,
          assumptions: reportData.assumptions,
          blendRelPath: path.posix.join('models', modelVersionId, 'model.blend'),
          glbRelPath: path.posix.join('models', modelVersionId, 'preview.glb'),
          blendSha256: reportData.blendSha256,
          glbSha256: reportData.glbSha256,
        }
      : undefined;

    let nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: archivedReportRel,
      outputSummary: modelSummary,
      lastError: task.errorMessage,
    });

    // 几何版本传播（B08）：模型更新后，下游已生成的相机/渲染结果保留可追溯，并自动标记为过期（stale）
    if (task.status === 'succeeded') {
      nextGraph = this.markDownstreamOutdated(
        nextGraph,
        node.id,
        `基于旧版模型，上游已更新至 ${modelVersionId}`
      );
    }

    return { task, updatedGraph: nextGraph };
  }

  private async runImportExistingModel(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    if (!node.assetId) {
      throw new Error(`现有模型节点「${node.title}」尚未绑定导入的模型文件。`);
    }
    const asset = this.store.getAssetById(node.assetId);
    if (!asset) {
      throw new Error(`找不到关联的模型资产：${node.assetId}`);
    }
    const sourcePath = this.store.resolveInsideProject(asset.relativePath);
    const modelVersionId = `mv-${crypto.randomUUID().slice(0, 8)}`;

    const { task, archivedReportRel, reportData } = await this.executeBlenderWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'import_existing_model',
      title: `安全导入现有模型：${asset.originalName} (${modelVersionId})`,
      inputs: { sourcePath, modelVersionId },
      parameters: node.params,
      archiveSubdir: path.posix.join('models', modelVersionId),
      filesToArchive: ['model.blend', 'preview.glb', 'validation_report.json'],
      primaryReportName: 'validation_report.json',
    });

    const summary = reportData
      ? {
          modelVersionId,
          sourceFile: reportData.sourceFile,
          autoexecDisabled: reportData.autoexecDisabled,
          meshObjectCount: reportData.meshObjectCount,
          collections: reportData.collections,
          measuredBoundsM: reportData.measuredBoundsM,
          blendRelPath: path.posix.join('models', modelVersionId, 'model.blend'),
          glbRelPath: path.posix.join('models', modelVersionId, 'preview.glb'),
          blendSha256: reportData.blendSha256,
          glbSha256: reportData.glbSha256,
        }
      : undefined;

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: archivedReportRel,
      outputSummary: summary,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runComposeSite(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'models'
    );
    if (!incoming) {
      throw new Error(`场地组合节点「${node.title}」缺少上游「模型版本」连线。`);
    }
    const modelNode = graph.nodes.find((n) => n.id === incoming.source);
    const mSummary = modelNode?.outputSummary as Record<string, unknown> | undefined;
    const blendRel = typeof mSummary?.blendRelPath === 'string' ? mSummary.blendRelPath : null;
    if (!blendRel) {
      throw new Error(`请先运行上游建筑模型节点「${modelNode?.title ?? incoming.source}」。`);
    }
    const newBuildingBlendPath = this.store.resolveInsideProject(blendRel);
    const sceneVersionId = `sv-${crypto.randomUUID().slice(0, 8)}`;

    const { task, archivedReportRel, reportData } = await this.executeBlenderWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'compose_site',
      title: `场地组合：${node.title} (${sceneVersionId})`,
      inputs: { newBuildingBlendPath, sceneVersionId },
      parameters: node.params,
      archiveSubdir: path.posix.join('scenes', sceneVersionId),
      filesToArchive: ['scene.blend', 'scene_preview.glb', 'site_report.json'],
      primaryReportName: 'site_report.json',
    });

    const sceneSummary = reportData
      ? {
          sceneVersionId,
          modelVersionId: sceneVersionId,
          sourceModelVersionId: mSummary?.modelVersionId,
          blenderVersion: reportData.blenderVersion,
          newBuildingBboxM: reportData.newBuildingBboxM,
          spatialConstraint: reportData.spatialConstraint,
          blendRelPath: path.posix.join('scenes', sceneVersionId, 'scene.blend'),
          glbRelPath: path.posix.join('scenes', sceneVersionId, 'scene_preview.glb'),
          blendSha256: reportData.sceneBlendSha256,
          glbSha256: reportData.sceneGlbSha256,
        }
      : undefined;

    let nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: archivedReportRel,
      outputSummary: sceneSummary,
      lastError: task.errorMessage,
    });
    if (task.status === 'succeeded') {
      nextGraph = this.markDownstreamOutdated(
        nextGraph,
        node.id,
        `场地组合已更新至 ${sceneVersionId}`
      );
    }
    return { task, updatedGraph: nextGraph };
  }

  private async runLocalEdit(
    node: CanvasNode,
    graph: CanvasGraph,
    _projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find((e) => e.target === node.id && e.targetHandle === 'image');
    if (!incoming) {
      throw new Error(`局部修改节点「${node.title}」缺少上游「图像成果」连线。`);
    }
    const srcNode = graph.nodes.find((n) => n.id === incoming.source);
    if (!srcNode?.outputArtifactPath) {
      throw new Error(`请先执行上游图像节点「${srcNode?.title ?? incoming.source}」。`);
    }

    const scope = node.params.scope === 'geometry' ? 'geometry' : 'image_only';
    const now = new Date().toISOString();

    if (scope === 'geometry') {
      // 几何修改引导回模型参数，绝不把仅图片修补冒充为已修改所有视角
      const task: TaskRecord = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        projectId,
        nodeId: node.id,
        operation: 'local_edit_geometry_redirect',
        title: `几何构件修订指引：${node.title}`,
        status: 'needs_input',
        stage: 'redirect_to_model',
        createdAt: now,
        finishedAt: now,
        inputSnapshot: { scope, instruction: node.params.instruction },
        errorCode: 'GEOMETRY_EDIT_REQUIRES_MODEL_REBUILD',
        errorMessage:
          '当前选择了「模型构件修改」：请在上游「建筑模型」节点调整坡道/扶手/格栅/屋顶参数并重建新模型版本，再点击“批量更新过期下游视角”以同步全部角度。',
      };
      this.emitUpdate(task);
      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'stale',
        lastError: task.errorMessage,
      });
      return { task, updatedGraph: nextGraph };
    }

    // 仅图片修饰（显式标注 syncedToModel: false，保留原图可追溯）
    const srcAbs = this.store.resolveInsideProject(srcNode.outputArtifactPath);
    const editId = `edit-${crypto.randomUUID().slice(0, 8)}`;
    const outRel = path.posix.join('images', editId, 'edited.png');
    const outAbs = this.store.resolveInsideProject(outRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.copyFileSync(srcAbs, outAbs);

    const summary = {
      editId,
      scope: 'image_only',
      syncedToModel: false,
      syncNotice: '未同步模型（仅图片修饰，不影响其他相机视角）',
      parentImageRelPath: srcNode.outputArtifactPath,
      pngRelPath: outRel,
      pngSha256: computeFileSha256(outAbs),
      instruction: String(node.params.instruction ?? ''),
      annotationRegion: String(node.params.annotationRegion ?? ''),
    };
    const task: TaskRecord = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      nodeId: node.id,
      operation: 'local_edit_image_only',
      title: `局部图片修饰（未同步模型）：${node.title}`,
      status: 'succeeded',
      stage: 'done',
      createdAt: now,
      finishedAt: now,
      inputSnapshot: { scope, instruction: summary.instruction },
      outputPath: outRel,
      outputSummary: summary,
    };
    this.emitUpdate(task);
    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'succeeded',
      outputArtifactPath: outRel,
      outputSummary: summary,
      lastError: undefined,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runCameraPath(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const camEdges = graph.edges.filter(
      (e) => e.target === node.id && e.targetHandle === 'cameras'
    );
    if (camEdges.length < 2) {
      throw new Error(`相机路径节点「${node.title}」至少需要连接 2 个相机画框作为起止关键帧。`);
    }

    const keyframes: CameraSnapshot[] = [];
    for (const edge of camEdges) {
      const camNode = graph.nodes.find((n) => n.id === edge.source);
      if (!camNode?.outputArtifactPath) {
        throw new Error(`请先运行上游相机节点「${camNode?.title ?? edge.source}」保存相机快照。`);
      }
      const absCam = this.store.resolveInsideProject(camNode.outputArtifactPath);
      keyframes.push(CameraSnapshotSchema.parse(JSON.parse(fs.readFileSync(absCam, 'utf-8'))));
    }

    const modelEdge = graph.edges.find(
      (e) => e.target === node.id && (e.targetHandle === 'model' || e.targetHandle === 'scene')
    );
    let blendRelPath = path.posix.join('models', keyframes[0]!.scene.id, 'model.blend');
    let modelVersionId = keyframes[0]!.scene.id;
    if (modelEdge) {
      const mNode = graph.nodes.find((n) => n.id === modelEdge.source);
      const mSummary = mNode?.outputSummary as Record<string, unknown> | undefined;
      if (typeof mSummary?.blendRelPath === 'string') blendRelPath = mSummary.blendRelPath;
      if (typeof mSummary?.modelVersionId === 'string') modelVersionId = mSummary.modelVersionId;
    }
    const blendAbsPath = this.store.resolveInsideProject(blendRelPath);
    if (!fs.existsSync(blendAbsPath)) {
      throw new Error(`找不到冻结的模型/场景文件：${blendRelPath}`);
    }

    // 持久化帧缓存目录（按节点与冻结模型版本隔离，支持中断后复用已校验帧 D08）
    const framesCacheRel = path.posix.join('videos', `${node.id}_${modelVersionId}_frames`);
    const framesCacheDir = this.store.resolveInsideProject(framesCacheRel);
    const videoId = `vid-${crypto.randomUUID().slice(0, 8)}`;

    const { task, archivedReportRel, reportData } = await this.executeBlenderWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'render_camera_path',
      title: `模型路径视频渲染：${node.title} (${videoId})`,
      inputs: {
        blendPath: blendAbsPath,
        keyframes,
        framesCacheDir,
        modelVersionId,
      },
      parameters: node.params,
      archiveSubdir: path.posix.join('videos', videoId),
      filesToArchive: ['camera_path.mp4', 'video_report.json'],
      primaryReportName: 'video_report.json',
    });

    const videoSummary = reportData
      ? {
          videoId,
          videoSource: 'model_path_render',
          modelVersionId,
          fps: reportData.fps,
          totalFrames: reportData.totalFrames,
          durationSec: reportData.durationSec,
          actualWidthPx: reportData.actualWidthPx,
          actualHeightPx: reportData.actualHeightPx,
          renderedFrames: reportData.renderedFrames,
          reusedFrames: reportData.reusedFrames,
          maxCameraSpeedMps: reportData.maxCameraSpeedMps,
          collisionWarnings: reportData.collisionWarnings,
          encoder: reportData.encoder,
          validContainer: reportData.validContainer,
          mp4RelPath: path.posix.join('videos', videoId, 'camera_path.mp4'),
          mp4Sha256: reportData.mp4Sha256,
          framesCacheRel,
          validationStatus: 'passed',
        }
      : undefined;

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath:
        task.status === 'succeeded'
          ? path.posix.join('videos', videoId, 'camera_path.mp4')
          : archivedReportRel,
      outputSummary: videoSummary,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runVideoNode(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const mode = node.params.mode === 'generative' ? 'generative' : 'model_path';
    const now = new Date().toISOString();

    if (mode === 'model_path') {
      const incoming = graph.edges.find((e) => e.target === node.id && e.targetHandle === 'video_in');
      if (!incoming) {
        throw new Error(`视频节点「${node.title}」在模型路径模式下需要连接上游「相机路径」节点。`);
      }
      const src = graph.nodes.find((n) => n.id === incoming.source);
      if (!src?.outputArtifactPath) {
        throw new Error(`请先执行上游相机路径节点「${src?.title ?? incoming.source}」。`);
      }
      const summary = {
        ...(src.outputSummary ?? {}),
        videoSource: 'model_path_render',
        sourceLabel: '模型路径渲染（建筑结构跨帧稳定）',
      };
      const task: TaskRecord = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        projectId,
        nodeId: node.id,
        operation: 'finalize_model_path_video',
        title: `确认模型路径视频：${node.title}`,
        status: 'succeeded',
        stage: 'done',
        createdAt: now,
        finishedAt: now,
        inputSnapshot: { mode, sourceNodeId: src.id },
        outputPath: src.outputArtifactPath,
        outputSummary: summary,
      };
      this.emitUpdate(task);
      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'succeeded',
        outputArtifactPath: src.outputArtifactPath,
        outputSummary: summary,
        lastError: undefined,
      });
      return { task, updatedGraph: nextGraph };
    }

    // 生成式视频路线（独立标识来源与 review_required 状态，总规格 §9.2）
    const providerId = String(node.params.providerId ?? 'unconfigured');
    const provider = this.credentials.getProvider(providerId);
    if (!provider || providerId === 'unconfigured') {
      const task: TaskRecord = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        projectId,
        nodeId: node.id,
        operation: 'generative_video',
        title: `生成式视频：${node.title}`,
        status: 'unsupported_dependency',
        createdAt: now,
        finishedAt: now,
        inputSnapshot: { mode, providerId },
        errorCode: 'VIDEO_PROVIDER_UNCONFIGURED',
        errorMessage: '未配置生成式视频服务（请使用「模型路径渲染」或配置视频服务/测试模拟器）。',
      };
      this.emitUpdate(task);
      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'unconfigured',
        lastError: task.errorMessage,
      });
      return { task, updatedGraph: nextGraph };
    }

    const vidId = `gvid-${crypto.randomUUID().slice(0, 8)}`;
    const outDir = path.join(projectDir, 'videos', vidId);
    fs.mkdirSync(outDir, { recursive: true });
    const adapter =
      provider.kind === 'mock_simulator'
        ? new MockVideoSimulatorAdapter()
        : new OpenAiCompatVideoAdapter();
    const remote = await adapter.submitVideo(
      provider,
      {
        taskId: vidId,
        keyframeImagePath: '',
        prompt: String(node.params.prompt ?? '建筑镜头缓慢推进'),
        durationSec: Number(node.params.durationSec ?? 4),
        fps: Number(node.params.fps ?? 24),
        widthPx: Number(node.params.widthPx ?? 1280),
        heightPx: Number(node.params.heightPx ?? 720),
        outputDir: outDir,
      },
      this.credentials.getApiKey(provider.credentialId)
    );

    const relOut = remote.outputFilePath
      ? path.posix.join('videos', vidId, path.basename(remote.outputFilePath))
      : undefined;
    const summary = {
      videoId: vidId,
      remoteTaskId: remote.remoteTaskId,
      providerId: provider.id,
      videoSource: remote.videoSource,
      validationStatus: remote.validationStatus,
      warnings: remote.warnings,
    };
    const task: TaskRecord = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      nodeId: node.id,
      operation: 'generative_video',
      title: `生成式视频：${node.title}`,
      status: remote.status === 'failed' ? 'failed' : 'succeeded',
      stage: 'done',
      createdAt: now,
      finishedAt: new Date().toISOString(),
      inputSnapshot: { mode, providerId: provider.id },
      outputPath: relOut,
      outputSummary: summary,
      errorMessage: remote.errorMessage,
    };
    this.emitUpdate(task);
    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath: relOut,
      outputSummary: summary,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runMaterialNode(
    node: CanvasNode,
    graph: CanvasGraph,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find(
      (e) => e.target === node.id && (e.targetHandle === 'model' || e.targetHandle === 'scene')
    );
    if (!incoming) {
      throw new Error(`材质节点「${node.title}」缺少上游「模型版本」或「场景版本」连线。`);
    }
    const upstream = graph.nodes.find((n) => n.id === incoming.source);
    const upSummary = upstream?.outputSummary as Record<string, unknown> | undefined;
    const modelVersionId = String(upSummary?.modelVersionId ?? '');
    const blendRelPath = String(upSummary?.blendRelPath ?? '');
    const blendSha256 = String(upSummary?.blendSha256 ?? '');
    if (!modelVersionId || !blendRelPath || !blendSha256) {
      throw new Error(`请先执行上游模型节点「${upstream?.title ?? incoming.source}」。`);
    }

    const prevOverrides = Array.isArray(upSummary?.materialOverrides)
      ? (upSummary.materialOverrides as { slotName: string; baseColorHex: string; roughness?: number }[])
      : [];
    const slotName = String(node.params.slotName ?? 'exterior_wall');
    const baseColorHex = String(node.params.baseColorHex ?? '#D9DDE2');
    const roughness = Number(node.params.roughness ?? 0.65);

    const mergedOverrides = [
      ...prevOverrides.filter((o) => o.slotName !== slotName),
      { slotName, baseColorHex, roughness },
    ];

    const now = new Date().toISOString();
    const materialRevisionId = `mat-${crypto.randomUUID().slice(0, 8)}`;
    const summary = {
      materialRevisionId,
      modelVersionId,
      blendRelPath,
      glbRelPath: upSummary?.glbRelPath,
      blendSha256,
      glbSha256: upSummary?.glbSha256,
      materialOverrides: mergedOverrides,
      geometryUnchanged: true,
    };

    const task: TaskRecord = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      nodeId: node.id,
      operation: 'material_revision',
      title: `材质槽修订：${slotName} → ${baseColorHex}`,
      status: 'succeeded',
      stage: 'done',
      completed: 1,
      total: 1,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      inputSnapshot: { modelVersionId, slotName, baseColorHex, roughness },
      outputSummary: summary,
    };
    this.emitUpdate(task);

    let nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'succeeded',
      outputArtifactPath: upstream?.outputArtifactPath,
      outputSummary: summary,
      lastError: undefined,
    });
    nextGraph = this.markDownstreamOutdated(
      nextGraph,
      node.id,
      `材质修订已更新（${materialRevisionId}），几何版本保持 ${modelVersionId}`
    );
    return { task, updatedGraph: nextGraph };
  }

  private async runReferenceImageNode(
    node: CanvasNode,
    graph: CanvasGraph,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const role = (node.params.role as ReferenceRole) ?? 'lighting_style';
    const weight = Number(node.params.weight ?? 0.7);
    const enabled = node.params.enabled !== false;
    const asset = node.assetId ? this.store.getAssetById(node.assetId) : null;

    const now = new Date().toISOString();
    const summary = {
      role,
      weight,
      enabled,
      assetId: asset?.id,
      relativePath: asset?.relativePath,
      originalName: asset?.originalName ?? node.title,
    };
    const task: TaskRecord = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      nodeId: node.id,
      operation: 'bind_reference',
      title: `参考图角色绑定：${role}`,
      status: 'succeeded',
      stage: 'done',
      createdAt: now,
      finishedAt: now,
      inputSnapshot: summary,
      outputSummary: summary,
    };
    this.emitUpdate(task);

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'succeeded',
      outputArtifactPath: asset?.relativePath,
      outputSummary: summary,
      lastError: undefined,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runPromptNode(
    node: CanvasNode,
    graph: CanvasGraph,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const now = new Date().toISOString();
    const summary = {
      keep: String(node.params.keep ?? ''),
      modify: String(node.params.modify ?? ''),
      negative: String(node.params.negative ?? ''),
    };
    const task: TaskRecord = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      nodeId: node.id,
      operation: 'save_prompt_spec',
      title: `保存提示词规格：${node.title}`,
      status: 'succeeded',
      stage: 'done',
      createdAt: now,
      finishedAt: now,
      inputSnapshot: summary,
      outputSummary: summary,
    };
    this.emitUpdate(task);
    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'succeeded',
      outputSummary: summary,
      lastError: undefined,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runCameraFrame(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const incoming = graph.edges.find(
      (e) => e.target === node.id && (e.targetHandle === 'model' || e.targetHandle === 'scene')
    );
    if (!incoming) {
      throw new Error(`相机节点「${node.title}」缺少上游「模型版本」或「场景版本」连线。`);
    }
    const modelNode = graph.nodes.find((n) => n.id === incoming.source);
    const modelSummary = modelNode?.outputSummary as Record<string, unknown> | undefined;
    const modelVersionId = String(modelSummary?.modelVersionId ?? '');
    const blendSha256 = String(modelSummary?.blendSha256 ?? '');
    if (!modelVersionId || !blendSha256) {
      throw new Error(`请先执行上游模型节点「${modelNode?.title ?? incoming.source}」生成冻结的模型版本。`);
    }

    const now = new Date().toISOString();
    const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;

    let snapshot: CameraSnapshot;
    if (node.params.cameraSnapshot && typeof node.params.cameraSnapshot === 'object') {
      snapshot = CameraSnapshotSchema.parse({
        ...(node.params.cameraSnapshot as Record<string, unknown>),
        scene: { id: modelVersionId, version: modelVersionId, sha256: blendSha256 },
      });
    } else {
      const eye = (node.params.eyeArch as Vec3) ?? [14, -8, 1.6];
      const target = (node.params.targetArch as Vec3) ?? [5, 3, 2.0];
      const widthPx = Number(node.params.widthPx ?? 1280);
      const heightPx = Number(node.params.heightPx ?? 720);
      const focalLengthMm = Number(node.params.focalLengthMm ?? 35);
      snapshot = CameraSnapshotSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: `cam-${node.id}`,
        name: String(node.params.name ?? node.title),
        scene: { id: modelVersionId, version: modelVersionId, sha256: blendSha256 },
        projection: node.params.projection === 'orthographic' ? 'orthographic' : 'perspective',
        matrixWorld: buildDefaultArchLookAtMatrix(eye, target),
        coordinateConvention: 'architecture-z-up',
        projectionAdapterVersion: 'arch-zup-three-yup-v1',
        perspective: {
          focalLengthMm,
          sensorWidthMm: 36,
          sensorFit: 'horizontal',
          shiftX: 0,
          shiftY: 0,
        },
        nearM: 0.1,
        farM: 500,
        widthPx,
        heightPx,
      });
    }

    const camRelPath = path.posix.join('cameras', `${node.id}_${modelVersionId}_snapshot.json`);
    const camAbsPath = this.store.resolveInsideProject(camRelPath);
    fs.mkdirSync(path.dirname(camAbsPath), { recursive: true });
    fs.writeFileSync(camAbsPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    const task: TaskRecord = {
      id: taskId,
      projectId,
      nodeId: node.id,
      operation: 'save_camera_snapshot',
      title: `保存相机快照：${snapshot.name} (${modelVersionId})`,
      status: 'succeeded',
      stage: 'done',
      completed: 1,
      total: 1,
      createdAt: now,
      startedAt: now,
      finishedAt: new Date().toISOString(),
      inputSnapshot: { modelVersionId, cameraId: snapshot.id },
      outputPath: camRelPath,
      outputSummary: {
        cameraId: snapshot.id,
        name: snapshot.name,
        modelVersionId,
        widthPx: snapshot.widthPx,
        heightPx: snapshot.heightPx,
        outdated: false,
      },
    };
    this.emitUpdate(task);

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'succeeded',
      outputArtifactPath: camRelPath,
      outputSummary: task.outputSummary,
      lastError: undefined,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runNativeRender(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const camEdge = graph.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'camera'
    );
    if (!camEdge) {
      throw new Error(`原生渲染节点「${node.title}」缺少上游「相机快照」连线。`);
    }
    const camNode = graph.nodes.find((n) => n.id === camEdge.source);
    if (!camNode?.outputArtifactPath) {
      throw new Error(`请先执行上游相机节点「${camNode?.title ?? camEdge.source}」保存相机快照。`);
    }
    const camAbsPath = this.store.resolveInsideProject(camNode.outputArtifactPath);
    const cameraSnapshot = CameraSnapshotSchema.parse(
      JSON.parse(fs.readFileSync(camAbsPath, 'utf-8'))
    );

    const modelEdge = graph.edges.find(
      (e) => e.target === node.id && (e.targetHandle === 'model' || e.targetHandle === 'scene')
    );
    let blendRelPath = path.posix.join('models', cameraSnapshot.scene.id, 'model.blend');
    let resolvedModelVersionId = cameraSnapshot.scene.id;
    let materialOverrides: { slotName: string; baseColorHex: string; roughness?: number }[] = [];

    if (modelEdge) {
      const mNode = graph.nodes.find((n) => n.id === modelEdge.source);
      const mSummary = mNode?.outputSummary as Record<string, unknown> | undefined;
      if (typeof mSummary?.blendRelPath === 'string') {
        blendRelPath = mSummary.blendRelPath;
      }
      if (typeof mSummary?.modelVersionId === 'string') {
        resolvedModelVersionId = mSummary.modelVersionId;
      }
      if (Array.isArray(mSummary?.materialOverrides)) {
        materialOverrides = mSummary.materialOverrides as {
          slotName: string;
          baseColorHex: string;
          roughness?: number;
        }[];
      }
    }

    const blendAbsPath = this.store.resolveInsideProject(blendRelPath);
    if (!fs.existsSync(blendAbsPath)) {
      throw new Error(`找不到冻结的模型文件：${blendRelPath}`);
    }

    const renderId = `rnd-${crypto.randomUUID().slice(0, 8)}`;
    const { task, archivedReportRel, reportData } = await this.executeBlenderWorker({
      projectDir,
      projectId,
      nodeId: node.id,
      operation: 'native_render',
      title: `原生渲染：${cameraSnapshot.name} (${resolvedModelVersionId})`,
      inputs: {
        blendPath: blendAbsPath,
        cameraSnapshot,
        materialOverrides,
        renderId,
      },
      parameters: node.params,
      archiveSubdir: path.posix.join('renders', renderId),
      filesToArchive: ['beauty.png', 'render_report.json'],
      primaryReportName: 'render_report.json',
    });

    const renderSummary = reportData
      ? {
          renderId,
          modelVersionId: resolvedModelVersionId,
          origin: 'native_render',
          renderEngine: reportData.renderEngine,
          actualFormat: reportData.actualFormat,
          actualWidthPx: reportData.actualWidthPx,
          actualHeightPx: reportData.actualHeightPx,
          cameraName: reportData.cameraName,
          appliedMaterialOverrides: reportData.appliedMaterialOverrides,
          materialOverrides,
          pngRelPath: path.posix.join('renders', renderId, 'beauty.png'),
          pngSha256: reportData.pngSha256,
          outdated: false,
        }
      : undefined;

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      outputArtifactPath:
        task.status === 'succeeded'
          ? path.posix.join('renders', renderId, 'beauty.png')
          : archivedReportRel,
      outputSummary: renderSummary,
      lastError: task.errorMessage,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runAiRenderImage(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const providerId = String(node.params.providerId ?? 'unconfigured');
    const provider = this.credentials.getProvider(providerId);
    const now = new Date().toISOString();

    if (!provider || providerId === 'unconfigured') {
      const unconfiguredTask: TaskRecord = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        projectId,
        nodeId: node.id,
        operation: 'ai_render',
        title: `执行「${node.title}」`,
        status: 'unsupported_dependency',
        createdAt: now,
        finishedAt: now,
        inputSnapshot: { nodeId: node.id, providerId },
        errorCode: 'AI_PROVIDER_UNCONFIGURED',
        errorMessage: '未配置 AI 图像服务（可在「环境与设置」配置 OpenAI 兼容服务或显式选择测试模拟器）。',
      };
      this.emitUpdate(unconfiguredTask);
      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'unconfigured',
        lastError: unconfiguredTask.errorMessage,
      });
      return { task: unconfiguredTask, updatedGraph: nextGraph };
    }

    const bundleEdge = graph.edges.find((e) => e.target === node.id && e.targetHandle === 'bundle');
    if (!bundleEdge) {
      throw new Error(`效果图节点「${node.title}」缺少上游「原生渲染包」底图连线。`);
    }
    const bundleNode = graph.nodes.find((n) => n.id === bundleEdge.source);
    const bundleSummary = bundleNode?.outputSummary as Record<string, unknown> | undefined;
    const basePngRel =
      typeof bundleSummary?.pngRelPath === 'string'
        ? bundleSummary.pngRelPath
        : bundleNode?.outputArtifactPath;
    if (!basePngRel) {
      throw new Error(`请先执行上游原生渲染节点「${bundleNode?.title ?? bundleEdge.source}」生成底图。`);
    }
    const baseImagePath = this.store.resolveInsideProject(basePngRel);

    // 收集已连接的参考图节点（严格遵守显式角色）
    const refEdges = graph.edges.filter((e) => e.target === node.id && e.targetHandle === 'reference');
    const references: ReferenceInputItem[] = [];
    for (const re of refEdges) {
      const rn = graph.nodes.find((n) => n.id === re.source);
      if (!rn) continue;
      const asset = rn.assetId ? this.store.getAssetById(rn.assetId) : null;
      references.push({
        id: rn.id,
        role: (rn.params.role as ReferenceRole) ?? 'lighting_style',
        filePath: asset ? this.store.resolveInsideProject(asset.relativePath) : '',
        label: rn.title,
        weight: Number(rn.params.weight ?? 0.7),
        enabled: rn.params.enabled !== false,
      });
    }

    // 收集提示词节点
    const promptEdge = graph.edges.find((e) => e.target === node.id && e.targetHandle === 'prompt');
    const promptNode = promptEdge ? graph.nodes.find((n) => n.id === promptEdge.source) : null;

    const adapter = this.getAdapter(provider.kind);
    const caps = adapter.getCapabilities(provider.modelId);
    const requestedW = Number(node.params.widthPx ?? bundleSummary?.actualWidthPx ?? 1024);
    const requestedH = Number(node.params.heightPx ?? bundleSummary?.actualHeightPx ?? 1024);
    const mode =
      node.params.mode === 'concept_exploration' ? 'concept_exploration' : 'model_constrained';

    const compiled = compileArchitecturalPrompt({
      mode,
      modelVersionId: String(bundleSummary?.modelVersionId ?? 'unknown'),
      cameraName: String(bundleSummary?.cameraName ?? '未命名视角'),
      keepText: String(promptNode?.params.keep ?? ''),
      modifyText: String(promptNode?.params.modify ?? ''),
      negativeText: String(promptNode?.params.negative ?? ''),
      materialOverrides: Array.isArray(bundleSummary?.materialOverrides)
        ? (bundleSummary.materialOverrides as { slotName: string; baseColorHex: string }[])
        : undefined,
      references,
      requestedWidthPx: requestedW,
      requestedHeightPx: requestedH,
      capabilities: caps,
    });

    const artifactId = `img-${crypto.randomUUID().slice(0, 8)}`;
    const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
    const workOutDir = path.join(projectDir, 'work', taskId, 'output');
    fs.mkdirSync(workOutDir, { recursive: true });

    const task: TaskRecord = {
      id: taskId,
      projectId,
      nodeId: node.id,
      operation: 'ai_render',
      title: `生成效果图：${node.title} (${provider.label})`,
      status: 'running',
      stage: 'submitting',
      createdAt: now,
      startedAt: now,
      // 注意：绝不把 API Key 写入 inputSnapshot（D03）
      inputSnapshot: {
        providerId: provider.id,
        modelId: provider.modelId,
        mode,
        requestedWidthPx: requestedW,
        requestedHeightPx: requestedH,
        modelVersionId: bundleSummary?.modelVersionId,
      },
    };
    this.emitUpdate(task);

    const apiKey = this.credentials.getApiKey(provider.credentialId);
    const remote = await adapter.submit(
      provider,
      {
        taskId,
        mode,
        baseImagePath,
        compiledPrompt: compiled.compiledPrompt,
        negativePrompt: compiled.negativePrompt,
        references: compiled.activeReferences,
        requestedWidthPx: requestedW,
        requestedHeightPx: requestedH,
        outputDir: workOutDir,
      },
      apiKey
    );

    if (remote.status !== 'succeeded' || !remote.outputFilePath || !fs.existsSync(remote.outputFilePath)) {
      task.status = 'failed';
      task.finishedAt = new Date().toISOString();
      task.errorCode = 'PROVIDER_REJECTED';
      task.errorMessage = remote.errorMessage ?? '图像生成任务失败。';
      this.emitUpdate({ ...task });
      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'failed',
        lastError: task.errorMessage,
      });
      return { task, updatedGraph: nextGraph };
    }

    const archiveRel = path.posix.join('images', artifactId, 'result.png');
    const archiveAbs = this.store.resolveInsideProject(archiveRel);
    fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
    fs.copyFileSync(remote.outputFilePath, archiveAbs);

    const summary = {
      artifactId,
      providerId: provider.id,
      modelId: provider.modelId,
      origin: remote.origin,
      mode,
      modelVersionId: bundleSummary?.modelVersionId,
      actualFormat: 'PNG',
      actualWidthPx: remote.actualWidthPx,
      actualHeightPx: remote.actualHeightPx,
      pngRelPath: archiveRel,
      pngSha256: computeFileSha256(archiveAbs),
      compiledPrompt: compiled.compiledPrompt,
      warnings: [...compiled.capabilityWarnings, ...remote.warnings],
      validationStatus: 'review_required',
      outdated: false,
    };

    task.status = 'succeeded';
    task.stage = 'done';
    task.finishedAt = new Date().toISOString();
    task.outputPath = archiveRel;
    task.outputSummary = summary;
    this.emitUpdate({ ...task });

    const nextGraph = this.updateNodeInGraph(graph, node.id, {
      status: 'succeeded',
      outputArtifactPath: archiveRel,
      outputSummary: summary,
      lastError: undefined,
    });
    return { task, updatedGraph: nextGraph };
  }

  private async runExportNode(
    node: CanvasNode,
    graph: CanvasGraph,
    projectDir: string,
    projectId: string,
    exportDirectory?: string
  ): Promise<{ task: TaskRecord; updatedGraph: CanvasGraph }> {
    const targetDir = exportDirectory?.trim() || path.join(projectDir, 'exports');
    const incomingEdges = graph.edges.filter((e) => e.target === node.id);
    if (incomingEdges.length === 0) {
      throw new Error(`导出节点「${node.title}」尚未连接任何上游成果节点。`);
    }

    const now = new Date().toISOString();
    const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
    const task: TaskRecord = {
      id: taskId,
      projectId,
      nodeId: node.id,
      operation: 'export_deliverables',
      title: `导出交付至 ${path.basename(targetDir)}`,
      status: 'running',
      stage: 'collecting',
      completed: 0,
      total: incomingEdges.length,
      createdAt: now,
      startedAt: now,
      inputSnapshot: { targetDir, upstreamCount: incomingEdges.length, params: node.params },
    };
    this.emitUpdate(task);

    const imageFormat = String(node.params.imageFormat ?? 'PNG').toUpperCase();
    const longEdgePx = node.params.longEdgePx ? Number(node.params.longEdgePx) : undefined;
    const widthPx = node.params.widthPx ? Number(node.params.widthPx) : undefined;
    const heightPx = node.params.heightPx ? Number(node.params.heightPx) : undefined;
    const resizeMode = String(node.params.resizeMode ?? 'preserve');
    const backgroundHex = String(node.params.backgroundHex ?? '#FFFFFF');
    const modelFormats = Array.isArray(node.params.modelFormats)
      ? (node.params.modelFormats as string[])
      : ['blend', 'glb'];

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const exportedItems: Record<string, unknown>[] = [];
      const skippedItems: Record<string, unknown>[] = [];

      for (let i = 0; i < incomingEdges.length; i++) {
        const edge = incomingEdges[i]!;
        const src = graph.nodes.find((n) => n.id === edge.source);
        if (!src?.outputArtifactPath) {
          throw new Error(`上游节点「${src?.title ?? edge.source}」尚未生成可导出的真实文件。`);
        }
        const summary = src.outputSummary as Record<string, unknown> | undefined;

        if (edge.dataType === 'image_artifact') {
          const absImg = this.store.resolveInsideProject(src.outputArtifactPath);
          const ext = imageFormat === 'JPEG' ? 'jpg' : imageFormat.toLowerCase();
          const outFileName = `${taskId}_${src.id}.${ext}`;
          const destImg = path.join(targetDir, outFileName);
          const report = await this.runImageExporter({
            projectDir,
            taskId,
            sourcePath: absImg,
            outputPath: destImg,
            format: imageFormat,
            sourceOrigin: String(summary?.origin ?? 'native_render'),
            longEdgePx,
            widthPx,
            heightPx,
            resizeMode,
            backgroundHex,
          });
          exportedItems.push({
            ...report,
            fileName: outFileName,
            sourceNodeId: src.id,
            sourceNodeTitle: src.title,
            modelVersionId: summary?.modelVersionId,
          });
        } else if (edge.dataType === 'model_version') {
          // 导出 BLEND / GLB 及可选 FBX / OBJ+MTL（不伪造 SKP/MAX）
          const blendRel = typeof summary?.blendRelPath === 'string' ? summary.blendRelPath : null;
          if (blendRel && modelFormats.includes('blend')) {
            const absBlend = this.store.resolveInsideProject(blendRel);
            const outName = `${taskId}_${src.id}.blend`;
            const dest = path.join(targetDir, outName);
            fs.copyFileSync(absBlend, dest);
            exportedItems.push({
              fileName: outName,
              destinationPath: dest,
              actualFormat: 'BLEND',
              modelVersionId: summary?.modelVersionId,
              byteSize: fs.statSync(dest).size,
              sha256: computeFileSha256(dest),
              validationStatus: 'passed',
            });
          }

          const exchangeFormats = modelFormats.filter((f) =>
            ['fbx', 'glb', 'obj', 'dae', 'skp', 'max'].includes(f.toLowerCase())
          );
          if (blendRel && exchangeFormats.length > 0) {
            const absBlend = this.store.resolveInsideProject(blendRel);
            const subRes = await this.executeBlenderWorker({
              projectDir,
              projectId,
              nodeId: node.id,
              operation: 'export_model',
              title: `模型格式导出（${exchangeFormats.join('/').toUpperCase()}）`,
              inputs: { blendPath: absBlend },
              parameters: { formats: exchangeFormats },
              archiveSubdir: path.posix.join('work', taskId, 'model_export'),
              filesToArchive: ['model_export_report.json'],
              primaryReportName: 'model_export_report.json',
            });
            const rep = subRes.reportData as
              | {
                  exported?: { format: string; path: string; byteSize: number; sha256: string; compatibilityNote: string }[];
                  skipped?: { format: string; reason: string }[];
                }
              | undefined;
            for (const item of rep?.exported ?? []) {
              const outName = `${taskId}_${src.id}_${path.basename(item.path)}`;
              const dest = path.join(targetDir, outName);
              fs.copyFileSync(item.path, dest);
              exportedItems.push({
                fileName: outName,
                destinationPath: dest,
                actualFormat: item.format,
                compatibilityNote: item.compatibilityNote,
                modelVersionId: summary?.modelVersionId,
                byteSize: item.byteSize,
                sha256: item.sha256,
                validationStatus: 'passed',
              });
            }
            for (const sk of rep?.skipped ?? []) {
              skippedItems.push(sk);
            }
          }
        } else {
          const absSrc = this.store.resolveInsideProject(src.outputArtifactPath);
          const outName = `${taskId}_${path.basename(absSrc)}`;
          const destFile = path.join(targetDir, outName);
          fs.copyFileSync(absSrc, destFile);
          exportedItems.push({
            fileName: outName,
            destinationPath: destFile,
            sourceNodeId: src.id,
            sourceNodeTitle: src.title,
            actualFormat: path.extname(destFile).replace('.', '').toUpperCase() || 'UNKNOWN',
            byteSize: fs.statSync(destFile).size,
            sha256: computeFileSha256(destFile),
            validationStatus: 'passed',
          });
        }

        task.completed = i + 1;
        this.emitUpdate({ ...task });
      }

      const manifestName = `${taskId}_export-manifest.json`;
      const manifestPath = path.join(targetDir, manifestName);
      const manifestPayload = {
        schemaVersion: SCHEMA_VERSION,
        taskId,
        projectId,
        exportedAt: new Date().toISOString(),
        exportDirectory: targetDir,
        items: exportedItems,
        skipped: skippedItems,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifestPayload, null, 2), 'utf-8');

      task.status = 'succeeded';
      task.stage = 'done';
      task.finishedAt = new Date().toISOString();
      task.outputPath = manifestPath;
      task.outputSummary = {
        exportedCount: exportedItems.length,
        skippedCount: skippedItems.length,
        manifestPath,
        items: exportedItems,
        skipped: skippedItems,
      };
      this.emitUpdate({ ...task });

      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'succeeded',
        outputArtifactPath: undefined,
        outputSummary: task.outputSummary,
        lastError: undefined,
      });
      return { task, updatedGraph: nextGraph };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.finishedAt = new Date().toISOString();
      task.errorCode = 'EXPORT_FAILED';
      task.errorMessage = msg;
      this.emitUpdate({ ...task });
      const nextGraph = this.updateNodeInGraph(graph, node.id, {
        status: 'failed',
        lastError: msg,
      });
      return { task, updatedGraph: nextGraph };
    }
  }

  private async runImageExporter(opts: {
    projectDir: string;
    taskId: string;
    sourcePath: string;
    outputPath: string;
    format: string;
    sourceOrigin: string;
    longEdgePx?: number;
    widthPx?: number;
    heightPx?: number;
    resizeMode: string;
    backgroundHex: string;
  }): Promise<Record<string, unknown>> {
    const manifest = this.store.getManifest();
    const pythonExe =
      resolveDefaultPythonExecutable(this.appRootDir, manifest?.toolOverrides?.pythonPath) ??
      'python';
    const script = resolveImageExporterScript(this.appRootDir);
    if (!fs.existsSync(script)) {
      throw new Error(`找不到图片导出脚本：${script}`);
    }

    const workDir = path.join(opts.projectDir, 'work', opts.taskId);
    fs.mkdirSync(workDir, { recursive: true });
    const reportPath = path.join(workDir, `img_export_${Date.now()}.json`);
    const reqPath = path.join(workDir, `img_export_req_${Date.now()}.json`);
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ ...opts, reportPath }, null, 2),
      'utf-8'
    );

    const { stdout } = await execFileAsync(pythonExe, [script, '--request', reqPath], {
      windowsHide: true,
      timeout: 60000,
    });
    const res = JSON.parse(stdout.trim()) as { ok: boolean; error?: string };
    if (!res.ok) {
      throw new Error(res.error || '图片确定性导出失败');
    }
    return JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as Record<string, unknown>;
  }

  private async executePythonWorker(opts: {
    projectDir: string;
    projectId: string;
    nodeId: string;
    operation: string;
    title: string;
    inputs: Record<string, unknown>;
    parameters: Record<string, unknown>;
    archiveSubdir: string;
    archiveFileName: string;
  }): Promise<{
    task: TaskRecord;
    reportPath?: string;
    reportData?: Record<string, unknown>;
  }> {
    const manifest = this.store.getManifest();
    const pythonExe =
      resolveDefaultPythonExecutable(this.appRootDir, manifest?.toolOverrides?.pythonPath) ??
      'python';
    const workerScript = resolveGeometryWorkerScript(this.appRootDir);
    if (!fs.existsSync(workerScript)) {
      throw new Error(`找不到几何工作进程脚本：${workerScript}`);
    }

    const { task, completedReportPath } = await this.spawnJsonlWorker({
      executable: pythonExe,
      argsBuilder: (reqPath) => [workerScript, '--request', reqPath],
      projectDir: opts.projectDir,
      projectId: opts.projectId,
      nodeId: opts.nodeId,
      operation: opts.operation,
      title: opts.title,
      inputs: opts.inputs,
      parameters: opts.parameters,
    });

    if (task.status !== 'running' || !completedReportPath || !fs.existsSync(completedReportPath)) {
      return { task };
    }

    try {
      const reportData = JSON.parse(fs.readFileSync(completedReportPath, 'utf-8')) as Record<string, unknown>;
      const archiveRel = path.posix.join(opts.archiveSubdir, opts.archiveFileName);
      const archiveAbs = this.store.resolveInsideProject(archiveRel);
      fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
      fs.copyFileSync(completedReportPath, archiveAbs);

      task.status = 'succeeded';
      task.stage = 'done';
      task.finishedAt = new Date().toISOString();
      task.outputPath = archiveRel;
      task.outputSummary = reportData;
      this.emitUpdate({ ...task });
      return { task, reportPath: archiveRel, reportData };
    } catch (err) {
      task.status = 'failed';
      task.finishedAt = new Date().toISOString();
      task.errorCode = 'ARCHIVE_VALIDATION_FAILED';
      task.errorMessage = err instanceof Error ? err.message : String(err);
      this.emitUpdate({ ...task });
      return { task };
    }
  }

  private async executeBlenderWorker(opts: {
    projectDir: string;
    projectId: string;
    nodeId: string;
    operation: string;
    title: string;
    inputs: Record<string, unknown>;
    parameters: Record<string, unknown>;
    archiveSubdir: string;
    filesToArchive: string[];
    primaryReportName: string;
  }): Promise<{
    task: TaskRecord;
    archivedReportRel?: string;
    reportData?: Record<string, unknown>;
  }> {
    const manifest = this.store.getManifest();
    const blenderExe = resolveBlenderExecutable(manifest?.toolOverrides?.blenderPath);
    if (!blenderExe) {
      const now = new Date().toISOString();
      const missingTask: TaskRecord = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        projectId: opts.projectId,
        nodeId: opts.nodeId,
        operation: opts.operation,
        title: opts.title,
        status: 'unsupported_dependency',
        createdAt: now,
        finishedAt: now,
        inputSnapshot: opts.inputs,
        errorCode: 'BLENDER_NOT_FOUND',
        errorMessage: '未检测到 Blender，请在「环境与设置」中指定 blender.exe 路径。',
      };
      this.emitUpdate(missingTask);
      return { task: missingTask };
    }

    const workerScript = resolveBlenderWorkerScript(this.appRootDir);
    if (!fs.existsSync(workerScript)) {
      throw new Error(`找不到 Blender 工作脚本：${workerScript}`);
    }

    const { task, completedReportPath, outputDir } = await this.spawnJsonlWorker({
      executable: blenderExe,
      argsBuilder: (reqPath) => [
        '--background',
        '--factory-startup',
        '--disable-autoexec',
        '--python',
        workerScript,
        '--',
        '--request',
        reqPath,
      ],
      projectDir: opts.projectDir,
      projectId: opts.projectId,
      nodeId: opts.nodeId,
      operation: opts.operation,
      title: opts.title,
      inputs: opts.inputs,
      parameters: opts.parameters,
    });

    if (task.status !== 'running' || !completedReportPath || !fs.existsSync(completedReportPath)) {
      return { task };
    }

    try {
      const archiveDirAbs = this.store.resolveInsideProject(opts.archiveSubdir);
      fs.mkdirSync(archiveDirAbs, { recursive: true });

      for (const fileName of opts.filesToArchive) {
        const src = path.join(outputDir, fileName);
        if (!fs.existsSync(src)) {
          throw new Error(`Blender 任务缺少预期产物文件：${fileName}`);
        }
        fs.copyFileSync(src, path.join(archiveDirAbs, fileName));
      }

      const archivedReportRel = path.posix.join(opts.archiveSubdir, opts.primaryReportName);
      const reportData = JSON.parse(
        fs.readFileSync(this.store.resolveInsideProject(archivedReportRel), 'utf-8')
      ) as Record<string, unknown>;

      task.status = 'succeeded';
      task.stage = 'done';
      task.finishedAt = new Date().toISOString();
      task.outputPath = archivedReportRel;
      task.outputSummary = reportData;
      this.emitUpdate({ ...task });
      return { task, archivedReportRel, reportData };
    } catch (err) {
      task.status = 'failed';
      task.finishedAt = new Date().toISOString();
      task.errorCode = 'BLENDER_ARCHIVE_FAILED';
      task.errorMessage = err instanceof Error ? err.message : String(err);
      this.emitUpdate({ ...task });
      return { task };
    }
  }

  private async spawnJsonlWorker(opts: {
    executable: string;
    argsBuilder: (requestPath: string) => string[];
    projectDir: string;
    projectId: string;
    nodeId: string;
    operation: string;
    title: string;
    inputs: Record<string, unknown>;
    parameters: Record<string, unknown>;
  }): Promise<{
    task: TaskRecord;
    completedReportPath?: string;
    outputDir: string;
  }> {
    const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
    const workDir = path.join(opts.projectDir, 'work', taskId);
    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const inputManifestPath = path.join(workDir, 'inputs.json');
    fs.writeFileSync(inputManifestPath, JSON.stringify(opts.inputs, null, 2), 'utf-8');

    const reqPayload: WorkerRequest = {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      operation: opts.operation,
      inputManifestPath,
      outputDirectory: outputDir,
      parameters: opts.parameters,
    };
    const requestPath = path.join(workDir, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify(reqPayload, null, 2), 'utf-8');

    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      projectId: opts.projectId,
      nodeId: opts.nodeId,
      operation: opts.operation,
      title: opts.title,
      status: 'running',
      stage: 'starting',
      createdAt: now,
      startedAt: now,
      inputSnapshot: { ...opts.inputs, parameters: opts.parameters },
    };
    this.emitUpdate(task);

    return new Promise((resolve) => {
      const child = spawn(opts.executable, opts.argsBuilder(requestPath), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeProcesses.set(taskId, child);

      let completedReportPath: string | undefined;
      let workerErrorMessage: string | undefined;
      let stderrText = '';

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) return;
        try {
          const parsed = WorkerEventSchema.parse(JSON.parse(trimmed));
          if (parsed.type === 'progress') {
            task.stage = parsed.stage;
            task.completed = parsed.completed;
            task.total = parsed.total;
            this.emitUpdate({ ...task });
          } else if (parsed.type === 'completed') {
            completedReportPath = parsed.reportPath;
          } else if (parsed.type === 'error') {
            workerErrorMessage = parsed.message;
          }
        } catch {
          // ignore non-event lines
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString('utf-8');
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(taskId);
        task.status = 'failed';
        task.finishedAt = new Date().toISOString();
        task.errorCode = 'SPAWN_FAILED';
        task.errorMessage = `无法启动工作进程（${path.basename(opts.executable)}）：${err.message}`;
        this.emitUpdate({ ...task });
        resolve({ task, outputDir });
      });

      child.on('close', (code, signal) => {
        this.activeProcesses.delete(taskId);
        rl.close();

        if (signal) {
          task.status = 'cancelled';
          task.finishedAt = new Date().toISOString();
          task.errorMessage = '任务已被用户取消。';
          this.emitUpdate({ ...task });
          resolve({ task, outputDir });
          return;
        }

        if (code !== 0 || !completedReportPath || !fs.existsSync(completedReportPath)) {
          task.status = 'failed';
          task.finishedAt = new Date().toISOString();
          task.errorCode = 'WORKER_FAILED';
          task.errorMessage =
            workerErrorMessage ||
            stderrText.trim().slice(0, 400) ||
            `工作进程异常退出（退出码 ${code}），未产出有效报告文件。`;
          this.emitUpdate({ ...task });
          resolve({ task, outputDir });
          return;
        }

        resolve({ task, completedReportPath, outputDir });
      });
    });
  }
}
