'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { jsonObjectSchema, type HumanTask, type JsonObject } from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ErrorNotice, FormField } from '@/components/ui/form-field';
import { JsonEditor } from '@/components/ui/json-editor';

export function HumanTaskCard({ task, readOnly }: { task: HumanTask; readOnly: boolean }) {
  const client = useQueryClient();
  const [feedback, setFeedback] = useState('');
  const [editedValues, setEditedValues] = useState<JsonObject | undefined>();
  const [inputPending, setInputPending] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const respond = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api.respond(task.id, { decision, feedback, values: editedValues, idempotencyKey: key }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks(task.runId) }),
        client.invalidateQueries({ queryKey: queryKeys.run(task.runId) }),
        client.invalidateQueries({ queryKey: queryKeys.events(task.runId) }),
      ]);
    },
  });
  return (
    <div className="run-review">
      <h4>等待人工确认 · {task.nodeId}</h4>
      <details>
        <summary style={{ fontSize: 10, color: '#b8ac80' }}>查看待审核数据</summary>
        <pre
          className="code-input"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#a7ab87' }}
        >
          {JSON.stringify(task.input, null, 2)}
        </pre>
      </details>
      <FormField label="审核反馈">
        <input
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          maxLength={10000}
          disabled={readOnly || respond.isPending}
          placeholder="可选：记录你的判断与修改要求"
        />
      </FormField>
      <details>
        <summary className="field-hint">编辑批准后传递的数据（可选）</summary>
        <JsonEditor
          label="传递数据"
          value={editedValues ?? task.input}
          onChange={(value) => setEditedValues(jsonObjectSchema.parse(value))}
          onDirtyChange={setInputPending}
          disabled={readOnly || respond.isPending}
        />
      </details>
      {respond.error && <ErrorNotice error={respond.error} />}
      <div className="actions">
        <Button
          size="sm"
          disabled={readOnly || respond.isPending || inputPending}
          onClick={() => {
            if (!inputPending) respond.mutate('approve');
          }}
        >
          {respond.isPending ? <Loader2 className="animate-spin" /> : <Check />}批准并继续
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || respond.isPending || inputPending}
          onClick={() => respond.mutate('reject')}
        >
          <X />
          拒绝
        </Button>
      </div>
    </div>
  );
}
