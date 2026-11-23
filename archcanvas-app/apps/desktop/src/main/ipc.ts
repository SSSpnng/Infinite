import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  CanvasGraphSchema,
  type IpcResult,
  type TaskRecord,
} from '@archcanvas/contracts';
import { probeEnvironment, type ToolPathOverrides } from './envProbe.js';
import type { CredentialStore } from './credentialStore.js';
import type { ProjectStore } from './projectStore.js';
import type { TaskRunner } from './taskRunner.js';

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function fail(code: string, err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code, message } };
}

const CreateProjectInput = z.object({
  projectDir: z.string().min(1),
  name: z.string().min(1),
  projectType: z.enum(['building', 'interior', 'campus']).default('building'),
});

const OpenProjectInput = z.object({
  projectDir: z.string().min(1),
});

const ImportFileInput = z.object({
  filePath: z.string().min(1),
});

const UpdateSettingsInput = z.object({
  exportDirectory: z.string().optional(),
  toolOverrides: z
    .object({
      blenderPath: z.string().optional(),
      pythonPath: z.string().optional(),
      dwgConverterPath: z.string().optional(),
      ffmpegPath: z.string().optional(),
    })
    .optional(),
});

export function registerIpcHandlers(opts: {
  store: ProjectStore;
  runner: TaskRunner;
  credentials: CredentialStore;
  appRootDir: string;
  getWindow: () => BrowserWindow | null;
}): void {
  const { store, runner, credentials, appRootDir, getWindow } = opts;

  runner.onTaskUpdate((task: TaskRecord) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('archcanvas:task-updated', task);
    }
  });

  ipcMain.handle('project:create', async (_ev, raw) => {
    try {
      const input = CreateProjectInput.parse(raw);
      const snapshot = await store.createProject(
        input.projectDir,
        input.name,
        input.projectType
      );
      return ok(snapshot);
    } catch (err) {
      return fail('PROJECT_CREATE_ERROR', err);
    }
  });

  ipcMain.handle('project:open', async (_ev, raw) => {
    try {
      const input = OpenProjectInput.parse(raw);
      const snapshot = await store.openProject(input.projectDir);
      return ok(snapshot);
    } catch (err) {
      return fail('PROJECT_OPEN_ERROR', err);
    }
  });

  ipcMain.handle('project:get-snapshot', async () => {
    try {
      return ok(store.getSnapshot());
    } catch (err) {
      return fail('PROJECT_NOT_OPEN', err);
    }
  });

  ipcMain.handle('project:save-graph', async (_ev, rawGraph) => {
    try {
      const parsed = CanvasGraphSchema.parse(rawGraph);
      const saved = store.saveCanvasGraph(parsed);
      return ok(saved);
    } catch (err) {
      return fail('GRAPH_SAVE_ERROR', err);
    }
  });

  ipcMain.handle('project:update-settings', async (_ev, raw) => {
    try {
      const input = UpdateSettingsInput.parse(raw);
      const manifest = store.updateManifest(input);
      return ok(manifest);
    } catch (err) {
      return fail('SETTINGS_UPDATE_ERROR', err);
    }
  });

  ipcMain.handle('asset:import-file', async (_ev, raw) => {
    try {
      const input = ImportFileInput.parse(raw);
      const asset = store.importSourceFile(input.filePath);
      return ok(asset);
    } catch (err) {
      return fail('ASSET_IMPORT_ERROR', err);
    }
  });

  ipcMain.handle('asset:import-synthetic-fixture', async (_ev, fixtureName: unknown) => {
    try {
      const name = z
        .enum(['sample_room_10000mm.dxf', 'sample_room_10m.dxf', 'sample_room_vector.pdf'])
        .parse(fixtureName);
      const fixtureCandidates = [
        path.resolve(appRootDir, 'tests/fixtures', name),
        path.resolve(__dirname, '../../../../tests/fixtures', name),
        path.resolve(process.cwd(), 'tests/fixtures', name),
      ];
      const found = fixtureCandidates.find((p) => fs.existsSync(p));
      if (!found) {
        throw new Error(`找不到内置合成测试小样：${name}`);
      }
      const asset = store.importSourceFile(found);
      return ok(asset);
    } catch (err) {
      return fail('FIXTURE_IMPORT_ERROR', err);
    }
  });

  ipcMain.handle('asset:read-project-file', async (_ev, relPath: unknown) => {
    try {
      const safeRel = z.string().min(1).parse(relPath);
      const absPath = store.resolveInsideProject(safeRel);
      if (!fs.existsSync(absPath)) {
        throw new Error(`项目内文件不存在：${safeRel}`);
      }
      const buf = fs.readFileSync(absPath);
      return ok({ base64: buf.toString('base64'), byteSize: buf.byteLength });
    } catch (err) {
      return fail('READ_PROJECT_FILE_ERROR', err);
    }
  });

  ipcMain.handle('task:run-node', async (_ev, nodeId: unknown) => {
    try {
      const id = z.string().min(1).parse(nodeId);
      const result = await runner.runNodeTask(id);
      return ok(result);
    } catch (err) {
      return fail('TASK_RUN_ERROR', err);
    }
  });

  ipcMain.handle('task:cancel', async (_ev, taskId: unknown) => {
    try {
      const id = z.string().min(1).parse(taskId);
      const cancelled = runner.cancelTask(id);
      return ok({ cancelled });
    } catch (err) {
      return fail('TASK_CANCEL_ERROR', err);
    }
  });

  ipcMain.handle('task:refresh-stale', async (_ev, rootNodeId: unknown) => {
    try {
      const id = z.string().min(1).parse(rootNodeId);
      const res = await runner.refreshStaleDownstream(id);
      return ok(res);
    } catch (err) {
      return fail('REFRESH_STALE_ERROR', err);
    }
  });

  ipcMain.handle('provider:list', async () => {
    return ok(credentials.listProviders());
  });

  ipcMain.handle('provider:save', async (_ev, raw: unknown) => {
    try {
      const input = z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          kind: z.enum(['openai_compat', 'mock_simulator']),
          baseUrl: z.string().min(1),
          modelId: z.string().min(1),
          apiKey: z.string().optional(),
        })
        .parse(raw);
      const saved = credentials.saveProvider(
        {
          id: input.id,
          label: input.label,
          kind: input.kind,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
        },
        input.apiKey
      );
      return ok(saved);
    } catch (err) {
      return fail('PROVIDER_SAVE_ERROR', err);
    }
  });

  ipcMain.handle('provider:test', async (_ev, providerId: unknown) => {
    try {
      const id = z.string().min(1).parse(providerId);
      const cfg = credentials.getProvider(id);
      if (!cfg) throw new Error(`找不到服务配置：${id}`);
      const adapter = runner.getAdapter(cfg.kind);
      const apiKey = credentials.getApiKey(cfg.credentialId);
      const report = await adapter.validateConfig(cfg, apiKey);
      return ok(report);
    } catch (err) {
      return fail('PROVIDER_TEST_ERROR', err);
    }
  });

  ipcMain.handle('env:probe', async (_ev, rawOverrides?: unknown) => {
    try {
      const manifestOverrides = store.getManifest()?.toolOverrides ?? {};
      const overrides: ToolPathOverrides =
        rawOverrides && typeof rawOverrides === 'object'
          ? { ...manifestOverrides, ...(rawOverrides as ToolPathOverrides) }
          : manifestOverrides;
      const report = await probeEnvironment(appRootDir, overrides);
      report.aiProvidersConfigured = credentials.hasAnyRealProviderConfigured();
      return ok(report);
    } catch (err) {
      return fail('ENV_PROBE_ERROR', err);
    }
  });

  ipcMain.handle('dialog:select-directory', async (_ev, title?: unknown) => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: typeof title === 'string' ? title : '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (res.canceled || res.filePaths.length === 0) {
      return ok<string | null>(null);
    }
    return ok<string | null>(res.filePaths[0] ?? null);
  });

  ipcMain.handle('dialog:select-source-file', async () => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: '选择要导入的图纸、图片或模型文件',
      properties: ['openFile'],
      filters: [
        {
          name: '建筑图纸与素材',
          extensions: ['dxf', 'dwg', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'blend', 'glb', 'fbx'],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (res.canceled || res.filePaths.length === 0) {
      return ok<string | null>(null);
    }
    return ok<string | null>(res.filePaths[0] ?? null);
  });
}
