'use client';

import type { StaticInputBinding } from '@dramaflow/contracts';
import { CandidateInputSummary } from '../candidate-input-summary';
import { EditableTemplateInput } from './editor/editable-template-input';
import type { TemplateInputProps } from './editor/types';
import styles from './editor/template-input-editor.module.css';

function readOnlyReason(binding: StaticInputBinding | undefined, connected: boolean) {
  if (connected) return '该输入由连线提供';
  if (binding?.type === 'workflow_input') return '该输入来自工作流输入';
  if (binding?.type === 'asset') return '该输入来自资产';
  if (
    binding?.type === 'template' &&
    Object.values(binding.variables).some((source) => source.type !== 'node_output')
  )
    return '该模板包含当前不能编辑的变量';
  return null;
}

export function TemplateInputEditor({
  portName,
  rows = 4,
  binding,
  connected,
  outputs,
  definition,
  manifests,
  disabled,
  onChange,
}: Omit<TemplateInputProps, 'rows'> & { rows?: number; connected: boolean }) {
  if (binding?.type === 'candidate') {
    return (
      <CandidateInputSummary
        portName={portName}
        binding={binding}
        definition={definition}
        manifests={manifests}
      />
    );
  }

  const reason = readOnlyReason(binding, connected);
  if (reason) {
    return (
      <div className={`nodrag nopan nowheel ${styles.editor}`}>
        <span className={styles.label}>{portName}</span>
        <p className={styles.locked} role="status">
          {reason}
        </p>
      </div>
    );
  }

  return (
    <EditableTemplateInput
      portName={portName}
      rows={rows}
      binding={binding}
      outputs={outputs}
      definition={definition}
      manifests={manifests}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
