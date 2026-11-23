import fs from 'node:fs';
import path from 'node:path';
import {
  validateRequestedSize,
  type ConnectionReport,
  type NormalizedGenerationRequest,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderConfig,
  type RemoteTask,
} from './types.js';

/**
 * 明确标注的测试模拟器适配器（总规格 §14 & 启动指令）：
 * 绝不冒充真实 AI 实拍或第三方 API 结果，仅在用户显式选择模拟测试时，
 * 验证“提示词编译 → 尺寸能力协商 → 归档记录”管线，并显式标明 origin='mock_simulator'。
 */
export class MockSimulatorAdapter implements ProviderAdapter {
  public readonly kind = 'mock_simulator' as const;

  public async validateConfig(config: ProviderConfig): Promise<ConnectionReport> {
    return {
      ok: true,
      providerId: config.id,
      kind: this.kind,
      message: '已连接内置测试模拟器（仅用于离线链路联调，输出将明确标注为“测试模拟”，不代表真实 AI 生成）。',
      discoveredModels: ['archcanvas-mock-v1'],
    };
  }

  public getCapabilities(_modelId: string): ProviderCapabilities {
    return {
      textAnalysis: false,
      vision: false,
      textToImage: false,
      imageToImage: true,
      maskedEdit: false,
      multiReference: true,
      conditioning: [],
      imageSizes: [
        { width: 640, height: 360 },
        { width: 1024, height: 1024 },
        { width: 1280, height: 720 },
      ],
      negativePrompt: true,
      seed: true,
      imageToVideo: false,
      videoToVideo: false,
      firstLastFrame: false,
      supportsCancel: true,
      videoSizes: [],
      videoDurationSeconds: [],
      discoveredAt: new Date().toISOString(),
      verification: 'documented',
    };
  }

  public async submit(
    config: ProviderConfig,
    request: NormalizedGenerationRequest
  ): Promise<RemoteTask> {
    const caps = this.getCapabilities(config.modelId);
    const sizeCheck = validateRequestedSize(
      caps,
      request.requestedWidthPx,
      request.requestedHeightPx
    );
    if (!sizeCheck.supported) {
      return {
        remoteTaskId: `mock-rejected-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        origin: 'mock_simulator',
        warnings: [],
        errorMessage: sizeCheck.reason,
      };
    }

    if (!fs.existsSync(request.baseImagePath)) {
      return {
        remoteTaskId: `mock-err-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        origin: 'mock_simulator',
        warnings: [],
        errorMessage: `底图文件不存在：${request.baseImagePath}`,
      };
    }

    fs.mkdirSync(request.outputDir, { recursive: true });
    const outPng = path.join(request.outputDir, 'mock_output.png');
    fs.copyFileSync(request.baseImagePath, outPng);

    // 读取真实 PNG 头尺寸，不伪造
    const buf = fs.readFileSync(outPng);
    const actualW = buf.length >= 24 ? buf.readUInt32BE(16) : request.requestedWidthPx;
    const actualH = buf.length >= 24 ? buf.readUInt32BE(20) : request.requestedHeightPx;

    return {
      remoteTaskId: `mock-${Date.now().toString(36)}`,
      providerId: config.id,
      modelId: config.modelId,
      status: 'succeeded',
      outputFilePath: outPng,
      actualWidthPx: actualW,
      actualHeightPx: actualH,
      origin: 'mock_simulator',
      warnings: [
        '此结果为内置测试模拟器输出（基于原生底图直通校验，未调用外部 AI 图像服务）。',
      ],
    };
  }
}
