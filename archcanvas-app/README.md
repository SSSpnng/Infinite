# 构境画布 / ArchCanvas (`archcanvas-app`)

面向建筑与室内设计的本地优先无限画布桌面应用（Windows 优先，中文界面）。

## 目录结构

- `packages/contracts/` — Zod 数据契约与跨进程/工作进程协议
- `packages/canvas/` — 节点注册表、端口类型校验、DAG 环路检测与 `stale` 状态传播
- `apps/desktop/` — Electron 主进程（SQLite 单写入者、项目目录管理、环境探测、任务队列、IPC）+ React + `@xyflow/react` 桌面界面
- `workers/geometry/` — Python 3.12（`uv` 独立 `.venv`）几何与图纸工作进程（`ezdxf`、`shapely`、`pdfplumber`）
- `tests/fixtures/` — 合成已知尺寸 DXF 测试小样（`sample_room_10000mm.dxf`、`sample_room_10m.dxf`）

## 运行与开发

```powershell
# 1. 安装 Node 依赖
npm.cmd install

# 2. 安装 Python 几何工作环境依赖
uv sync --project workers/geometry

# 3. 构建全部包（contracts / canvas / desktop）
npm.cmd run build

# 4. 运行自动化测试（含 G0 持久化、Python 工作进程、环境探测）
npm.cmd run test

# 5. 启动桌面程序
npm.cmd run start
```

## 当前关卡进度

- **G0（已完成）**：桌面壳、项目目录与 SQLite 原子持久化、无限画布节点/连线与端口类型校验、文件拖放归档、真实 Python 工作进程任务队列、本机环境动态探测（不写死路径）、导出目录与交付清单、合成 DXF 小样。
- **G1（已完成并经 Blender 5.2.3 实测通过）**：DXF（含块展开与 OCS/WCS）/ 向量 PDF（`pdfplumber`）/ DWG 转换器（`CadConverter` 适配 AutoCAD Core Console 与 ODA）→ 比例校准与墙洞识别 → Blender 5.2.3 参数化单层白模（`.blend` + `.glb` + 流形/法线/体积/包围盒实测）→ Three.js 3D 视口（建筑 Z-up 相机对齐、揭顶显示、多视角保存）→ Blender 原生 PNG 渲染与导出交付。
- **G2（已完成并经 Blender 5.2.3 + Pillow 实测通过）**：参考图显式角色与优先级、材质槽独立修订（改材质不改几何）、结构化提示词编译、OpenAI 兼容适配器与明确标注的内置测试模拟器（主进程 `safeStorage` 凭据隔离）、几何修改跨视角版本传播与批量刷新、诚实分辨率/格式图片导出（PNG/JPEG/WebP）及真实 FBX/GLB/OBJ+MTL 模型导出（不伪造 SKP/MAX）。
- **G3（已完成并经 Blender 5.2.3 实测通过）**：平立剖开口冲突核对（不悄悄补窗）、真实双坡屋顶/入口台阶/连续接地坡道/分边侧扶手/独立散水/落地银灰格栅、多栋楼场地组合与 L 型内院包裹约束（正交+鸟瞰一致）、局部修改明确区分几何修订与仅图片修饰（未同步模型）、适配 Blender 5.x 的独立 COLLADA 1.4.1 (`.dae`) SketchUp 兼容导出器。
- **G4（已完成并经 Blender 5.2.3 实测通过）**：模型相机路径关键帧插值与防穿模检查、逐帧断点恢复渲染（复用已校验帧）、Blender 内置 H.264 MP4 视频编码与可选外部 FFmpeg 适配层、异步生成式视频适配器（独立标识来源与跨帧复核状态）、项目跨目录中文空格迁移验证、本机依赖诊断 CLI（`npm.cmd run diagnose`）与 Windows 便携包及可重复构建清单（`npm.cmd run package:portable`）。
