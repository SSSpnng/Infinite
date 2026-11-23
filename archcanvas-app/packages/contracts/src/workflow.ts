import { z } from 'zod';
import { SCHEMA_VERSION } from './domain.js';

export const PortDataTypeSchema = z.enum([
  'drawing_asset',
  'calibrated_drawing',
  'building_semantics',
  'model_version',
  'scene_version',
  'camera_snapshot',
  'render_bundle',
  'reference_binding',
  'prompt_spec',
  'image_artifact',
  'video_artifact',
  'export_manifest',
]);
export type PortDataType = z.infer<typeof PortDataTypeSchema>;

export const NodeKindSchema = z.enum([
  'drawing_file',
  'drawing_calibrate',
  'drawing_recognize',
  'building_model',
  'existing_model',
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
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const NodeStatusSchema = z.enum([
  'idle',
  'ready',
  'stale',
  'running',
  'succeeded',
  'failed',
  'unconfigured',
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const CanvasNodeSchema = z.object({
  id: z.string().min(1),
  kind: NodeKindSchema,
  title: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  status: NodeStatusSchema.default('idle'),
  params: z.record(z.unknown()).default({}),
  assetId: z.string().optional(),
  outputArtifactPath: z.string().optional(),
  outputSummary: z.record(z.unknown()).optional(),
  lastError: z.string().optional(),
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

export const CanvasEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
  targetHandle: z.string().min(1),
  dataType: PortDataTypeSchema,
});
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;

export const CanvasViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});
export type CanvasViewport = z.infer<typeof CanvasViewportSchema>;

export const CanvasGraphSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
  viewport: CanvasViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});
export type CanvasGraph = z.infer<typeof CanvasGraphSchema>;

export const ProjectManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  projectId: z.string().min(1),
  name: z.string().min(1),
  projectType: z.enum(['building', 'interior', 'campus']).default('building'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  exportDirectory: z.string().optional(),
  toolOverrides: z
    .object({
      blenderPath: z.string().optional(),
      pythonPath: z.string().optional(),
      dwgConverterPath: z.string().optional(),
      ffmpegPath: z.string().optional(),
    })
    .default({}),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const TaskStatusSchema = z.enum([
  'draft',
  'queued',
  'validating',
  'running',
  'collecting',
  'checking',
  'succeeded',
  'needs_input',
  'unsupported_dependency',
  'cancel_requested',
  'cancelled',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  nodeId: z.string().optional(),
  operation: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  stage: z.string().optional(),
  completed: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  inputSnapshot: z.record(z.unknown()).default({}),
  outputPath: z.string().optional(),
  outputSummary: z.record(z.unknown()).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const WorkerRequestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  taskId: z.string().min(1),
  operation: z.string().min(1),
  inputManifestPath: z.string().min(1),
  outputDirectory: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

export const WorkerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    taskId: z.string().min(1),
    stage: z.string().min(1),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().positive().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('artifact'),
    taskId: z.string().min(1),
    kind: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().optional(),
  }),
  z.object({
    type: z.literal('completed'),
    taskId: z.string().min(1),
    reportPath: z.string().min(1),
  }),
  z.object({
    type: z.literal('error'),
    taskId: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
]);
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;

export const ToolProbeItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  available: z.boolean(),
  required: z.boolean(),
  path: z.string().optional(),
  version: z.string().optional(),
  details: z.string().optional(),
  error: z.string().optional(),
});
export type ToolProbeItem = z.infer<typeof ToolProbeItemSchema>;

export const EnvironmentProbeReportSchema = z.object({
  probedAt: z.string().datetime(),
  platform: z.string().min(1),
  gpu: z.object({
    available: z.boolean(),
    name: z.string().optional(),
    vramMb: z.number().optional(),
    driverVersion: z.string().optional(),
  }),
  tools: z.array(ToolProbeItemSchema),
  aiProvidersConfigured: z.boolean(),
});
export type EnvironmentProbeReport = z.infer<typeof EnvironmentProbeReportSchema>;

export const IpcErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcError };
