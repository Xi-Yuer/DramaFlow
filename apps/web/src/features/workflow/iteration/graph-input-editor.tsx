'use client';

import { useState, type ReactNode } from 'react';
import type { DataType, GraphInputDefinition } from '@dramaflow/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  formatDataType,
  graphInputTypeChoiceId,
  graphInputTypeChoices,
} from './iteration-body-inputs';
import styles from './graph-input-editor.module.css';

export function DataTypeSelect({
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: DataType;
  disabled: boolean;
  ariaLabel: string;
  onChange: (type: DataType) => void;
}) {
  const current = graphInputTypeChoiceId(value);
  return (
    <select
      className={styles.select}
      aria-label={ariaLabel}
      disabled={disabled}
      value={current ?? 'custom'}
      onChange={(event) => {
        const choice = graphInputTypeChoices.find((item) => item.id === event.target.value);
        if (choice) onChange(choice.type);
      }}
    >
      {current ? null : <option value="custom">{formatDataType(value)}</option>}
      {graphInputTypeChoices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

function GraphInputNameField({
  label,
  name,
  disabled,
  onCommit,
}: {
  label: string;
  name: string;
  disabled: boolean;
  onCommit: (name: string) => boolean;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <Input
      aria-label={`${label}名称 ${name}`}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next === name) {
          setDraft(name);
          return;
        }
        if (!onCommit(next)) setDraft(name);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

export function GraphInputEditor({
  label,
  inputs,
  disabled,
  empty,
  onAdd,
  onRemove,
  onRename,
  onType,
  onRequired,
  renderExtra,
}: {
  label: string;
  inputs: readonly GraphInputDefinition[];
  disabled: boolean;
  empty: string;
  onAdd: () => void;
  onRemove: (name: string) => void;
  onRename: (name: string, next: string) => boolean;
  onType: (name: string, type: DataType) => void;
  onRequired: (name: string, required: boolean) => void;
  renderExtra?: (input: GraphInputDefinition) => ReactNode;
}) {
  return (
    <div>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`添加 ${label}`}
          onClick={onAdd}
        >
          添加
        </Button>
      </div>
      {inputs.length === 0 ? <p className={styles.hint}>{empty}</p> : null}
      {inputs.map((input) => (
        <div key={input.name} className={styles.row}>
          <div className={styles.grid}>
            <GraphInputNameField
              key={input.name}
              label={label}
              name={input.name}
              disabled={disabled}
              onCommit={(next) => onRename(input.name, next)}
            />
            <DataTypeSelect
              value={input.type}
              disabled={disabled}
              ariaLabel={`${label}类型 ${input.name}`}
              onChange={(type) => onType(input.name, type)}
            />
          </div>
          <div className={styles.inline}>
            <label className={styles.check}>
              <input
                type="checkbox"
                aria-label={`必填 ${label} ${input.name}`}
                checked={input.required}
                disabled={disabled}
                onChange={(event) => onRequired(input.name, event.target.checked)}
              />
              必填
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`删除 ${label} ${input.name}`}
              onClick={() => onRemove(input.name)}
            >
              删除
            </Button>
          </div>
          {renderExtra?.(input)}
        </div>
      ))}
    </div>
  );
}
