import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  CanvasGraphSchema,
  ProjectManifestSchema,
  SCHEMA_VERSION,
  SourceAssetSchema,
  TaskRecordSchema,
  type CanvasGraph,
  type ProjectManifest,
  type SourceAsset,
  type SourceAssetKind,
  type TaskRecord,
} from '@archcanvas/contracts';

const PROJECT_SUBDIRS = [
  'sources',
  'drawings',
  'models',
  'scenes',
  'cameras',
  'renders',
  'images',
  'videos',
  'exports',
  'work',
] as const;

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => {
        const candidates = [
          path.join(__dirname, file),
          path.resolve(__dirname, '../../node_modules/sql.js/dist', file),
          path.resolve(__dirname, '../../../../node_modules/sql.js/dist', file),
          path.resolve(process.cwd(), 'node_modules/sql.js/dist', file),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
        return file;
      },
    });
  }
  return sqlJsPromise;
}

export function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

export function inferAssetKind(filePath: string): SourceAssetKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.dwg') return 'dwg';
  if (ext === '.dxf') return 'dxf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext)) {
    return 'image';
  }
  if (['.blend', '.glb', '.gltf', '.fbx', '.obj', '.dae', '.skp'].includes(ext)) {
    return 'model';
  }
  throw new Error(`不支持的文件格式：${ext || '(无扩展名)'}。支持 PDF/DWG/DXF/图片/3D 模型。`);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function writeFileAtomic(targetPath: string, content: Buffer | string): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, targetPath);
}

export interface OpenedProjectSnapshot {
  projectDir: string;
  manifest: ProjectManifest;
  graph: CanvasGraph;
  assets: SourceAsset[];
  tasks: TaskRecord[];
}

export class ProjectStore {
  private projectDir: string | null = null;
  private manifest: ProjectManifest | null = null;
  private db: Database | null = null;

  public getProjectDir(): string | null {
    return this.projectDir;
  }

  public getManifest(): ProjectManifest | null {
    return this.manifest;
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.projectDir = null;
    this.manifest = null;
  }

  public resolveInsideProject(relativePath: string): string {
    if (!this.projectDir) {
      throw new Error('当前未打开任何项目。');
    }
    const resolved = path.resolve(this.projectDir, relativePath);
    const rootNormalized = path.resolve(this.projectDir) + path.sep;
    if (resolved !== path.resolve(this.projectDir) && !resolved.startsWith(rootNormalized)) {
      throw new Error(`非法路径访问：${relativePath} 超出项目目录范围。`);
    }
    return resolved;
  }

  private ensureSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS project_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_assets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        import_settings_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        graph_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        node_id TEXT,
        operation TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT,
        completed INTEGER,
        total INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        input_snapshot_json TEXT NOT NULL,
        output_path TEXT,
        output_summary_json TEXT,
        error_code TEXT,
        error_message TEXT
      );
    `);
  }

  private flush(): void {
    if (!this.projectDir || !this.manifest || !this.db) {
      throw new Error('项目尚未初始化，无法持久化。');
    }
    this.manifest.updatedAt = new Date().toISOString();
    const dbBytes = Buffer.from(this.db.export());
    writeFileAtomic(path.join(this.projectDir, 'project.sqlite'), dbBytes);
    writeFileAtomic(
      path.join(this.projectDir, 'project.json'),
      JSON.stringify(this.manifest, null, 2)
    );
  }

  public async createProject(
    projectDir: string,
    name: string,
    projectType: 'building' | 'interior' | 'campus' = 'building'
  ): Promise<OpenedProjectSnapshot> {
    const absDir = path.resolve(projectDir);
    if (!name.trim()) {
      throw new Error('项目名称不能为空。');
    }

    fs.mkdirSync(absDir, { recursive: true });
    for (const sub of PROJECT_SUBDIRS) {
      fs.mkdirSync(path.join(absDir, sub), { recursive: true });
    }

    const SQL = await getSqlJs();
    this.close();

    const now = new Date().toISOString();
    const manifest: ProjectManifest = ProjectManifestSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      projectId: `proj-${crypto.randomUUID().slice(0, 8)}`,
      name: name.trim(),
      projectType,
      createdAt: now,
      updatedAt: now,
      exportDirectory: path.join(absDir, 'exports'),
      toolOverrides: {},
    });

    const db = new SQL.Database();
    this.ensureSchema(db);

    const initialGraph: CanvasGraph = CanvasGraphSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    db.run(
      'INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)',
      ['manifest', JSON.stringify(manifest)]
    );
    db.run(
      'INSERT OR REPLACE INTO canvas_state (id, graph_json, updated_at) VALUES (1, ?, ?)',
      [JSON.stringify(initialGraph), now]
    );

    this.projectDir = absDir;
    this.manifest = manifest;
    this.db = db;
    this.flush();

    return this.getSnapshot();
  }

  public async openProject(projectDir: string): Promise<OpenedProjectSnapshot> {
    const absDir = path.resolve(projectDir);
    const manifestPath = path.join(absDir, 'project.json');
    const sqlitePath = path.join(absDir, 'project.sqlite');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`所选目录不是有效的构境画布项目（缺少 project.json）：${absDir}`);
    }
    if (!fs.existsSync(sqlitePath)) {
      throw new Error(`项目数据库缺失（缺少 project.sqlite）：${absDir}`);
    }

    const manifestRaw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = ProjectManifestSchema.parse(manifestRaw);

    const SQL = await getSqlJs();
    this.close();

    const fileBytes = fs.readFileSync(sqlitePath);
    const db = new SQL.Database(new Uint8Array(fileBytes));
    this.ensureSchema(db);

    for (const sub of PROJECT_SUBDIRS) {
      fs.mkdirSync(path.join(absDir, sub), { recursive: true });
    }

    this.projectDir = absDir;
    this.manifest = manifest;
    this.db = db;

    return this.getSnapshot();
  }

  public getSnapshot(): OpenedProjectSnapshot {
    if (!this.projectDir || !this.manifest || !this.db) {
      throw new Error('当前未打开任何项目。');
    }

    // Load canvas graph
    const graphStmt = this.db.prepare('SELECT graph_json FROM canvas_state WHERE id = 1');
    let graph: CanvasGraph = {
      schemaVersion: SCHEMA_VERSION,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    if (graphStmt.step()) {
      const row = graphStmt.getAsObject() as { graph_json: string };
      graph = CanvasGraphSchema.parse(JSON.parse(row.graph_json));
    }
    graphStmt.free();

    // Load assets
    const assets: SourceAsset[] = [];
    const assetStmt = this.db.prepare(
      'SELECT id, kind, original_name, relative_path, sha256, byte_size, imported_at, import_settings_json FROM source_assets ORDER BY imported_at DESC'
    );
    while (assetStmt.step()) {
      const r = assetStmt.getAsObject() as Record<string, unknown>;
      assets.push(
        SourceAssetSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id: r.id,
          kind: r.kind,
          originalName: r.original_name,
          relativePath: r.relative_path,
          sha256: r.sha256,
          byteSize: Number(r.byte_size),
          importedAt: r.imported_at,
          importSettings: JSON.parse(String(r.import_settings_json || '{}')),
        })
      );
    }
    assetStmt.free();

    // Load tasks
    const tasks: TaskRecord[] = [];
    const taskStmt = this.db.prepare(
      'SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100'
    );
    while (taskStmt.step()) {
      const r = taskStmt.getAsObject() as Record<string, unknown>;
      tasks.push(
        TaskRecordSchema.parse({
          id: r.id,
          projectId: r.project_id,
          nodeId: r.node_id ?? undefined,
          operation: r.operation,
          title: r.title,
          status: r.status,
          stage: r.stage ?? undefined,
          completed: r.completed != null ? Number(r.completed) : undefined,
          total: r.total != null ? Number(r.total) : undefined,
          createdAt: r.created_at,
          startedAt: r.started_at ?? undefined,
          finishedAt: r.finished_at ?? undefined,
          inputSnapshot: JSON.parse(String(r.input_snapshot_json || '{}')),
          outputPath: r.output_path ?? undefined,
          outputSummary: r.output_summary_json
            ? JSON.parse(String(r.output_summary_json))
            : undefined,
          errorCode: r.error_code ?? undefined,
          errorMessage: r.error_message ?? undefined,
        })
      );
    }
    taskStmt.free();

    return {
      projectDir: this.projectDir,
      manifest: this.manifest,
      graph,
      assets,
      tasks,
    };
  }

  public saveCanvasGraph(graphInput: CanvasGraph): CanvasGraph {
    if (!this.db) {
      throw new Error('当前未打开任何项目。');
    }
    const graph = CanvasGraphSchema.parse(graphInput);
    const now = new Date().toISOString();
    this.db.run(
      'INSERT OR REPLACE INTO canvas_state (id, graph_json, updated_at) VALUES (1, ?, ?)',
      [JSON.stringify(graph), now]
    );
    this.flush();
    return graph;
  }

  public updateManifest(patch: Partial<Pick<ProjectManifest, 'name' | 'exportDirectory' | 'toolOverrides'>>): ProjectManifest {
    if (!this.manifest || !this.db) {
      throw new Error('当前未打开任何项目。');
    }
    this.manifest = ProjectManifestSchema.parse({
      ...this.manifest,
      ...patch,
      toolOverrides: {
        ...this.manifest.toolOverrides,
        ...(patch.toolOverrides ?? {}),
      },
      updatedAt: new Date().toISOString(),
    });
    this.db.run(
      'INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)',
      ['manifest', JSON.stringify(this.manifest)]
    );
    this.flush();
    return this.manifest;
  }

  public importSourceFile(sourceFilePath: string): SourceAsset {
    if (!this.projectDir || !this.db) {
      throw new Error('请先新建或打开项目后再导入素材。');
    }
    const absSource = path.resolve(sourceFilePath);
    if (!fs.existsSync(absSource)) {
      throw new Error(`源文件不存在：${absSource}`);
    }
    const stat = fs.statSync(absSource);
    if (!stat.isFile()) {
      throw new Error(`导入目标不是有效文件：${absSource}`);
    }

    const kind = inferAssetKind(absSource);
    const sha256 = computeFileSha256(absSource);
    const originalName = path.basename(absSource);
    const safeName = sanitizeFileName(originalName);
    const archivedFileName = `${sha256.slice(0, 12)}_${safeName}`;
    const relativePath = path.posix.join('sources', archivedFileName);
    const destPath = this.resolveInsideProject(relativePath);

    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(absSource, destPath);
    }

    const asset = SourceAssetSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: `asset-${crypto.randomUUID().slice(0, 8)}`,
      kind,
      originalName,
      relativePath,
      sha256,
      byteSize: stat.size,
      importedAt: new Date().toISOString(),
      importSettings: {},
    });

    this.db.run(
      `INSERT INTO source_assets
        (id, kind, original_name, relative_path, sha256, byte_size, imported_at, import_settings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        asset.id,
        asset.kind,
        asset.originalName,
        asset.relativePath,
        asset.sha256,
        asset.byteSize,
        asset.importedAt,
        JSON.stringify(asset.importSettings),
      ]
    );
    this.flush();
    return asset;
  }

  public getAssetById(assetId: string): SourceAsset | null {
    if (!this.db) return null;
    const stmt = this.db.prepare(
      'SELECT id, kind, original_name, relative_path, sha256, byte_size, imported_at, import_settings_json FROM source_assets WHERE id = ?'
    );
    stmt.bind([assetId]);
    let found: SourceAsset | null = null;
    if (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      found = SourceAssetSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: r.id,
        kind: r.kind,
        originalName: r.original_name,
        relativePath: r.relative_path,
        sha256: r.sha256,
        byteSize: Number(r.byte_size),
        importedAt: r.imported_at,
        importSettings: JSON.parse(String(r.import_settings_json || '{}')),
      });
    }
    stmt.free();
    return found;
  }

  public upsertTask(taskInput: TaskRecord): TaskRecord {
    if (!this.db) {
      throw new Error('当前未打开任何项目。');
    }
    const task = TaskRecordSchema.parse(taskInput);
    this.db.run(
      `INSERT OR REPLACE INTO tasks (
        id, project_id, node_id, operation, title, status, stage, completed, total,
        created_at, started_at, finished_at, input_snapshot_json, output_path,
        output_summary_json, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.projectId,
        task.nodeId ?? null,
        task.operation,
        task.title,
        task.status,
        task.stage ?? null,
        task.completed ?? null,
        task.total ?? null,
        task.createdAt,
        task.startedAt ?? null,
        task.finishedAt ?? null,
        JSON.stringify(task.inputSnapshot ?? {}),
        task.outputPath ?? null,
        task.outputSummary ? JSON.stringify(task.outputSummary) : null,
        task.errorCode ?? null,
        task.errorMessage ?? null,
      ]
    );
    this.flush();
    return task;
  }
}
