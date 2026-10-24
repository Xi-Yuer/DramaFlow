'use client';

import { useContext, useState } from 'react';
import { X } from 'lucide-react';
import type { NodeDefinition, NodeTypeManifest, RuntimeValue } from '@dramaflow/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ModelSelector } from '../model-selection/model-selector';
import { WorkflowNodeSettingsActions } from '../node-catalog/human-review-settings';
import { NodeTypeIcon } from '../node-catalog/node-type-icon';
import { HumanReviewCard } from '../run/status/human-review-card';
import { getRuntimeNodePresentation } from '../runtime/runtime-presentation';
import {
  formatNodeRunDuration,
  useWorkflowNodeRuntime,
  useWorkflowRuntime,
} from '../runtime/runtime-status';
import { RuntimeStatusBadge } from '../runtime/runtime-status-badge';
import { HumanReviewInspector } from './human-review-inspector';
import { IfInspector } from './if-inspector';
import { NodeInputBindingField } from './node-input-binding-field';
import { TextGenerateInspector } from './text-generate-inspector';
import styles from './workflow-node-inspector.module.css';

export type InspectorContextMode = 'design' | 'runtime';

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function configValueSummary(value: unknown) {
  if (value === undefined) return '未配置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '已配置';
}

function NodeRuntimeValueView({ value }: { value: RuntimeValue }) {
  if (value.storage === 'inline') {
    const content = value.value;
    const isText = typeof content === 'string';
    return (
      <>
        {content === '' ? <span className="text-xs text-muted-foreground"></span> : null}
        <pre className={isText ? styles.valueText : styles.valueJson}>
          {isText ? content || '无内容' : JSON.stringify(content, null, 2)}
        </pre>
      </>
    );
  }

  if (value.storage === 'collection') {
    return <span className="text-muted-foreground">集合值暂不支持展示</span>;
  }

  const { type, reference } = value;
  const typeLabel =
    type.kind === 'named' || type.kind === 'primitive' ? type.name : JSON.stringify(type);

  return (
    <dl className={styles.configList}>
      <div className={styles.configRow}>
        <dt>存储方式</dt>
        <dd>引用结果</dd>
      </div>
      <div className={styles.configRow}>
        <dt>类型</dt>
        <dd>{typeLabel}</dd>
      </div>
      <div className={styles.configRow}>
        <dt>引用类型</dt>
        <dd>{reference.kind}</dd>
      </div>
      <div className={styles.configRow}>
        <dt>{reference.kind === 'artifact' ? 'Artifact' : 'ID'}</dt>
        <dd>{reference.id}</dd>
      </div>
      {reference.kind === 'asset' ? (
        <div className={styles.configRow}>
          <dt>版本</dt>
          <dd>{reference.versionId}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function GenericNodeInspector({
  node,
  manifest,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
}) {
  const capabilityTypes = (manifest.capabilities ?? []).map((item) => item.type);
  return (
    <div className={styles.sections}>
      {manifest.inputs.length > 0 ? (
        <section className={styles.section} aria-label="输入绑定">
          {manifest.inputs.map((port) => (
            <NodeInputBindingField
              key={port.key}
              nodeId={node.id}
              port={port}
              binding={node.inputs[port.key]}
              rows={3}
            />
          ))}
        </section>
      ) : null}

      {manifest.config.length > 0 ? (
        <section className={styles.section} aria-label="节点参数">
          <span className={styles.fieldLabel}>节点参数</span>
          <dl className={styles.configList}>
            {manifest.config.map((field) => (
              <div key={field.key} className={styles.configRow}>
                <dt>{field.name}</dt>
                <dd>
                  {field.ui?.component === 'model-selector' ? (
                    <ModelSelector
                      nodeId={node.id}
                      capabilityTypes={capabilityTypes}
                      value={node.config[field.key]}
                    />
                  ) : (
                    configValueSummary(node.config[field.key])
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function NodeNameSection({ node }: { node: NodeDefinition }) {
  const settingsActions = useContext(WorkflowNodeSettingsActions);
  const disabled = !settingsActions || settingsActions.disabled;
  const [draftName, setDraftName] = useState<{ nodeId: string; value: string } | null>(null);
  const currentValue = draftName?.nodeId === node.id ? draftName.value : node.name;

  function commitName() {
    if (draftName?.nodeId !== node.id) return;
    const trimmed = draftName.value.trim();
    if (!disabled && trimmed && trimmed !== node.name) {
      settingsActions?.onRename(node.id, trimmed);
    }
    setDraftName(null);
  }

  return (
    <section className={styles.section} aria-label="节点基本信息">
      <label className={styles.field}>
        <span className={styles.fieldLabel}>节点名称</span>
        <Input
          aria-label="节点名称"
          value={currentValue}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            setDraftName({ nodeId: node.id, value });
            const trimmed = value.trim();
            if (!disabled && trimmed && trimmed !== node.name) {
              settingsActions?.onRename(node.id, trimmed);
            }
          }}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitName();
            }
          }}
        />
      </label>
    </section>
  );
}

function NodeDesignInspectorBody({
  node,
  manifest,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest | undefined;
}) {
  if (!manifest) {
    return (
      <Alert variant="warning">
        <AlertTitle>节点类型不可用，请安装匹配版本。</AlertTitle>
      </Alert>
    );
  }

  if (node.type === 'ai.text_generate' && node.typeVersion === 1) {
    return <TextGenerateInspector node={node} manifest={manifest} />;
  }

  if (node.type === 'flow.if' && node.typeVersion === 1 && manifest.executionKind === 'control') {
    return <IfInspector node={node} manifest={manifest} />;
  }

  if (
    node.type === 'flow.human_review' &&
    node.typeVersion === 1 &&
    manifest.executionKind === 'interaction'
  ) {
    return <HumanReviewInspector node={node} manifest={manifest} />;
  }

  return <GenericNodeInspector node={node} manifest={manifest} />;
}

function NodeRuntimeInspectorBody({
  node,
  manifest,
  isHumanReview,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest | undefined;
  isHumanReview: boolean;
}) {
  const runtime = useWorkflowNodeRuntime(node.id);
  const { reviewActions, onRefreshRunStatus } = useWorkflowRuntime();
  const [selectedAttempt, setSelectedAttempt] = useState<{
    nodeId: string;
    attempt: number;
  } | null>(null);

  const displayedNodeRun =
    (selectedAttempt?.nodeId === node.id
      ? runtime.attempts.find((item) => item.attempt === selectedAttempt.attempt)
      : undefined) ?? runtime.nodeRun;

  const presentation = getRuntimeNodePresentation(runtime.status, {
    isHumanReview: isHumanReview || runtime.isWaitingHumanReview,
  });

  const duration = displayedNodeRun
    ? formatNodeRunDuration(displayedNodeRun.startedAt, displayedNodeRun.completedAt)
    : null;

  const inputEntries = displayedNodeRun?.inputs
    ? Object.entries(displayedNodeRun.inputs)
    : undefined;
  const outputEntries = displayedNodeRun?.outputs
    ? Object.entries(displayedNodeRun.outputs)
    : undefined;

  return (
    <div className={styles.sections} aria-label="节点运行详情">
      <div className={styles.contextHint}>
        <Badge variant="secondary">运行上下文 · 只读</Badge>
        <span>展示当前节点的真实执行记录，不会修改工作流草稿</span>
      </div>

      <section className={styles.runtimeCard} aria-label="节点运行状态">
        <div className={styles.runtimeHeader}>
          <div className="flex items-center gap-2">
            <strong className="text-xs font-semibold text-foreground">当前节点状态</strong>
            <RuntimeStatusBadge
              status={runtime.status}
              isHumanReview={isHumanReview || runtime.isWaitingHumanReview}
              variant="inspector"
            />
          </div>
          {onRefreshRunStatus && runtime.run ? (
            <Button
              variant="outline"
              size="sm"
              disabled={runtime.runRefreshing || runtime.review?.phase === 'submitting'}
              onClick={onRefreshRunStatus}
            >
              手动刷新
            </Button>
          ) : null}
        </div>
        <p className={styles.runtimeDescription}>{presentation.description}</p>
      </section>

      {runtime.isWaitingHumanReview && runtime.review && reviewActions ? (
        <HumanReviewCard
          review={runtime.review}
          actions={reviewActions}
          refreshing={runtime.runRefreshing}
        />
      ) : runtime.status === 'waiting' ? (
        <Alert variant="warning">
          <AlertTitle>工作流正在等待继续</AlertTitle>
          <AlertDescription>
            {runtime.runRefreshing
              ? '正在读取待审批内容…'
              : runtime.runError
                ? '待审批状态未确认，请手动刷新。'
                : '当前没有可处理的人工审核，正在确认运行状态。'}
          </AlertDescription>
        </Alert>
      ) : null}

      {displayedNodeRun ? (
        <>
          <section className={styles.section} aria-label="节点执行信息">
            <div className={styles.sectionHeader}>
              <strong className="text-xs font-semibold text-foreground">执行信息</strong>
              {runtime.attempts.length > 1 ? (
                <div className={styles.attemptList} role="group" aria-label="执行尝试记录">
                  {runtime.attempts.map((item) => {
                    const isCurrentAttempt = item.attempt === displayedNodeRun.attempt;
                    return (
                      <Button
                        key={item.id}
                        variant={isCurrentAttempt ? 'default' : 'outline'}
                        size="sm"
                        aria-label={`Attempt ${item.attempt}`}
                        aria-pressed={isCurrentAttempt}
                        onClick={() =>
                          setSelectedAttempt({ nodeId: node.id, attempt: item.attempt })
                        }
                      >
                        第 {item.attempt} 次
                      </Button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <dl className={styles.configList}>
              <div className={styles.configRow}>
                <dt>Attempt</dt>
                <dd>
                  第 {displayedNodeRun.attempt} 次
                  {runtime.attempts.length > 1 ? `（共 ${runtime.attempts.length} 次）` : ''}
                </dd>
              </div>
              <div className={styles.configRow}>
                <dt>开始时间</dt>
                <dd>
                  <time dateTime={displayedNodeRun.startedAt}>
                    {formatTime(displayedNodeRun.startedAt)}
                  </time>
                </dd>
              </div>
              {displayedNodeRun.completedAt ? (
                <div className={styles.configRow}>
                  <dt>结束时间</dt>
                  <dd>
                    <time dateTime={displayedNodeRun.completedAt}>
                      {formatTime(displayedNodeRun.completedAt)}
                    </time>
                  </dd>
                </div>
              ) : null}
              {duration !== null ? (
                <div className={styles.configRow}>
                  <dt>耗时</dt>
                  <dd>{duration}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          {displayedNodeRun.error ? (
            <Alert variant="destructive" aria-label="节点执行错误">
              <AlertTitle>节点执行失败</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-0.5">
                  <span>{displayedNodeRun.error.message}</span>
                  <span>
                    阶段：{displayedNodeRun.error.stage}
                    {displayedNodeRun.error.code ? ` · ${displayedNodeRun.error.code}` : ''}
                  </span>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <section className={styles.section} aria-label="节点运行输入">
            <strong className="text-xs font-semibold text-foreground">输入</strong>
            {inputEntries === undefined ? (
              <p className={styles.emptyHint}>尚未记录节点输入</p>
            ) : inputEntries.length === 0 ? (
              <p className={styles.emptyHint}>无输入参数</p>
            ) : (
              <div className={styles.ioList}>
                {inputEntries.map(([portKey, value]) => {
                  const portName = manifest?.inputs.find((port) => port.key === portKey)?.name;
                  return (
                    <article key={portKey} className={styles.ioCard} aria-label={`输入 ${portKey}`}>
                      <div className={styles.ioHeader}>
                        <strong>{portName ?? portKey}</strong>
                        {portName ? <span className={styles.ioPortKey}>{portKey}</span> : null}
                      </div>
                      <NodeRuntimeValueView value={value} />
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className={styles.section} aria-label="节点运行输出">
            <strong className="text-xs font-semibold text-foreground">输出</strong>
            {outputEntries === undefined ? (
              <p className={styles.emptyHint}>
                {runtime.isWaitingHumanReview ? '等待人工审核完成后产生输出' : '尚未产生节点输出'}
              </p>
            ) : outputEntries.length === 0 ? (
              <p className={styles.emptyHint}>无输出数据</p>
            ) : (
              <div className={styles.ioList}>
                {outputEntries.map(([portKey, value]) => {
                  const portName = manifest?.outputs.find((port) => port.key === portKey)?.name;
                  return (
                    <article key={portKey} className={styles.ioCard} aria-label={`输出 ${portKey}`}>
                      <div className={styles.ioHeader}>
                        <strong>{portName ?? portKey}</strong>
                        {portName ? <span className={styles.ioPortKey}>{portKey}</span> : null}
                      </div>
                      <NodeRuntimeValueView value={value} />
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : !runtime.isWaitingHumanReview ? (
        <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-xs text-muted-foreground">
          {runtime.run ? '当前节点尚无执行记录' : '尚无运行记录，请先发布并运行工作流'}
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowNodeInspector({
  node,
  manifest,
  mode,
  onModeChange,
  onClose,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest | undefined;
  mode: InspectorContextMode;
  onModeChange: (next: InspectorContextMode) => void;
  onClose: () => void;
}) {
  const runtime = useWorkflowNodeRuntime(node.id);
  const isHumanReview =
    node.type === 'flow.human_review' &&
    node.typeVersion === 1 &&
    manifest?.executionKind === 'interaction';

  return (
    <aside
      className={styles.inspector}
      aria-label="节点检查器"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          event.stopPropagation();
        }
      }}
    >
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.icon} aria-hidden="true">
            <NodeTypeIcon metadata={manifest?.metadata} />
          </span>
          <div className={styles.titleGroup}>
            <strong>{node.name}</strong>
            <span>
              {manifest?.metadata.name ?? node.type} · v{node.typeVersion}
            </span>
          </div>
        </div>
        <RuntimeStatusBadge
          status={runtime.status}
          isHumanReview={isHumanReview || runtime.isWaitingHumanReview}
        />
        <Button variant="ghost" size="icon" aria-label="关闭节点检查器" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>

      <Tabs
        value={mode}
        onValueChange={(key) => onModeChange(key as InspectorContextMode)}
        className="flex flex-1 min-h-0 flex-col"
      >
        <div className={styles.contextBar}>
          <TabsList>
            <TabsTrigger value="design">节点配置</TabsTrigger>
            <TabsTrigger value="runtime">运行状态</TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className={styles.scrollArea} data-testid="inspector-scroll-area">
          <TabsContent value="design" className="mt-0">
            <div className={styles.sections} aria-label="节点设计配置">
              <div className={styles.contextHint}>
                <Badge variant="secondary">设计上下文 · 草稿</Badge>
                <span>修改仅作用于当前工作流草稿</span>
              </div>
              <NodeNameSection node={node} />
              <NodeDesignInspectorBody node={node} manifest={manifest} />
            </div>
          </TabsContent>
          <TabsContent value="runtime" className="mt-0">
            <NodeRuntimeInspectorBody
              node={node}
              manifest={manifest}
              isHumanReview={isHumanReview}
            />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}
