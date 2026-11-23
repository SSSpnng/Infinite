import { describe, expect, it } from 'vitest';
import {
  compileArchitecturalPrompt,
  MockSimulatorAdapter,
  MockVideoSimulatorAdapter,
  OpenAiCompatAdapter,
  OpenAiCompatVideoAdapter,
  validateRequestedSize,
} from './index.js';

describe('@archcanvas/providers', () => {
  it('enforces explicit reference roles and forbids copying old stairs for camera-only reference (C02)', () => {
    const adapter = new OpenAiCompatAdapter();
    const caps = adapter.getCapabilities('gpt-image-1');
    const compiled = compileArchitecturalPrompt({
      mode: 'model_constrained',
      modelVersionId: 'mv-1234',
      cameraName: '北东两立面',
      keepText: '轮廓、层数、门窗数量、坡屋顶',
      modifyText: '银灰格栅改回银灰色',
      negativeText: '',
      materialOverrides: [{ slotName: 'grille', baseColorHex: '#B8BEC4' }],
      references: [
        {
          id: 'ref-1',
          role: 'camera',
          filePath: 'sources/old_stairs.png',
          label: '旧视角参考图',
          weight: 0.8,
          enabled: true,
        },
      ],
      requestedWidthPx: 1024,
      requestedHeightPx: 1024,
      capabilities: caps,
    });

    expect(compiled.compiledPrompt).toContain('严禁恢复其旧楼梯');
    expect(compiled.compiledPrompt).toContain('grille=#B8BEC4');
    expect(compiled.capabilityWarnings.length).toBeGreaterThan(0); // RGB-only conditioning warning (C06)
  });

  it('rejects unsupported native 4K size instead of faking native large image (G2 gate)', () => {
    const adapter = new OpenAiCompatAdapter();
    const caps = adapter.getCapabilities('gpt-image-1');
    const check = validateRequestedSize(caps, 3840, 2160);
    expect(check.supported).toBe(false);
    expect(check.reason).toContain('不支持直接原生输出 3840×2160');
  });

  it('mock simulator validates size honestly and never claims native 4K', async () => {
    const mock = new MockSimulatorAdapter();
    const res = await mock.submit(
      {
        id: 'mock',
        label: '测试模拟器',
        kind: 'mock_simulator',
        baseUrl: 'local://mock',
        modelId: 'archcanvas-mock-v1',
      },
      {
        taskId: 't1',
        mode: 'model_constrained',
        baseImagePath: 'nonexistent.png',
        compiledPrompt: 'test',
        references: [],
        requestedWidthPx: 3840,
        requestedHeightPx: 2160,
        outputDir: '.',
      }
    );
    expect(res.status).toBe('failed');
    expect(res.errorMessage).toContain('不支持直接原生输出');
  });

  it('tracks generative video source and review_required status distinctly from model-path renders', async () => {
    const oaiVid = new OpenAiCompatVideoAdapter();
    const noKeyRes = await oaiVid.submitVideo(
      {
        id: 'oai-vid',
        label: '外部视频',
        kind: 'openai_compat',
        baseUrl: 'https://api.example.invalid/v1',
        modelId: 'video-1',
      },
      {
        taskId: 'v1',
        keyframeImagePath: 'a.png',
        prompt: 'camera orbit',
        durationSec: 4,
        fps: 24,
        widthPx: 1280,
        heightPx: 720,
        outputDir: '.',
      }
    );
    expect(noKeyRes.status).toBe('failed');
    expect(noKeyRes.videoSource).toBe('generative_video');
    expect(noKeyRes.validationStatus).toBe('review_required');

    const mockVid = new MockVideoSimulatorAdapter();
    expect(mockVid).toBeDefined();
  });
});
