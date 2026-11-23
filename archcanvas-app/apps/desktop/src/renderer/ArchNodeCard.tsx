import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CanvasNode } from '@archcanvas/contracts';
import { getNodeDefinition } from '@archcanvas/canvas';

export interface ArchNodeFlowData extends Record<string, unknown> {
  node: CanvasNode;
  onRunNode: (nodeId: string) => void;
}

const STATUS_LABELS: Record<CanvasNode['status'], { text: string; cls: string }> = {
  idle: { text: '就绪', cls: 'badge' },
  ready: { text: '就绪', cls: 'badge' },
  stale: { text: '待更新', cls: 'badge badge-warn' },
  running: { text: '运行中', cls: 'badge badge-warn' },
  succeeded: { text: '已完成', cls: 'badge badge-ok' },
  failed: { text: '失败', cls: 'badge badge-err' },
  unconfigured: { text: '未配置服务', cls: 'badge badge-warn' },
};

export const ArchNodeCard: React.FC<NodeProps> = ({ data, selected }) => {
  const flowData = data as ArchNodeFlowData;
  const node = flowData.node;
  const def = getNodeDefinition(node.kind);
  const statusInfo = STATUS_LABELS[node.status] ?? STATUS_LABELS.idle;

  return (
    <div className={`arch-node ${selected ? 'selected' : ''}`}>
      <div className="arch-node-header">
        <span className="arch-node-title" title={node.title}>
          {node.title}
        </span>
        <span className={statusInfo.cls}>{statusInfo.text}</span>
      </div>

      <div className="arch-node-body">
        <div className="arch-node-ports">
          <div className="port-col">
            {def.inputs.map((inp) => (
              <div key={inp.id} className="port-row">
                <Handle
                  type="target"
                  position={Position.Left}
                  id={inp.id}
                  style={{ left: -15, width: 10, height: 10, background: '#60a5fa' }}
                />
                <span>{inp.label}</span>
              </div>
            ))}
          </div>
          <div className="port-col">
            {def.outputs.map((out) => (
              <div key={out.id} className="port-row right">
                <span>{out.label}</span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={out.id}
                  style={{ right: -15, width: 10, height: 10, background: '#34d399' }}
                />
              </div>
            ))}
          </div>
        </div>

        {node.outputArtifactPath && (
          <div style={{ color: '#93c5fd', marginTop: 4, wordBreak: 'break-all' }}>
            输出：{node.outputArtifactPath}
          </div>
        )}
        {node.lastError && (
          <div style={{ color: '#fca5a5', marginTop: 4 }}>{node.lastError}</div>
        )}
      </div>

      <div className="arch-node-footer">
        <span style={{ fontSize: 11, color: '#9aa7b8' }}>{def.label}</span>
        <button
          className="primary"
          disabled={node.status === 'running'}
          onClick={(e) => {
            e.stopPropagation();
            flowData.onRunNode(node.id);
          }}
        >
          {node.status === 'running' ? '执行中...' : '运行节点'}
        </button>
      </div>
    </div>
  );
};
