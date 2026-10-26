'use client';
import { X } from 'lucide-react';
import type { NodeDefinition, NodeTypeManifest } from '@dramaflow/contracts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NodeTypeIcon } from '../node-catalog/node-type-icon';
import { useWorkflowNodeRuntime } from '../runtime/runtime-status';
import { RuntimeStatusBadge } from '../runtime/runtime-status-badge';
import { NodeNameSection, NodeDesignInspectorBody } from './design/node-design-inspector';
import { NodeRuntimeInspectorBody } from './runtime/node-runtime-inspector';
import styles from './workflow-node-inspector.module.css';

export type InspectorContextMode = 'design' | 'runtime';

export function WorkflowNodeInspector({
  node,
  manifest,
  mode,
  onModeChange,
  onClose,
  onUpdateNode,
  bodyEntry,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest | undefined;
  mode: InspectorContextMode;
  onModeChange: (next: InspectorContextMode) => void;
  onClose: () => void;
  onUpdateNode?: (node: NodeDefinition) => void;
  bodyEntry?: { enabled: boolean; onEnter: () => void };
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

      {bodyEntry ? (
        <section className={styles.bodyEntry} aria-label="Iteration Body">
          <Button
            type="button"
            variant="outline"
            disabled={!bodyEntry.enabled}
            onClick={bodyEntry.onEnter}
          >
            编辑 Body
          </Button>
          {bodyEntry.enabled ? null : <p>尚未配置 Body</p>}
        </section>
      ) : null}
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
              <NodeDesignInspectorBody
                node={node}
                manifest={manifest}
                onUpdateNode={onUpdateNode}
              />
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
