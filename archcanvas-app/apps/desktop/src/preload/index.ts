import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CanvasGraph,
  EnvironmentProbeReport,
  IpcResult,
  ProjectManifest,
  SourceAsset,
  TaskRecord,
} from '@archcanvas/contracts';
import type { ConnectionReport, ProviderConfig } from '@archcanvas/providers';
import type { OpenedProjectSnapshot } from '../main/projectStore.js';

export interface ArchCanvasApi {
  createProject(input: {
    projectDir: string;
    name: string;
    projectType?: 'building' | 'interior' | 'campus';
  }): Promise<IpcResult<OpenedProjectSnapshot>>;
  openProject(input: { projectDir: string }): Promise<IpcResult<OpenedProjectSnapshot>>;
  getProjectSnapshot(): Promise<IpcResult<OpenedProjectSnapshot>>;
  saveCanvasGraph(graph: CanvasGraph): Promise<IpcResult<CanvasGraph>>;
  updateSettings(input: {
    exportDirectory?: string;
    toolOverrides?: ProjectManifest['toolOverrides'];
  }): Promise<IpcResult<ProjectManifest>>;
  importSourceFile(filePath: string): Promise<IpcResult<SourceAsset>>;
  importSyntheticFixture(
    fixtureName: 'sample_room_10000mm.dxf' | 'sample_room_10m.dxf' | 'sample_room_vector.pdf'
  ): Promise<IpcResult<SourceAsset>>;
  readProjectFile(relativePath: string): Promise<IpcResult<{ base64: string; byteSize: number }>>;
  runNodeTask(
    nodeId: string
  ): Promise<IpcResult<{ task: TaskRecord; updatedGraph: CanvasGraph }>>;
  cancelTask(taskId: string): Promise<IpcResult<{ cancelled: boolean }>>;
  refreshStaleDownstream(
    rootNodeId: string
  ): Promise<IpcResult<{ updatedGraph: CanvasGraph; refreshedNodeIds: string[] }>>;
  listProviders(): Promise<IpcResult<(ProviderConfig & { hasApiKey: boolean })[]>>;
  saveProvider(
    input: Omit<ProviderConfig, 'credentialId'> & { apiKey?: string }
  ): Promise<IpcResult<ProviderConfig & { hasApiKey: boolean }>>;
  testProvider(providerId: string): Promise<IpcResult<ConnectionReport>>;
  probeEnvironment(
    overrides?: ProjectManifest['toolOverrides']
  ): Promise<IpcResult<EnvironmentProbeReport>>;
  selectDirectory(title?: string): Promise<IpcResult<string | null>>;
  selectSourceFile(): Promise<IpcResult<string | null>>;
  getPathForFile(file: File): string;
  onTaskUpdated(callback: (task: TaskRecord) => void): () => void;
}

const api: ArchCanvasApi = {
  createProject: (input) => ipcRenderer.invoke('project:create', input),
  openProject: (input) => ipcRenderer.invoke('project:open', input),
  getProjectSnapshot: () => ipcRenderer.invoke('project:get-snapshot'),
  saveCanvasGraph: (graph) => ipcRenderer.invoke('project:save-graph', graph),
  updateSettings: (input) => ipcRenderer.invoke('project:update-settings', input),
  importSourceFile: (filePath) => ipcRenderer.invoke('asset:import-file', { filePath }),
  importSyntheticFixture: (fixtureName) =>
    ipcRenderer.invoke('asset:import-synthetic-fixture', fixtureName),
  readProjectFile: (relativePath) =>
    ipcRenderer.invoke('asset:read-project-file', relativePath),
  runNodeTask: (nodeId) => ipcRenderer.invoke('task:run-node', nodeId),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  refreshStaleDownstream: (rootNodeId) => ipcRenderer.invoke('task:refresh-stale', rootNodeId),
  listProviders: () => ipcRenderer.invoke('provider:list'),
  saveProvider: (input) => ipcRenderer.invoke('provider:save', input),
  testProvider: (providerId) => ipcRenderer.invoke('provider:test', providerId),
  probeEnvironment: (overrides) => ipcRenderer.invoke('env:probe', overrides),
  selectDirectory: (title) => ipcRenderer.invoke('dialog:select-directory', title),
  selectSourceFile: () => ipcRenderer.invoke('dialog:select-source-file'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onTaskUpdated: (callback) => {
    const listener = (_ev: Electron.IpcRendererEvent, task: TaskRecord) => callback(task);
    ipcRenderer.on('archcanvas:task-updated', listener);
    return () => ipcRenderer.removeListener('archcanvas:task-updated', listener);
  },
};

contextBridge.exposeInMainWorld('archcanvas', api);
