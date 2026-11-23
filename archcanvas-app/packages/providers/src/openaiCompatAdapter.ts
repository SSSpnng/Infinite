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
 * 可配置的 OpenAI 兼容图像适配器（总规格 §14.1）：
 * - 连接测试调用低成本 GET /models
 * - 生成调用 POST /images/edits（携带真实底图与编译后提示词）
 * - 绝不把不支持的尺寸伪造为原生大图；绝不在返回体或日志中泄露 API Key
 */
export class OpenAiCompatAdapter implements ProviderAdapter {
  public readonly kind = 'openai_compat' as const;

  public async validateConfig(
    config: ProviderConfig,
    apiKey?: string
  ): Promise<ConnectionReport> {
    if (!apiKey?.trim()) {
      return {
        ok: false,
        providerId: config.id,
        kind: this.kind,
        message: '未配置 API Key，请先在设置中保存凭据。',
      };
    }
    const base = config.baseUrl.replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);
      const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          ok: false,
          providerId: config.id,
          kind: this.kind,
          message: `连接测试失败（HTTP ${res.status}），请检查 Base URL 与 API Key。`,
        };
      }
      const data = (await res.json()) as { data?: { id?: string }[] };
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id))
        .slice(0, 20);
      return {
        ok: true,
        providerId: config.id,
        kind: this.kind,
        message: `连接成功，发现 ${models.length} 个模型（具体图像能力需以接口实测为准）。`,
        discoveredModels: models,
      };
    } catch (err) {
      return {
        ok: false,
        providerId: config.id,
        kind: this.kind,
        message: `无法连接到 ${base}：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public getCapabilities(modelId: string): ProviderCapabilities {
    const isGptImage = /gpt-image/i.test(modelId);
    return {
      textAnalysis: false,
      vision: false,
      textToImage: true,
      imageToImage: true,
      maskedEdit: true,
      multiReference: isGptImage,
      conditioning: [],
      imageSizes: isGptImage
        ? [
            { width: 1024, height: 1024 },
            { width: 1536, height: 1024 },
            { width: 1024, height: 1536 },
          ]
        : [
            { width: 1024, height: 1024 },
            { width: 1792, height: 1024 },
            { width: 1024, height: 1792 },
          ],
      negativePrompt: false,
      seed: false,
      imageToVideo: false,
      videoToVideo: false,
      firstLastFrame: false,
      supportsCancel: false,
      videoSizes: [],
      videoDurationSeconds: [],
      discoveredAt: new Date().toISOString(),
      verification: 'documented',
    };
  }

  public async submit(
    config: ProviderConfig,
    request: NormalizedGenerationRequest,
    apiKey?: string
  ): Promise<RemoteTask> {
    if (!apiKey?.trim()) {
      return {
        remoteTaskId: `err-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        origin: 'ai_enhanced',
        warnings: [],
        errorMessage: '未配置 API Key，无法调用外部图像接口。',
      };
    }

    const caps = this.getCapabilities(config.modelId);
    const sizeCheck = validateRequestedSize(
      caps,
      request.requestedWidthPx,
      request.requestedHeightPx
    );
    if (!sizeCheck.supported) {
      return {
        remoteTaskId: `size-rejected-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        origin: 'ai_enhanced',
        warnings: [],
        errorMessage: sizeCheck.reason,
      };
    }

    const base = config.baseUrl.replace(/\/+$/, '');
    const imgBytes = fs.readFileSync(request.baseImagePath);
    const form = new FormData();
    form.append('model', config.modelId);
    form.append('prompt', request.compiledPrompt);
    form.append('size', `${request.requestedWidthPx}x${request.requestedHeightPx}`);
    form.append('response_format', 'b64_json');
    form.append(
      'image',
      new Blob([imgBytes], { type: 'image/png' }),
      path.basename(request.baseImagePath)
    );

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 120000);
      const res = await fetch(`${base}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return {
          remoteTaskId: `http-${res.status}-${Date.now()}`,
          providerId: config.id,
          modelId: config.modelId,
          status: 'failed',
          origin: 'ai_enhanced',
          warnings: [],
          errorMessage: `图像生成请求失败（HTTP ${res.status}）：${errBody.slice(0, 300)}`,
        };
      }

      const payload = (await res.json()) as {
        data?: { b64_json?: string; url?: string }[];
      };
      const first = payload.data?.[0];
      if (!first) {
        throw new Error('接口响应中未包含图像数据。');
      }

      fs.mkdirSync(request.outputDir, { recursive: true });
      const outPng = path.join(request.outputDir, 'ai_enhanced.png');

      if (first.b64_json) {
        fs.writeFileSync(outPng, Buffer.from(first.b64_json, 'base64'));
      } else if (first.url) {
        const dl = await fetch(first.url);
        if (!dl.ok) throw new Error(`下载临时图像 URL 失败（HTTP ${dl.status}）`);
        fs.writeFileSync(outPng, Buffer.from(await dl.arrayBuffer()));
      } else {
        throw new Error('接口未返回 b64_json 或 url。');
      }

      const outBuf = fs.readFileSync(outPng);
      const actualW = outBuf.length >= 24 ? outBuf.readUInt32BE(16) : request.requestedWidthPx;
      const actualH = outBuf.length >= 24 ? outBuf.readUInt32BE(20) : request.requestedHeightPx;

      return {
        remoteTaskId: `oai-${Date.now().toString(36)}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'succeeded',
        outputFilePath: outPng,
        actualWidthPx: actualW,
        actualHeightPx: actualH,
        origin: 'ai_enhanced',
        warnings: [
          '此图为 AI 增强结果（仅基于 RGB 底图约束），请与原生底图叠加复核门窗数量与轮廓。',
        ],
      };
    } catch (err) {
      return {
        remoteTaskId: `neterr-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        origin: 'ai_enhanced',
        warnings: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
