import type { ReferenceRole } from '@archcanvas/contracts';
import type { ProviderCapabilities, ReferenceInputItem } from './types.js';

export const REFERENCE_ROLE_LABELS: Record<ReferenceRole, string> = {
  camera: '仅视角/构图参考（禁止复制旧立面与旧构件）',
  material: '仅材质/颜色参考（不改变建筑形体与开口）',
  lighting_style: '仅光影/天气风格参考（保持当前建筑几何）',
  landscape_layout: '仅景观布局参考（不移动已锁建筑）',
  edit_target: '局部编辑底图（仅作用于选定掩膜范围）',
  geometry_evidence: '几何证据（图纸或已批准模型）',
};

export interface PromptCompileInput {
  mode: 'model_constrained' | 'concept_exploration';
  modelVersionId: string;
  cameraName: string;
  keepText: string;
  modifyText: string;
  negativeText: string;
  materialOverrides?: { slotName: string; baseColorHex: string }[];
  references: ReferenceInputItem[];
  requestedWidthPx: number;
  requestedHeightPx: number;
  capabilities: ProviderCapabilities;
}

export interface CompiledPromptResult {
  compiledPrompt: string;
  negativePrompt: string;
  capabilityWarnings: string[];
  activeReferences: ReferenceInputItem[];
}

/**
 * 结构化提示词编译器（总规格 §4.4 & §8.3）：
 * 优先级：用户本次明确修改 > 当前批准模型版本 > 相机快照 > 指定角色参考图 > 风格提示词。
 */
export function compileArchitecturalPrompt(input: PromptCompileInput): CompiledPromptResult {
  const activeRefs = input.references.filter((r) => r.enabled);
  const warnings: string[] = [];

  if (input.mode === 'model_constrained' && input.capabilities.conditioning.length === 0) {
    warnings.push(
      '当前图像接口不支持深度/法线/边线等几何条件通道，仅使用 RGB 底图约束；生成后必须人工复核轮廓、层数与门窗数量。'
    );
  }
  if (input.negativeText.trim() && !input.capabilities.negativePrompt) {
    warnings.push('当前模型不支持独立负向提示词字段，已将限制项并入主提示词限制段。');
  }

  const lines: string[] = [];
  if (input.mode === 'model_constrained') {
    lines.push('任务：严格依据当前建筑模型底图制作建筑可视化效果图。');
  } else {
    lines.push('任务：概念效果探索（允许风格化表现，但仍参考当前模型构图）。');
  }

  lines.push(`几何依据：模型版本 ${input.modelVersionId}；相机视角「${input.cameraName}」；底图为唯一几何与相机依据。`);

  const keep = input.keepText.trim() || '建筑外轮廓、层数、门窗开口数量与位置、屋顶坡度与尺寸、台阶与坡道关系';
  lines.push(`保持：${keep}。`);

  if (input.materialOverrides && input.materialOverrides.length > 0) {
    const mats = input.materialOverrides
      .map((m) => `${m.slotName}=${m.baseColorHex}`)
      .join('；');
    lines.push(`指定材质槽：${mats}（仅改变指定材料槽外观，不得增减门窗或改变形体）。`);
  }

  if (input.modifyText.trim()) {
    lines.push(`用户本次明确修改：${input.modifyText.trim()}。`);
  }

  for (const ref of activeRefs) {
    const roleDesc = REFERENCE_ROLE_LABELS[ref.role];
    lines.push(`参考图「${ref.label}」[角色=${ref.role}，权重=${ref.weight}]：${roleDesc}。`);
    if (ref.role === 'camera') {
      lines.push(
        `强约束：参考图「${ref.label}」仅用于视角/构图参考，严禁恢复其旧楼梯、旧立面材质或额外门窗。`
      );
    }
  }

  lines.push(`输出目标：${input.requestedWidthPx}×${input.requestedHeightPx} 像素。`);

  const defaultNeg = '不得新增或删除门窗、不得恢复已删除的旧楼梯、不得缩小或弱化坡屋顶、不得使格栅或构件悬空';
  const combinedNeg = input.negativeText.trim()
    ? `${defaultNeg}；${input.negativeText.trim()}`
    : defaultNeg;

  if (!input.capabilities.negativePrompt) {
    lines.push(`限制：${combinedNeg}。`);
  }

  return {
    compiledPrompt: lines.join('\n'),
    negativePrompt: combinedNeg,
    capabilityWarnings: warnings,
    activeReferences: activeRefs,
  };
}
