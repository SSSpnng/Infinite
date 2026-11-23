import type { NodeKind, PortDataType } from '@archcanvas/contracts';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required?: boolean;
  multiple?: boolean;
}

export interface NodeTypeDefinition {
  kind: NodeKind;
  label: string;
  category: '图纸与建模' | '场地与材质' | '相机与渲染' | 'AI与参考' | '交付';
  description: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  defaultParams: Record<string, unknown>;
  /** G0/G1 是否可执行本地任务 */
  executableInG0?: boolean;
}

export const PORT_TYPE_LABELS: Record<PortDataType, string> = {
  drawing_asset: '图纸资源',
  calibrated_drawing: '校准图纸',
  building_semantics: '建筑语义数据',
  model_version: '模型版本',
  scene_version: '场景版本',
  camera_snapshot: '相机快照',
  render_bundle: '原生渲染包',
  reference_binding: '参考图绑定',
  prompt_spec: '提示词规格',
  image_artifact: '图像成果',
  video_artifact: '视频成果',
  export_manifest: '导出清单',
};

export const NODE_REGISTRY: Record<NodeKind, NodeTypeDefinition> = {
  drawing_file: {
    kind: 'drawing_file',
    label: '图纸文件',
    category: '图纸与建模',
    description: '导入 PDF / DWG / DXF 只读项目副本，检测单位与实体摘要',
    inputs: [],
    outputs: [{ id: 'drawing', label: '图纸资源', dataType: 'drawing_asset' }],
    defaultParams: { drawingRole: 'plan', unitOverride: 'auto' },
    executableInG0: true,
  },
  drawing_calibrate: {
    kind: 'drawing_calibrate',
    label: '图纸校准',
    category: '图纸与建模',
    description: '设置比例复核、两点尺寸、北向与楼层标高',
    inputs: [{ id: 'drawing', label: '图纸资源', dataType: 'drawing_asset', required: true }],
    outputs: [{ id: 'calibrated', label: '校准图纸', dataType: 'calibrated_drawing' }],
    defaultParams: { scaleFactor: 1.0, northAngleDeg: 0, floorName: '1F', floorElevationM: 0 },
    executableInG0: true,
  },
  drawing_recognize: {
    kind: 'drawing_recognize',
    label: '图纸识别',
    category: '图纸与建模',
    description: '提取墙柱门洞、图层语义与待处理线段草稿',
    inputs: [{ id: 'calibrated', label: '校准图纸', dataType: 'calibrated_drawing', required: true }],
    outputs: [{ id: 'semantics', label: '建筑语义数据', dataType: 'building_semantics' }],
    defaultParams: { includeFurniture: false, wallThicknessDefaultM: 0.24 },
    executableInG0: true,
  },
  building_model: {
    kind: 'building_model',
    label: '建筑模型',
    category: '图纸与建模',
    description: '通过 Blender 生成可编辑参数化白模 (.blend + .glb)',
    inputs: [{ id: 'semantics', label: '建筑语义数据', dataType: 'building_semantics', required: true }],
    outputs: [{ id: 'model', label: '模型版本', dataType: 'model_version' }],
    defaultParams: {
      storeys: 1,
      floorHeightM: 4.5,
      whiteWallMode: true,
      defaultDoorHeightM: 2.1,
      includeRoofCap: true,
    },
    executableInG0: true,
  },
  existing_model: {
    kind: 'existing_model',
    label: '现有模型',
    category: '图纸与建模',
    description: '安全导入已有 BLEND / GLB（禁用自动脚本），生成预览与不可变版本',
    inputs: [],
    outputs: [{ id: 'model', label: '模型版本', dataType: 'model_version' }],
    defaultParams: { unit: 'm', upAxis: 'Z' },
    executableInG0: true,
  },
  site_compose: {
    kind: 'site_compose',
    label: '场地组合',
    category: '场地与材质',
    description: '多栋建筑引用、相对变换与 L 型内院包裹约束',
    inputs: [{ id: 'models', label: '模型版本', dataType: 'model_version', multiple: true, required: true }],
    outputs: [{ id: 'scene', label: '场景版本', dataType: 'scene_version' }],
    defaultParams: {
      enableLHostBuilding: true,
      courtyardGapM: 4.0,
      newBuildingOffset: [0, 0, 0],
      newBuildingRotationDeg: 0,
    },
    executableInG0: true,
  },
  material: {
    kind: 'material',
    label: '材质修订',
    category: '场地与材质',
    description: '按建筑构件材料槽独立修订颜色与贴图（不改变几何与门窗）',
    inputs: [
      { id: 'model', label: '模型版本', dataType: 'model_version' },
      { id: 'scene', label: '场景版本', dataType: 'scene_version' },
    ],
    outputs: [
      { id: 'model_out', label: '模型版本', dataType: 'model_version' },
      { id: 'scene_out', label: '场景版本', dataType: 'scene_version' },
    ],
    defaultParams: { slotName: 'exterior_wall', baseColorHex: '#D9DDE2', roughness: 0.65 },
    executableInG0: true,
  },
  camera_frame: {
    kind: 'camera_frame',
    label: '相机画框',
    category: '相机与渲染',
    description: '从 3D 视口保存真实相机矩阵、焦距、移轴与画幅',
    inputs: [
      { id: 'model', label: '模型版本', dataType: 'model_version' },
      { id: 'scene', label: '场景版本', dataType: 'scene_version' },
    ],
    outputs: [{ id: 'camera', label: '相机快照', dataType: 'camera_snapshot' }],
    defaultParams: {
      name: '南东人视 1.6m',
      projection: 'perspective',
      focalLengthMm: 35,
      widthPx: 1280,
      heightPx: 720,
      eyeArch: [14, -8, 1.6],
      targetArch: [5, 3, 2.0],
    },
    executableInG0: true,
  },
  native_render: {
    kind: 'native_render',
    label: '原生渲染',
    category: '相机与渲染',
    description: '调用 Blender 渲染真实模型底图与几何通道',
    inputs: [
      { id: 'model', label: '模型版本', dataType: 'model_version' },
      { id: 'scene', label: '场景版本', dataType: 'scene_version' },
      { id: 'camera', label: '相机快照', dataType: 'camera_snapshot', required: true },
    ],
    outputs: [
      { id: 'bundle', label: '原生渲染包', dataType: 'render_bundle' },
      { id: 'image', label: '图像成果', dataType: 'image_artifact' },
    ],
    defaultParams: { engine: 'EEVEE', samples: 32, widthPx: 1280, heightPx: 720, hideRoofCap: false },
    executableInG0: true,
  },
  reference_image: {
    kind: 'reference_image',
    label: '参考图',
    category: 'AI与参考',
    description: '指定显式参考角色：仅视角、材质、光影、景观布局或编辑底图',
    inputs: [],
    outputs: [{ id: 'reference', label: '参考图绑定', dataType: 'reference_binding' }],
    defaultParams: { role: 'lighting_style', weight: 0.7, enabled: true },
    executableInG0: true,
  },
  prompt: {
    kind: 'prompt',
    label: '提示词',
    category: 'AI与参考',
    description: '结构化保持项、修改项与负向约束',
    inputs: [],
    outputs: [{ id: 'prompt', label: '提示词规格', dataType: 'prompt_spec' }],
    defaultParams: { keep: '轮廓、层数、门窗数量、坡屋顶', modify: '', negative: '' },
    executableInG0: true,
  },
  render_image: {
    kind: 'render_image',
    label: '效果图（AI 增强）',
    category: 'AI与参考',
    description: '基于模型底图、参考图与提示词生成效果图（需配置 AI 服务或测试模拟器）',
    inputs: [
      { id: 'bundle', label: '原生渲染包', dataType: 'render_bundle', required: true },
      { id: 'reference', label: '参考图绑定', dataType: 'reference_binding', multiple: true },
      { id: 'prompt', label: '提示词规格', dataType: 'prompt_spec' },
    ],
    outputs: [{ id: 'image', label: '图像成果', dataType: 'image_artifact' }],
    defaultParams: {
      mode: 'model_constrained',
      providerId: 'unconfigured',
      widthPx: 1024,
      heightPx: 1024,
    },
    executableInG0: true,
  },
  local_edit: {
    kind: 'local_edit',
    label: '局部修改',
    category: 'AI与参考',
    description: '明确区分模型构件修改（跨视角同步）与仅图片修饰（未同步模型）',
    inputs: [{ id: 'image', label: '图像成果', dataType: 'image_artifact', required: true }],
    outputs: [{ id: 'image_out', label: '图像成果', dataType: 'image_artifact' }],
    defaultParams: { scope: 'image_only', instruction: '', annotationRegion: '' },
    executableInG0: true,
  },
  camera_path: {
    kind: 'camera_path',
    label: '相机路径',
    category: '相机与渲染',
    description: '串联多个保存相机，逐帧断点渲染并编码模型路径 MP4 视频',
    inputs: [
      { id: 'model', label: '模型版本', dataType: 'model_version' },
      { id: 'scene', label: '场景版本', dataType: 'scene_version' },
      { id: 'cameras', label: '相机快照', dataType: 'camera_snapshot', multiple: true, required: true },
    ],
    outputs: [{ id: 'video', label: '视频成果', dataType: 'video_artifact' }],
    defaultParams: { fps: 12, durationSec: 1.0, widthPx: 640, heightPx: 360, engine: 'EEVEE' },
    executableInG0: true,
  },
  video: {
    kind: 'video',
    label: '视频输出',
    category: '交付',
    description: '模型路径渲染或生成式视频（独立标识来源与跨帧复核状态）',
    inputs: [{ id: 'video_in', label: '视频成果', dataType: 'video_artifact' }],
    outputs: [{ id: 'video_out', label: '视频成果', dataType: 'video_artifact' }],
    defaultParams: { mode: 'model_path', providerId: 'unconfigured', prompt: '', durationSec: 4, fps: 24 },
    executableInG0: true,
  },
  export: {
    kind: 'export',
    label: '导出交付',
    category: '交付',
    description: '按真实格式、像素与版本清单导出到本地目录',
    inputs: [
      { id: 'drawing', label: '图纸/数据', dataType: 'calibrated_drawing' },
      { id: 'model', label: '模型版本', dataType: 'model_version' },
      { id: 'image', label: '图像成果', dataType: 'image_artifact' },
      { id: 'video', label: '视频成果', dataType: 'video_artifact' },
    ],
    outputs: [{ id: 'manifest', label: '导出清单', dataType: 'export_manifest' }],
    defaultParams: { format: 'json_report', includeManifest: true },
    executableInG0: true,
  },
};

export function getNodeDefinition(kind: NodeKind): NodeTypeDefinition {
  return NODE_REGISTRY[kind];
}
