'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { jsonObjectSchema, type JsonObject, type WorkflowRun } from '@dramaflow/contracts';
import { api } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { JsonEditor } from '@/components/ui/json-editor';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/form-field';

export function RunInputDialog({
  workflowId,
  versionId,
  onClose,
  onStarted,
}: {
  workflowId: string;
  versionId: string;
  onClose: () => void;
  onStarted: (run: WorkflowRun) => void;
}) {
  const [input, setInput] = useState<JsonObject>({});
  const [inputPending, setInputPending] = useState(false);
  const start = useMutation({
    mutationFn: () => api.startRun(workflowId, input, versionId),
    onSuccess: onStarted,
  });
  return (
    <Dialog
      title="运行已发布版本"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => start.mutate()} disabled={start.isPending || inputPending}>
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}开始运行
          </Button>
        </>
      }
    >
      <p className="muted text-xs leading-relaxed" style={{ marginBottom: 20 }}>
        运行会固定当前发布版本。草稿中的修改不会影响本次执行；人工确认节点会暂停等待你的决定。
      </p>
      <JsonEditor
        label="本次运行输入"
        value={input}
        onChange={(value) => setInput(jsonObjectSchema.parse(value))}
        onDirtyChange={setInputPending}
        hint="使用输入绑定中的路径读取字段。点击「应用 JSON」后再开始运行。"
      />
      {start.error && <ErrorNotice error={start.error} />}
    </Dialog>
  );
}
