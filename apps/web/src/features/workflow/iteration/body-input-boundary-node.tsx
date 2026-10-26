'use client';

import { useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Button } from 'antd';
import { formatDataType } from '../inputs/definitions/graph-input-types';
import type { WorkflowBodyInputNode } from './body-input-boundary';
import endStyles from '../outputs/workflow-end.module.css';
import styles from './body-input-boundary.module.css';

export function WorkflowBodyInputs({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<WorkflowBodyInputNode>) {
  const atRoot = data.scope === 'root';
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.inputs, updateNodeInternals]);
  return (
    <section
      className={`${endStyles.end} ${selected ? endStyles.selected : ''}`}
      aria-label={atRoot ? '工作流输入边界' : 'Body 输入边界'}
    >
      <header>
        <strong>{atRoot ? '工作流输入' : 'Body 输入'}</strong>
        <span>{atRoot ? '根图输入' : '局部图输入'}</span>
      </header>
      {data.inputs.length === 0 ? (
        <p className={endStyles.hint}>
          {atRoot ? '添加输入后，可拖线连接节点端口。' : '在 Iteration 检查器中添加 Body 输入。'}
        </p>
      ) : (
        <ul className={`${styles.list} nodrag nowheel`}>
          {data.inputs.map((input) => (
            <li key={input.name} className={styles.row}>
              <div>
                <strong>{input.name}</strong>
                <span>
                  {formatDataType(input.type)}
                  {input.required ? '' : ' · 可选'}
                </span>
              </div>
              <Handle
                type="source"
                id={input.name}
                position={Position.Right}
                isConnectable={isConnectable}
                aria-label={`输出：${input.name}`}
              />
            </li>
          ))}
        </ul>
      )}
      {atRoot ? (
        <Button className="nodrag" size="small" disabled={data.disabled} onClick={data.onConfigure}>
          编辑工作流输入
        </Button>
      ) : null}
    </section>
  );
}
