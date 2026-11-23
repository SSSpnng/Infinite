import type { ReferenceRole } from '@archcanvas/contracts';

export interface ProviderCapabilities {
  textAnalysis: boolean;
  vision: boolean;
  textToImage: boolean;
  imageToImage: boolean;
  maskedEdit: boolean;
  multiReference: boolean;
  conditioning: ('depth' | 'normal' | 'edges' | 'segmentation')[];
  imageSizes: { width: number; height: number }[];
  customImageSize?: { multipleOf: number; maxPixels: number; maxEdge: number };
  negativePrompt: boolean;
  seed: boolean;
  imageToVideo: boolean;
  videoToVideo: boolean;
  firstLastFrame: boolean;
  supportsCancel: boolean;
  videoSizes: { width: number; height: number; fps: number[] }[];
  videoDurationSeconds: number[];
  discoveredAt: string;
  verification: 'documented' | 'probed' | 'unknown';
}

export interface ProviderConfig {
  id: string;
  label: string;
  kind: 'openai_compat' | 'mock_simulator';
  baseUrl: string;
  modelId: string;
  /** 仅保存凭据引用 ID，绝不在项目配置中存放明文 API Key */
  credentialId?: string;
  timeoutMs?: number;
}

export interface ConnectionReport {
  ok: boolean;
  providerId: string;
  kind: ProviderConfig['kind'];
  message: string;
  discoveredModels?: string[];
}

export interface ReferenceInputItem {
  id: string;
  role: ReferenceRole;
  filePath: string;
  label: string;
  weight: number;
  enabled: boolean;
  targetElementIds?: string[];
  allowedChanges?: string[];
}

export interface NormalizedGenerationRequest {
  taskId: string;
  mode: 'model_constrained' | 'concept_exploration';
  baseImagePath: string;
  compiledPrompt: string;
  negativePrompt?: string;
  references: ReferenceInputItem[];
  requestedWidthPx: number;
  requestedHeightPx: number;
  seed?: number;
  outputDir: string;
}

export interface RemoteTask {
  remoteTaskId: string;
  providerId: string;
  modelId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  outputFilePath?: string;
  actualWidthPx?: number;
  actualHeightPx?: number;
  origin: 'provider_native' | 'ai_enhanced' | 'mock_simulator';
  warnings: string[];
  errorMessage?: string;
}

export interface ProviderAdapter {
  readonly kind: ProviderConfig['kind'];
  validateConfig(config: ProviderConfig, apiKey?: string): Promise<ConnectionReport>;
  getCapabilities(modelId: string): ProviderCapabilities;
  submit(
    config: ProviderConfig,
    request: NormalizedGenerationRequest,
    apiKey?: string
  ): Promise<RemoteTask>;
}

/**
 * 校验请求像素尺寸是否受当前供应商能力支持；绝不悄悄伪造原生大图（总规格 §14.2 & G2 验收）
 */
export function validateRequestedSize(
  caps: ProviderCapabilities,
  widthPx: number,
  heightPx: number
): { supported: boolean; reason?: string } {
  const exactMatch = caps.imageSizes.some(
    (s) => s.width === widthPx && s.height === heightPx
  );
  if (exactMatch) {
    return { supported: true };
  }
  if (caps.customImageSize) {
    const { multipleOf, maxPixels, maxEdge } = caps.customImageSize;
    if (
      widthPx % multipleOf === 0 &&
      heightPx % multipleOf === 0 &&
      widthPx <= maxEdge &&
      heightPx <= maxEdge &&
      widthPx * heightPx <= maxPixels
    ) {
      return { supported: true };
    }
  }
  const supportedList = caps.imageSizes.map((s) => `${s.width}×${s.height}`).join('、');
  return {
    supported: false,
    reason: `当前模型原生仅支持尺寸：${supportedList || '未声明'}；不支持直接原生输出 ${widthPx}×${heightPx}。请先按受支持尺寸生成，再通过导出面板执行明确标注来源的放大/超分。`,
  };
}
