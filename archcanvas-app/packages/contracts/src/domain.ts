import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const Mat4Schema = z.array(z.number()).length(16);
export type Mat4 = z.infer<typeof Mat4Schema>;

export const RefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, '必须是有效的 SHA-256 哈希'),
});
export type Ref = z.infer<typeof RefSchema>;

export const SourceAssetKindSchema = z.enum(['pdf', 'dwg', 'dxf', 'image', 'model']);
export type SourceAssetKind = z.infer<typeof SourceAssetKindSchema>;

export const SourceAssetSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  kind: SourceAssetKindSchema,
  originalName: z.string().min(1),
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  byteSize: z.number().int().nonnegative(),
  importedAt: z.string().datetime(),
  importSettings: z.record(z.unknown()).default({}),
});
export type SourceAsset = z.infer<typeof SourceAssetSchema>;

export const EvidenceSchema = z.object({
  sourceAssetId: z.string().min(1),
  sheetId: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  source: z.enum(['drawing', 'user', 'derived', 'assumed']),
  confidence: z.number().min(0).max(1).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ArchitecturalElementKindSchema = z.enum([
  'wall',
  'column',
  'opening',
  'slab',
  'roof',
  'stair',
  'step',
  'ramp',
  'rail',
  'canopy',
  'grille',
  'drainage_apron',
  'terrain',
]);
export type ArchitecturalElementKind = z.infer<typeof ArchitecturalElementKindSchema>;

export const ArchitecturalElementSchema = z.object({
  id: z.string().min(1),
  buildingId: z.string().min(1),
  floorId: z.string().min(1),
  kind: ArchitecturalElementKindSchema,
  geometry: z.record(z.unknown()),
  materialSlotIds: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  assumptions: z.array(z.string()),
});
export type ArchitecturalElement = z.infer<typeof ArchitecturalElementSchema>;

export const ModelVersionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  parentId: z.string().optional(),
  sourceRevisions: z.array(RefSchema),
  elementsAsset: RefSchema,
  unit: z.literal('m'),
  upAxis: z.literal('Z'),
  worldOriginOffset: Vec3Schema,
  blendAsset: RefSchema,
  previewGlbAsset: RefSchema,
  geometryDigest: z.string().min(1),
  validationReport: RefSchema,
  appliedOperations: z.array(RefSchema),
});
export type ModelVersion = z.infer<typeof ModelVersionSchema>;

export const SceneVersionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  instances: z.array(
    z.object({
      instanceId: z.string().min(1),
      model: RefSchema,
      matrixWorld: Mat4Schema,
    })
  ),
  materialRevision: RefSchema,
  environmentRevision: RefSchema,
  spatialConstraints: z.array(z.record(z.unknown())),
});
export type SceneVersion = z.infer<typeof SceneVersionSchema>;

export const CameraSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1).default('未命名相机'),
  scene: RefSchema,
  projection: z.enum(['perspective', 'orthographic']),
  matrixWorld: Mat4Schema,
  coordinateConvention: z.literal('architecture-z-up'),
  projectionAdapterVersion: z.string().min(1),
  perspective: z
    .object({
      focalLengthMm: z.number().positive(),
      sensorWidthMm: z.number().positive(),
      sensorFit: z.enum(['horizontal', 'vertical']),
      shiftX: z.number(),
      shiftY: z.number(),
    })
    .optional(),
  orthographic: z
    .object({
      widthM: z.number().positive(),
      heightM: z.number().positive(),
    })
    .optional(),
  nearM: z.number().positive(),
  farM: z.number().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  crop: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
});
export type CameraSnapshot = z.infer<typeof CameraSnapshotSchema>;

export const ReferenceRoleSchema = z.enum([
  'camera',
  'material',
  'lighting_style',
  'landscape_layout',
  'edit_target',
  'geometry_evidence',
]);
export type ReferenceRole = z.infer<typeof ReferenceRoleSchema>;

export const ReferenceBindingSchema = z.object({
  asset: RefSchema,
  role: ReferenceRoleSchema,
  targetElementIds: z.array(z.string()),
  enabled: z.boolean(),
  weight: z.number().min(0).max(1),
  allowedChanges: z.array(z.string()),
});
export type ReferenceBinding = z.infer<typeof ReferenceBindingSchema>;

export const ImageArtifactOriginSchema = z.enum([
  'native_render',
  'provider_native',
  'ai_enhanced',
  'ai_upscaled',
  'resampled',
  'format_converted',
]);

export const ImageArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  parents: z.array(RefSchema),
  scene: RefSchema.optional(),
  camera: RefSchema.optional(),
  renderBundle: RefSchema.optional(),
  promptSpec: RefSchema.optional(),
  providerRequestRecord: RefSchema.optional(),
  file: RefSchema,
  actualFormat: z.string().min(1),
  actualWidthPx: z.number().int().positive(),
  actualHeightPx: z.number().int().positive(),
  origin: ImageArtifactOriginSchema,
  sourceWidthPx: z.number().int().positive().optional(),
  sourceHeightPx: z.number().int().positive().optional(),
  validationStatus: z.enum(['pending', 'passed', 'review_required']),
});
export type ImageArtifact = z.infer<typeof ImageArtifactSchema>;

export const RevisionOperationSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  baseModel: RefSchema,
  scope: z.enum(['geometry', 'material', 'scene', 'image_only']),
  targetIds: z.array(z.string()),
  sourceAnnotation: RefSchema.optional(),
  operation: z.string().min(1),
  parameters: z.record(z.unknown()),
  expectedLocks: z.array(z.string()),
  rationale: z.string(),
});
export type RevisionOperation = z.infer<typeof RevisionOperationSchema>;
