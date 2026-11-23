import type { CanvasEdge, CanvasGraph, CanvasNode, PortDataType } from '@archcanvas/contracts';
import { NODE_REGISTRY, PORT_TYPE_LABELS } from './registry.js';

export interface ConnectionValidationResult {
  valid: boolean;
  dataType?: PortDataType;
  reason?: string;
}

/**
 * 校验两个端口是否允许连线（端口存在性、类型匹配、防自环、防 DAG 环路、单输入端口冲突）
 */
export function validateConnection(
  graph: CanvasGraph,
  candidate: {
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  }
): ConnectionValidationResult {
  if (candidate.source === candidate.target) {
    return { valid: false, reason: '节点不能连接到自身。' };
  }

  const sourceNode = graph.nodes.find((n) => n.id === candidate.source);
  const targetNode = graph.nodes.find((n) => n.id === candidate.target);
  if (!sourceNode || !targetNode) {
    return { valid: false, reason: '源节点或目标节点不存在。' };
  }

  const sourceDef = NODE_REGISTRY[sourceNode.kind];
  const targetDef = NODE_REGISTRY[targetNode.kind];

  const sourcePort = sourceDef.outputs.find((p) => p.id === candidate.sourceHandle);
  const targetPort = targetDef.inputs.find((p) => p.id === candidate.targetHandle);

  if (!sourcePort) {
    return { valid: false, reason: `节点「${sourceNode.title}」不存在输出端口 ${candidate.sourceHandle}。` };
  }
  if (!targetPort) {
    return { valid: false, reason: `节点「${targetNode.title}」不存在输入端口 ${candidate.targetHandle}。` };
  }

  if (sourcePort.dataType !== targetPort.dataType) {
    return {
      valid: false,
      reason: `端口类型不兼容：输出为「${PORT_TYPE_LABELS[sourcePort.dataType]}」，但目标端口需要「${PORT_TYPE_LABELS[targetPort.dataType]}」。`,
    };
  }

  const duplicate = graph.edges.some(
    (e) =>
      e.source === candidate.source &&
      e.sourceHandle === candidate.sourceHandle &&
      e.target === candidate.target &&
      e.targetHandle === candidate.targetHandle
  );
  if (duplicate) {
    return { valid: false, reason: '该连接已存在。' };
  }

  if (!targetPort.multiple) {
    const occupied = graph.edges.some(
      (e) => e.target === candidate.target && e.targetHandle === candidate.targetHandle
    );
    if (occupied) {
      return { valid: false, reason: `端口「${targetPort.label}」只允许一个输入连接，请先断开原有连线。` };
    }
  }

  // 检查是否会形成环路：如果从 target 出发能到达 source，则添加 source -> target 会成环
  if (isReachable(graph.edges, candidate.target, candidate.source)) {
    return { valid: false, reason: '该连接会形成循环依赖（DAG 环路），已被阻止。' };
  }

  return { valid: true, dataType: sourcePort.dataType };
}

function isReachable(edges: CanvasEdge[], startId: string, goalId: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === goalId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }
  return false;
}

/**
 * 当某个节点参数或输入变化时，将其自身及所有下游节点标记为 stale
 */
export function markDownstreamStale(graph: CanvasGraph, changedNodeId: string): CanvasGraph {
  const affected = new Set<string>([changedNodeId]);
  const queue: string[] = [changedNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.source === current && !affected.has(edge.target)) {
        affected.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  const nextNodes: CanvasNode[] = graph.nodes.map((node) => {
    if (!affected.has(node.id)) return node;
    if (node.status === 'unconfigured') return node;
    return { ...node, status: 'stale' };
  });

  return {
    ...graph,
    nodes: nextNodes,
  };
}
