import React, { useEffect, useState } from 'react';
import type { EnvironmentProbeReport, ProjectManifest } from '@archcanvas/contracts';
import type { ProviderConfig } from '@archcanvas/providers';

interface SettingsModalProps {
  report: EnvironmentProbeReport | null;
  manifest: ProjectManifest | null;
  probing: boolean;
  onReprobe: (overrides?: ProjectManifest['toolOverrides']) => void;
  onSaveSettings: (patch: {
    exportDirectory?: string;
    toolOverrides?: ProjectManifest['toolOverrides'];
  }) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  report,
  manifest,
  probing,
  onReprobe,
  onSaveSettings,
  onClose,
}) => {
  const [blenderPath, setBlenderPath] = useState(manifest?.toolOverrides?.blenderPath ?? '');
  const [pythonPath, setPythonPath] = useState(manifest?.toolOverrides?.pythonPath ?? '');
  const [dwgConverterPath, setDwgConverterPath] = useState(
    manifest?.toolOverrides?.dwgConverterPath ?? ''
  );
  const [ffmpegPath, setFfmpegPath] = useState(manifest?.toolOverrides?.ffmpegPath ?? '');
  const [providers, setProviders] = useState<(ProviderConfig & { hasApiKey: boolean })[]>([]);
  const [oaiBaseUrl, setOaiBaseUrl] = useState('https://api.openai.com/v1');
  const [oaiModelId, setOaiModelId] = useState('gpt-image-1');
  const [oaiApiKey, setOaiApiKey] = useState('');
  const [providerMsg, setProviderMsg] = useState<string | null>(null);

  useEffect(() => {
    void window.archcanvas.listProviders().then((res) => {
      if (res.ok) {
        setProviders(res.data);
        const oai = res.data.find((p) => p.id === 'openai_default');
        if (oai) {
          setOaiBaseUrl(oai.baseUrl);
          setOaiModelId(oai.modelId);
        }
      }
    });
  }, []);

  const handleSaveOpenAi = async () => {
    const res = await window.archcanvas.saveProvider({
      id: 'openai_default',
      label: `OpenAI 兼容 (${oaiModelId})`,
      kind: 'openai_compat',
      baseUrl: oaiBaseUrl.trim(),
      modelId: oaiModelId.trim(),
      apiKey: oaiApiKey.trim() || undefined,
    });
    if (res.ok) {
      setOaiApiKey('');
      setProviderMsg('已保存服务配置（API Key 仅存主进程系统凭据库，不写入项目文件）。');
      const list = await window.archcanvas.listProviders();
      if (list.ok) setProviders(list.data);
      onReprobe();
    } else {
      setProviderMsg(`保存失败：${res.error.message}`);
    }
  };

  const handleTestProvider = async (id: string) => {
    setProviderMsg('正在测试连接...');
    const res = await window.archcanvas.testProvider(id);
    if (res.ok) {
      setProviderMsg(res.data.message);
    } else {
      setProviderMsg(`测试失败：${res.error.message}`);
    }
  };

  const currentOverrides = {
    blenderPath: blenderPath.trim() || undefined,
    pythonPath: pythonPath.trim() || undefined,
    dwgConverterPath: dwgConverterPath.trim() || undefined,
    ffmpegPath: ffmpegPath.trim() || undefined,
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>环境能力探测与本地工具配置</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onReprobe(currentOverrides)} disabled={probing}>
              {probing ? '探测中...' : '重新探测'}
            </button>
            <button onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="modal-body">
          <div className="probe-item">
            <div className="probe-item-top">
              <strong>GPU 加速设备</strong>
              <span className={report?.gpu.available ? 'badge badge-ok' : 'badge badge-warn'}>
                {report?.gpu.available ? '可用' : '未检测到 NVIDIA GPU'}
              </span>
            </div>
            <div style={{ color: '#9aa7b8', fontSize: 12 }}>
              {report?.gpu.available
                ? `${report.gpu.name}（显存 ${report.gpu.vramMb ?? '?'} MB，驱动 ${report.gpu.driverVersion ?? '-'}）`
                : '将回退到 CPU 渲染模式（不影响建模）。'}
            </div>
          </div>

          <div className="probe-item">
            <div className="probe-item-top">
              <strong>AI 图像 / 视频服务（BYOK，密钥不写入项目）</strong>
              <span className={report?.aiProvidersConfigured ? 'badge badge-ok' : 'badge badge-warn'}>
                {report?.aiProvidersConfigured ? '已配置真实服务' : '未配置外部服务'}
              </span>
            </div>
            <div style={{ color: '#9aa7b8', fontSize: 12, marginBottom: 8 }}>
              API Key 仅保存在本机主进程 OS 加密凭据区，导出项目与日志绝不包含密钥。未配置时仍可使用完整本地建模与内置测试模拟器。
            </div>
            <div className="field">
              <label>OpenAI 兼容 Base URL</label>
              <input value={oaiBaseUrl} onChange={(e) => setOaiBaseUrl(e.target.value)} />
            </div>
            <div className="field">
              <label>图像模型 ID（如 gpt-image-1）</label>
              <input value={oaiModelId} onChange={(e) => setOaiModelId(e.target.value)} />
            </div>
            <div className="field">
              <label>API Key（留空表示保持已存密钥不变）</label>
              <input
                type="password"
                value={oaiApiKey}
                onChange={(e) => setOaiApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <button className="primary" onClick={() => void handleSaveOpenAi()}>
                保存 AI 服务与凭据
              </button>
              <button onClick={() => void handleTestProvider('openai_default')}>
                测试连接 (/models)
              </button>
              <button onClick={() => void handleTestProvider('mock_simulator')}>
                检查内置模拟器
              </button>
            </div>
            {providerMsg && <div style={{ fontSize: 12, color: '#93c5fd' }}>{providerMsg}</div>}
            <div style={{ fontSize: 11, color: '#9aa7b8', marginTop: 4 }}>
              已注册适配器：{providers.map((p) => `${p.label}${p.hasApiKey ? ' [含Key]' : ''}`).join(' ｜ ')}
            </div>
          </div>

          {report?.tools.map((tool) => (
            <div key={tool.id} className="probe-item">
              <div className="probe-item-top">
                <strong>
                  {tool.label}{' '}
                  {tool.required ? (
                    <span style={{ color: '#93c5fd', fontSize: 11 }}>（核心依赖）</span>
                  ) : (
                    <span style={{ color: '#9aa7b8', fontSize: 11 }}>（可选组件）</span>
                  )}
                </strong>
                <span className={tool.available ? 'badge badge-ok' : 'badge badge-err'}>
                  {tool.available ? '已就绪' : '缺失'}
                </span>
              </div>
              {tool.version && <div style={{ fontSize: 12 }}>版本：{tool.version}</div>}
              {tool.path && (
                <div style={{ fontSize: 11, color: '#9aa7b8', wordBreak: 'break-all' }}>
                  路径：{tool.path}
                </div>
              )}
              {tool.details && (
                <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2 }}>{tool.details}</div>
              )}
              {tool.error && (
                <div style={{ fontSize: 12, color: '#fca5a5', marginTop: 2 }}>{tool.error}</div>
              )}
            </div>
          ))}

          {manifest && (
            <>
              <div className="section-title">项目级手动路径覆盖（留空则自动探测，不写死本机路径）</div>
              <div className="field">
                <label>Blender 可执行文件（blender.exe）</label>
                <input
                  value={blenderPath}
                  onChange={(e) => setBlenderPath(e.target.value)}
                  placeholder="留空自动探测"
                />
              </div>
              <div className="field">
                <label>Python 解释器（python.exe）</label>
                <input
                  value={pythonPath}
                  onChange={(e) => setPythonPath(e.target.value)}
                  placeholder="留空优先使用 workers/geometry/.venv"
                />
              </div>
              <div className="field">
                <label>DWG 转换器（accoreconsole.exe / ODAFileConverter.exe）</label>
                <input
                  value={dwgConverterPath}
                  onChange={(e) => setDwgConverterPath(e.target.value)}
                  placeholder="留空自动探测"
                />
              </div>
              <div className="field">
                <label>FFmpeg（ffmpeg.exe）</label>
                <input
                  value={ffmpegPath}
                  onChange={(e) => setFfmpegPath(e.target.value)}
                  placeholder="留空自动探测"
                />
              </div>
              <button
                className="primary"
                onClick={() => {
                  onSaveSettings({ toolOverrides: currentOverrides });
                  onReprobe(currentOverrides);
                }}
              >
                保存配置并重新探测
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
