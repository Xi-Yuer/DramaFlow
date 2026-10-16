'use client';

import { useState } from 'react';
import { Button } from './button';
import { FormField } from './form-field';

export function JsonEditor({
  label,
  value,
  onChange,
  hint,
  disabled = false,
  onDirtyChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  hint?: string;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function apply() {
    try {
      const parsed: unknown = JSON.parse(draft ?? serialized);
      onChange(parsed);
      setDraft(null);
      setError(null);
      onDirtyChange?.(false);
    } catch {
      setError('JSON 格式有误，请检查引号、逗号和括号。');
    }
  }
  return (
    <div className="json-editor">
      <FormField label={label} hint={hint}>
        <textarea
          className="code-input"
          value={draft ?? serialized}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            onDirtyChange?.(true);
          }}
          rows={7}
          disabled={disabled}
          spellCheck={false}
        />
      </FormField>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {draft !== null && (
        <Button type="button" size="sm" variant="outline" onClick={apply} disabled={disabled}>
          应用 JSON
        </Button>
      )}
    </div>
  );
}
