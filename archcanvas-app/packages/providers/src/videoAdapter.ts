import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from './types.js';

export interface VideoGenerationRequest {
  taskId: string;
  keyframeImagePath: string;
  prompt: string;
  durationSec: number;
  fps: number;
  widthPx: number;
  heightPx: number;
  outputDir: string;
}

export interface RemoteVideoTask {
  remoteTaskId: string;
  providerId: string;
  modelId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  videoSource: 'generative_video' | 'mock_generative_video';
  validationStatus: 'review_required' | 'pending';
  outputFilePath?: string;
  warnings: string[];
  errorMessage?: string;
}

export interface VideoProviderAdapter {
  submitVideo(
    config: ProviderConfig,
    request: VideoGenerationRequest,
    apiKey?: string
  ): Promise<RemoteVideoTask>;
  pollVideo(
    config: ProviderConfig,
    remoteTaskId: string,
    apiKey?: string
  ): Promise<RemoteVideoTask>;
}

/**
 * 异步生成式视频适配器（总规格 §9.2）：
 * - 独立标识 videoSource='generative_video'，不与模型路径渲染混淆
 * - 强制标注 validationStatus='review_required'，要求核查跨帧楼层、门窗与轮廓漂移
 */
export class OpenAiCompatVideoAdapter implements VideoProviderAdapter {
  public async submitVideo(
    config: ProviderConfig,
    request: VideoGenerationRequest,
    apiKey?: string
  ): Promise<RemoteVideoTask> {
    if (!apiKey?.trim()) {
      return {
        remoteTaskId: `vid-err-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        videoSource: 'generative_video',
        validationStatus: 'review_required',
        warnings: [],
        errorMessage: '未配置外部视频 API Key，无法提交生成式视频任务（本地模型路径视频不受影响）。',
      };
    }

    const base = config.baseUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/videos/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.modelId,
          prompt: request.prompt,
          duration: request.durationSec,
          fps: request.fps,
          size: `${request.widthPx}x${request.heightPx}`,
        }),
      });
      if (!res.ok) {
        return {
          remoteTaskId: `vid-http-${res.status}-${Date.now()}`,
          providerId: config.id,
          modelId: config.modelId,
          status: 'failed',
          videoSource: 'generative_video',
          validationStatus: 'review_required',
          warnings: [],
          errorMessage: `生成式视频提交失败（HTTP ${res.status}）。`,
        };
      }
      const data = (await res.json()) as { id?: string; status?: string };
      return {
        remoteTaskId: data.id ?? `vid-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: data.status === 'succeeded' ? 'succeeded' : 'queued',
        videoSource: 'generative_video',
        validationStatus: 'review_required',
        warnings: ['生成式视频可能产生跨帧建筑漂移，完成后须逐帧复核门窗与轮廓。'],
      };
    } catch (err) {
      return {
        remoteTaskId: `vid-net-${Date.now()}`,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        videoSource: 'generative_video',
        validationStatus: 'review_required',
        warnings: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async pollVideo(
    config: ProviderConfig,
    remoteTaskId: string,
    apiKey?: string
  ): Promise<RemoteVideoTask> {
    if (!apiKey?.trim()) {
      return {
        remoteTaskId,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        videoSource: 'generative_video',
        validationStatus: 'review_required',
        warnings: [],
        errorMessage: '缺少 API Key，无法查询远端视频任务状态。',
      };
    }
    const base = config.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/videos/generations/${encodeURIComponent(remoteTaskId)}`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    if (!res.ok) {
      return {
        remoteTaskId,
        providerId: config.id,
        modelId: config.modelId,
        status: 'failed',
        videoSource: 'generative_video',
        validationStatus: 'review_required',
        warnings: [],
        errorMessage: `查询远端视频任务失败（HTTP ${res.status}）。`,
      };
    }
    const data = (await res.json()) as { status?: string };
    return {
      remoteTaskId,
      providerId: config.id,
      modelId: config.modelId,
      status: data.status === 'succeeded' ? 'succeeded' : 'running',
      videoSource: 'generative_video',
      validationStatus: 'review_required',
      warnings: ['生成式视频须复核跨帧建筑结构一致性。'],
    };
  }
}

/**
 * 明确标注来源的离线生成式视频测试模拟器（仅用于验证异步记录与复核标记，不伪造实拍）
 */
export class MockVideoSimulatorAdapter implements VideoProviderAdapter {
  public async submitVideo(
    config: ProviderConfig,
    request: VideoGenerationRequest
  ): Promise<RemoteVideoTask> {
    fs.mkdirSync(request.outputDir, { recursive: true });
    const metaPath = path.join(request.outputDir, 'mock_generative_video_record.json');
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          simulated: true,
          videoSource: 'mock_generative_video',
          validationStatus: 'review_required',
          prompt: request.prompt,
          durationSec: request.durationSec,
          fps: request.fps,
          size: `${request.widthPx}x${request.heightPx}`,
        },
        null,
        2
      ),
      'utf-8'
    );
    return {
      remoteTaskId: `mock-vid-${Date.now().toString(36)}`,
      providerId: config.id,
      modelId: config.modelId,
      status: 'succeeded',
      videoSource: 'mock_generative_video',
      validationStatus: 'review_required',
      outputFilePath: metaPath,
      warnings: [
        '此结果为生成式视频模拟器记录（未调用外部付费视频 API），且生成式视频必须复核跨帧建筑漂移。',
      ],
    };
  }

  public async pollVideo(config: ProviderConfig, remoteTaskId: string): Promise<RemoteVideoTask> {
    return {
      remoteTaskId,
      providerId: config.id,
      modelId: config.modelId,
      status: 'succeeded',
      videoSource: 'mock_generative_video',
      validationStatus: 'review_required',
      warnings: ['模拟任务已完成。'],
    };
  }
}
