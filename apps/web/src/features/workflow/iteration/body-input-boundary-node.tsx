'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { formatDataType } from './iteration-body-inputs';
import type { WorkflowBodyInputNode } from './body-input-boundary';
import endStyles from '../outputs/workflow-end.module.css';
import styles from './body-input-boundary.module.css';

export function WorkflowBodyInputs({
  data,
  selected,
  isConnectable,
}: NodeProps<WorkflowBodyInputNode>) {
  return (
    <section
      className={`${endStyles.end} ${selected ? endStyles.selected : ''}`}
      aria-label="Body 输入边界"
    >
      <header>
        <strong>Body 输入</strong>
        <span>局部图输入</span>
      </header>
      {data.inputs.length === 0 ? (
        <p className={endStyles.hint}>在 Iteration 检查器中添加 Body 输入。</p>
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
    </section>
  );
}
