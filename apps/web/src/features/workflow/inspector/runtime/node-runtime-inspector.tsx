'use client';
import { useState } from 'react';
import type { NodeDefinition, NodeTypeManifest } from '@dramaflow/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HumanReviewCard } from '../../run/status/human-review-card';
import { getRuntimeNodePresentation } from '../../runtime/presentation/runtime-presentation';
import {
  formatNodeRunDuration,
  useWorkflowNodeRuntime,
  useWorkflowRuntime,
} from '../../runtime/runtime-status';
import { RuntimeStatusBadge } from '../../runtime/presentation/runtime-status-badge';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';
import styles from '../workflow-node-inspector.module.css';
import { NodeRuntimeValueView } from './node-runtime-value-view';
import { GraphExecutionNotice } from '../../runtime/presentation/graph-execution-notice';

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

export function NodeRuntimeInspectorBody({
  node,
  manifest,
  isHumanReview,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest | undefined;
  isHumanReview: boolean;
}) {
  const runtime = useWorkflowNodeRuntime(node.id);
  const { reviewActions, onRefreshRunStatus, projection } = useWorkflowRuntime();
  const [selectedAttempt, setSelectedAttempt] = useState<{
    nodeId: string;
    occurrenceId: string;
    attempt: number;
  } | null>(null);

  const ports = manifest ? resolveWorkflowNodePorts(node, manifest) : undefined;
  const displayedNodeRun =
    (selectedAttempt?.nodeId === node.id &&
    selectedAttempt.occurrenceId === runtime.nodeRun?.occurrenceId
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
      <GraphExecutionNotice projection={projection} onRefresh={onRefreshRunStatus} />
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
                          setSelectedAttempt({
                            nodeId: node.id,
                            occurrenceId: item.occurrenceId,
                            attempt: item.attempt,
                          })
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
                  const portName = ports?.inputs.find((port) => port.key === portKey)?.name;
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
                  const portName = ports?.outputs.find((port) => port.key === portKey)?.name;
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
