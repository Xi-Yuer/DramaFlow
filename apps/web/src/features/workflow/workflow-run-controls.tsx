import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import type { WorkflowVersionListResponse, WorkflowVersionResponse } from '@dramaflow/contracts';
import {
  buildWorkflowRunInputs,
  workflowInputEditor,
  type WorkflowInputFormValue,
  type WorkflowInputFormValues,
  type WorkflowRunState,
} from './workflow-run';
import { WorkflowRunStatusView } from './workflow-run-status-controls';
import type { WorkflowRunStatusState } from './workflow-run-status';
import styles from './workflow-run.module.css';

type PublishedVersion = WorkflowVersionListResponse['items'][number];

export function WorkflowRunControls({
  versions,
  selectedVersionId,
  version,
  versionsLoading,
  versionLoading,
  versionsError,
  versionError,
  draftDirty,
  values,
  state,
  runStatus,
  onSelectVersion,
  onChangeInput,
  onRun,
  onRetry,
  onRetryVersions,
  onRetryVersion,
  onRefreshRunStatus,
}: {
  versions: PublishedVersion[];
  selectedVersionId: string | null;
  version: WorkflowVersionResponse | null;
  versionsLoading: boolean;
  versionLoading: boolean;
  versionsError: boolean;
  versionError: boolean;
  draftDirty: boolean;
  values: WorkflowInputFormValues;
  state: WorkflowRunState;
  runStatus: WorkflowRunStatusState;
  onSelectVersion: (versionId: string) => void;
  onChangeInput: (name: string, value: WorkflowInputFormValue) => void;
  onRun: () => void;
  onRetry: () => void;
  onRetryVersions: () => void;
  onRetryVersion: () => void;
  onRefreshRunStatus: () => void;
}) {
  const submitting = state.phase === 'submitting';
  const build = version ? buildWorkflowRunInputs(version.definition.inputs, values) : null;
  const canRun =
    version !== null && !versionLoading && !versionError && build?.ok === true && !submitting;

  return (
    <section className={styles.panel} aria-label="工作流运行">
      <div className={styles.header}>
        <Space wrap>
          <Typography.Text strong>运行 Workflow</Typography.Text>
          <Select
            aria-label="选择已发布版本"
            size="small"
            loading={versionsLoading}
            disabled={versionsLoading || versionsError || versions.length === 0 || submitting}
            value={selectedVersionId ?? undefined}
            placeholder="选择已发布版本"
            className={styles.versionSelect}
            options={versions.map((item) => ({
              value: item.id,
              label: `v${item.version} · 修订 ${item.sourceRevision}`,
            }))}
            onChange={onSelectVersion}
          />
        </Space>
        {version ? (
          <Typography.Text className={styles.versionStatus}>
            运行已发布版本 v{version.version}（{version.id}），不是当前 Draft
          </Typography.Text>
        ) : null}
      </div>

      {draftDirty && version ? (
        <Alert
          showIcon
          type="warning"
          title="当前 Draft 有未保存或未发布修改"
          description={`本次仍运行已发布版本 v${version.version}，Draft 修改不会进入请求。`}
        />
      ) : null}

      {versionsError ? (
        <Alert
          showIcon
          type="error"
          title="已发布版本读取失败"
          action={
            <Button size="small" loading={versionsLoading} onClick={onRetryVersions}>
              重试
            </Button>
          }
        />
      ) : null}
      {!versionsLoading && !versionsError && versions.length === 0 ? (
        <Alert showIcon type="info" title="暂无已发布版本" description="请先发布，再发起运行。" />
      ) : null}
      {versionError ? (
        <Alert
          showIcon
          type="error"
          title="版本定义读取失败"
          description="无法安全生成 Workflow Inputs，已阻止运行。"
          action={
            <Button size="small" loading={versionLoading} onClick={onRetryVersion}>
              重试
            </Button>
          }
        />
      ) : null}

      {versionLoading ? (
        <Typography.Text className={styles.secondary}>正在读取版本定义…</Typography.Text>
      ) : null}

      {version && !versionLoading ? (
        version.definition.inputs.length === 0 ? (
          <Typography.Text className={styles.secondary}>
            此版本没有 Workflow Inputs，可直接运行。
          </Typography.Text>
        ) : (
          <Form layout="vertical" className={styles.form}>
            {version.definition.inputs.map((definition) => {
              const editor = workflowInputEditor(definition.type);
              const current = values[definition.name] ?? {
                provided: definition.required,
                explicitNull: false,
                value: undefined,
              };
              const enabled = definition.required || current.provided;
              const controlDisabled = submitting || !enabled || current.explicitNull;
              return (
                <div className={styles.field} key={definition.name}>
                  <div className={styles.fieldHeading}>
                    <Space size={6}>
                      <Typography.Text>{definition.name}</Typography.Text>
                      <Tag bordered={false}>{definition.required ? '必填' : '可选'}</Tag>
                      {editor.nullable ? <Tag bordered={false}>可为 null</Tag> : null}
                    </Space>
                    {!definition.required ? (
                      <Checkbox
                        checked={current.provided}
                        disabled={submitting}
                        onChange={(event) =>
                          onChangeInput(definition.name, {
                            ...current,
                            provided: event.target.checked,
                          })
                        }
                      >
                        提供此输入
                      </Checkbox>
                    ) : null}
                  </div>
                  {editor.kind === 'unsupported' ? (
                    <Alert
                      showIcon
                      type="warning"
                      title="不支持当前类型输入"
                      description="当前 Web 不会把此 DataType 转换为 string，也不提供引用选择器。"
                    />
                  ) : (
                    <>
                      {editor.kind === 'string' ? (
                        <Input
                          aria-label={`${definition.name} 输入`}
                          value={typeof current.value === 'string' ? current.value : ''}
                          disabled={controlDisabled}
                          onChange={(event) =>
                            onChangeInput(definition.name, {
                              ...current,
                              value: event.target.value,
                            })
                          }
                        />
                      ) : editor.kind === 'number' ? (
                        <InputNumber
                          aria-label={`${definition.name} 输入`}
                          value={typeof current.value === 'number' ? current.value : null}
                          disabled={controlDisabled}
                          onChange={(value) =>
                            onChangeInput(definition.name, {
                              ...current,
                              value: value ?? undefined,
                            })
                          }
                        />
                      ) : (
                        <Switch
                          aria-label={`${definition.name} 输入`}
                          checked={current.value === true}
                          disabled={controlDisabled}
                          checkedChildren="true"
                          unCheckedChildren="false"
                          onChange={(value) =>
                            onChangeInput(definition.name, { ...current, value })
                          }
                        />
                      )}
                      {editor.nullable ? (
                        <Checkbox
                          checked={current.explicitNull}
                          disabled={submitting || !enabled}
                          onChange={(event) =>
                            onChangeInput(definition.name, {
                              ...current,
                              explicitNull: event.target.checked,
                            })
                          }
                        >
                          明确传入 null
                        </Checkbox>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </Form>
        )
      ) : null}

      {build && !build.ok ? (
        <Typography.Text type="danger" role="alert">
          {build.issues[0]?.message}
        </Typography.Text>
      ) : null}

      <div className={styles.actions}>
        <Button type="primary" loading={submitting} disabled={!canRun} onClick={onRun}>
          {submitting ? '正在发起运行…' : '运行'}
        </Button>
      </div>

      {state.phase === 'accepted' && state.accepted ? (
        <Alert
          showIcon
          type="success"
          title="运行请求已受理"
          description={
            <Space direction="vertical" size={0}>
              <span>WorkflowRun.id：{state.accepted.id}</span>
              <span>workflowVersionId：{state.accepted.workflowVersionId}</span>
              <span>invocationKey：{state.accepted.invocationKey}</span>
              <span>status：{state.accepted.status}</span>
            </Space>
          }
        />
      ) : null}

      {state.phase === 'error' && state.error ? (
        <Alert
          showIcon
          type="error"
          title="运行请求未确认"
          description={
            <Space direction="vertical" size={0}>
              <span>{state.error.message}</span>
              {state.error.workflowRunId ? (
                <span>WorkflowRun.id：{state.error.workflowRunId}</span>
              ) : null}
              <span>
                invocationKey：
                {state.error.invocationKey ?? state.request?.invocationKey ?? '未生成'}
              </span>
            </Space>
          }
          action={
            <Button size="small" disabled={submitting} onClick={onRetry}>
              重试同一次请求
            </Button>
          }
        />
      ) : null}
      <WorkflowRunStatusView state={runStatus} onRefresh={onRefreshRunStatus} />
    </section>
  );
}
