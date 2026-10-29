'use client';
import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, Empty, Space, Tabs, Tag, Typography } from 'antd';
import { PanelRightClose, PanelRightOpen, Play, X } from 'lucide-react';
import { ExecutionTreeBrowser } from '../run/execution/execution-tree-browser';
import { WorkflowRunControls } from '../run/workflow-run-controls';
import { InvocationRecoveryControls } from '../run/recovery/invocation-recovery-controls';
import type { InvocationRecoveryState } from '../run/recovery/invocation-recovery';
import {
  WorkflowRunStatusView,
  workflowRunDisplay,
} from '../run/status/workflow-run-status-controls';
import { WorkflowRunHistory } from '../run/history/workflow-run-history';
import type { WorkflowVersionResponse } from '@dramaflow/contracts';
import styles from './workflow-execution-workspace.module.css';

type PanelTab = 'settings' | 'result';
export interface WorkflowExecutionWorkspaceProps {
  children: ReactNode;
  publication: ReactNode;
  run: ComponentProps<typeof WorkflowRunControls>;
  recovery: InvocationRecoveryState;
  history?: ComponentProps<typeof WorkflowRunHistory>;
  executionVersion?: WorkflowVersionResponse | null;
  onRetryRecovery(): void;
  onSelectRecovered(key: string): void;
}

// 只管理 Editor 面板；请求、输入、轮询与恢复状态仍由页面级 Run Hook 持有。
export function WorkflowExecutionWorkspace({
  children,
  publication,
  run,
  recovery,
  onRetryRecovery,
  onSelectRecovered,
  history,
  executionVersion,
}: WorkflowExecutionWorkspaceProps) {
  const [executionReload, setExecutionReload] = useState(0);
  const [view, setView] = useState({
    open: false,
    tab: 'settings' as PanelTab,
    trackingKey: '',
    attentionKey: '',
    dismissed: false,
  });
  const invoker = useRef<HTMLElement | null>(null);
  const trackedId = run.runStatus.runId ?? run.state.accepted?.id;
  const trackingKey = trackedId
    ? `${run.state.phase === 'accepted' ? 'accepted' : 'tracked'}:${trackedId}`
    : '';
  const unresolved = recovery.entries.filter((entry) => entry.phase !== 'found');
  const attentionKey = [
    run.state.phase === 'error' ? `submission:${run.state.request?.invocationKey ?? 'error'}` : '',
    ...unresolved.map((entry) => entry.receipt.invocationKey).sort(),
    recovery.storageError ? 'storage' : '',
  ]
    .filter(Boolean)
    .join('|');
  const needsAttention =
    run.state.phase === 'error' || unresolved.length > 0 || recovery.storageError;
  if (trackingKey !== view.trackingKey || attentionKey !== view.attentionKey) {
    const newRun = trackingKey !== '' && trackingKey !== view.trackingKey;
    const newAttention = needsAttention && attentionKey !== view.attentionKey;
    const showResult = newRun && (run.state.phase === 'accepted' || !view.open);
    setView({
      ...view,
      trackingKey,
      attentionKey,
      open: view.open || (newRun && !view.dismissed) || newAttention,
      tab: newAttention ? 'settings' : showResult ? 'result' : view.tab,
    });
  }
  function open(tab: PanelTab, source: HTMLElement) {
    invoker.current = source;
    setView((current) => ({ ...current, open: true, dismissed: false, tab }));
  }
  function close() {
    setView((current) => ({ ...current, open: false, dismissed: true }));
    invoker.current?.focus();
  }
  const status = run.runStatus.run?.status;
  const display = run.runStatus.run ? workflowRunDisplay(run.runStatus.run) : null;
  const currentRun = run.runStatus.run;
  const executionDefinition =
    (executionVersion ?? run.version)?.id === currentRun?.workflowVersionId
      ? ((executionVersion ?? run.version)?.definition ?? null)
      : null;
  return (
    <>
      <div className={styles.toolbar} role="group" aria-label="工作流执行工具栏">
        <div className={styles.publication}>{publication}</div>
        <Space size={8} className={styles.tools}>
          {history ? (
            <WorkflowRunHistory
              {...history}
              onSelect={(selected) => {
                history.onSelect(selected);
                setView((current) => ({ ...current, open: true, tab: 'result', dismissed: false }));
              }}
            />
          ) : null}
          {trackedId || needsAttention || run.state.phase === 'submitting' ? (
            <Button
              size="small"
              icon={<PanelRightOpen size={15} />}
              onClick={(event) => open(needsAttention ? 'settings' : 'result', event.currentTarget)}
            >
              {run.state.phase === 'submitting'
                ? '提交中…'
                : needsAttention
                  ? '请求待确认'
                  : display
                    ? `${display.label} · ${status === 'completed' ? '查看结果' : '查看状态'}`
                    : '查看运行状态'}
            </Button>
          ) : null}
          <Button
            size="small"
            type="primary"
            icon={<Play size={14} />}
            onClick={(event) => open('settings', event.currentTarget)}
          >
            运行工作流
          </Button>
        </Space>
      </div>
      <div className={styles.workspace}>
        <div className={styles.canvas}>{children}</div>
        {view.open ? (
          <aside
            className={styles.panel}
            aria-label="执行与结果"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.stopPropagation();
                close();
              }
            }}
          >
            <div className={styles.panelHeading}>
              <Space size={8}>
                <PanelRightClose size={17} aria-hidden="true" />
                <Typography.Text strong>执行与结果</Typography.Text>
                {display ? <Tag color={display.color}>{display.label}</Tag> : null}
              </Space>
              <Button
                size="small"
                type="text"
                icon={<X size={16} />}
                aria-label="关闭执行面板"
                onClick={close}
              />
            </div>
            <div className={styles.panelBody}>
              <div className={styles.recovery}>
                <InvocationRecoveryControls
                  state={recovery}
                  onRetry={onRetryRecovery}
                  onSelect={onSelectRecovered}
                />
              </div>
              <Tabs
                className={styles.tabs}
                activeKey={view.tab}
                onChange={(tab) => setView((current) => ({ ...current, tab: tab as PanelTab }))}
                items={[
                  {
                    key: 'settings',
                    label: '运行配置',
                    children: <WorkflowRunControls {...run} showStatus={false} />,
                  },
                  {
                    key: 'result',
                    label: '状态与结果',
                    children:
                      run.runStatus.phase === 'idle' ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="尚无运行状态，请先选择版本并运行工作流"
                        />
                      ) : (
                        <>
                          <WorkflowRunStatusView
                            onCancel={
                              run.onCancelRun
                                ? async (target) => {
                                    await run.onCancelRun!(target);
                                    setExecutionReload((value) => value + 1);
                                  }
                                : undefined
                            }
                            state={run.runStatus}
                            onRefresh={() => {
                              setExecutionReload((value) => value + 1);
                              run.onRefreshRunStatus();
                            }}
                            reviewActions={run.reviewActions}
                          />
                          {currentRun ? (
                            <ExecutionTreeBrowser
                              runId={currentRun.id}
                              definition={executionDefinition}
                              reloadToken={executionReload}
                            />
                          ) : null}
                        </>
                      ),
                  },
                ]}
              />
            </div>
          </aside>
        ) : null}
      </div>
    </>
  );
}
