import path from 'node:path';
import { app, BrowserWindow, safeStorage } from 'electron';
import { CredentialStore } from './credentialStore.js';
import { registerIpcHandlers } from './ipc.js';
import { ProjectStore } from './projectStore.js';
import { TaskRunner } from './taskRunner.js';

let mainWindow: BrowserWindow | null = null;
const store = new ProjectStore();

function resolveAppRootDir(): string {
  // dist/main/index.cjs -> apps/desktop -> archcanvas-app
  return path.resolve(__dirname, '../../../..');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: '构境画布 / ArchCanvas',
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.ARCHCANVAS_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const appRootDir = resolveAppRootDir();
  const credentials = new CredentialStore({
    userDataDir: app.getPath('userData'),
    safeStorage,
  });
  const runner = new TaskRunner(store, appRootDir, credentials);
  registerIpcHandlers({
    store,
    runner,
    credentials,
    appRootDir,
    getWindow: () => mainWindow,
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  store.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
