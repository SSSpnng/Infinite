import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '@archcanvas/providers';

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * 主进程安全凭据与供应商配置存储（总规格 §14.4 & D03）：
 * - API Key 仅保存在本机用户配置目录的 OS safeStorage 加密文件（或测试环境内存），
 *   绝不写入项目目录、project.json、project.sqlite、任务日志或导出清单！
 */
export class CredentialStore {
  private readonly memoryKeys = new Map<string, string>();
  private providers = new Map<string, ProviderConfig>();
  private readonly storageFilePath: string | null;
  private readonly safeStorage: SafeStorageLike | null;

  constructor(opts?: { userDataDir?: string; safeStorage?: SafeStorageLike | null }) {
    this.safeStorage = opts?.safeStorage ?? null;
    this.storageFilePath = opts?.userDataDir
      ? path.join(opts.userDataDir, 'archcanvas-providers.enc.json')
      : null;

    // 默认内置明确标注的离线测试模拟器（无密钥）
    this.providers.set('mock_simulator', {
      id: 'mock_simulator',
      label: '内置测试模拟器（仅联调，非真实 AI）',
      kind: 'mock_simulator',
      baseUrl: 'local://mock',
      modelId: 'archcanvas-mock-v1',
    });

    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storageFilePath, 'utf-8')) as {
        providers?: ProviderConfig[];
        encryptedKeys?: Record<string, string>;
      };
      for (const p of raw.providers ?? []) {
        this.providers.set(p.id, p);
      }
      if (raw.encryptedKeys && this.safeStorage?.isEncryptionAvailable()) {
        for (const [credId, b64] of Object.entries(raw.encryptedKeys)) {
          try {
            const plain = this.safeStorage.decryptString(Buffer.from(b64, 'base64'));
            this.memoryKeys.set(credId, plain);
          } catch {
            // ignore corrupted entry
          }
        }
      }
    } catch {
      // ignore corrupted file
    }
  }

  private persistToDisk(): void {
    if (!this.storageFilePath) return;
    fs.mkdirSync(path.dirname(this.storageFilePath), { recursive: true });
    const encryptedKeys: Record<string, string> = {};
    if (this.safeStorage?.isEncryptionAvailable()) {
      for (const [credId, plain] of this.memoryKeys.entries()) {
        encryptedKeys[credId] = this.safeStorage.encryptString(plain).toString('base64');
      }
    }
    const payload = {
      providers: Array.from(this.providers.values()),
      encryptedKeys,
    };
    fs.writeFileSync(this.storageFilePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  public listProviders(): (ProviderConfig & { hasApiKey: boolean })[] {
    return Array.from(this.providers.values()).map((p) => ({
      ...p,
      hasApiKey: Boolean(p.credentialId && this.memoryKeys.has(p.credentialId)),
    }));
  }

  public getProvider(providerId: string): ProviderConfig | undefined {
    return this.providers.get(providerId);
  }

  public saveProvider(config: ProviderConfig, apiKey?: string): ProviderConfig & { hasApiKey: boolean } {
    const credId =
      config.kind === 'openai_compat'
        ? config.credentialId || `cred-${config.id}`
        : undefined;
    const saved: ProviderConfig = { ...config, credentialId: credId };
    this.providers.set(saved.id, saved);
    if (credId && apiKey !== undefined && apiKey.trim().length > 0) {
      this.memoryKeys.set(credId, apiKey.trim());
    }
    this.persistToDisk();
    return {
      ...saved,
      hasApiKey: Boolean(credId && this.memoryKeys.has(credId)),
    };
  }

  public getApiKey(credentialId?: string): string | undefined {
    if (!credentialId) return undefined;
    return this.memoryKeys.get(credentialId);
  }

  public hasAnyRealProviderConfigured(): boolean {
    for (const p of this.providers.values()) {
      if (p.kind === 'openai_compat' && p.credentialId && this.memoryKeys.has(p.credentialId)) {
        return true;
      }
    }
    return false;
  }
}
