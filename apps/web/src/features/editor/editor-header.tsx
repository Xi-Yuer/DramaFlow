'use client';

import {
  ArrowLeft,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  FileUp,
  History,
  LayoutPanelLeft,
  Loader2,
  MessageSquare,
  Play,
  Save,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export function EditorHeader({
  workspacePicker,
  name,
  dirty,
  revision,
  readOnly,
  pending,
  published,
  onBack,
  onSave,
  onValidate,
  onPublish,
  onRun,
  onRuns,
  onLibrary,
  onInspector,
  onPlugins,
}: {
  workspacePicker: React.ReactNode;
  name: string;
  dirty: boolean;
  revision: number;
  readOnly: boolean;
  pending: boolean;
  published: boolean;
  onBack: () => void;
  onSave: () => void;
  onValidate: () => void;
  onPublish: () => void;
  onRun: () => void;
  onRuns: () => void;
  onLibrary: () => void;
  onInspector: () => void;
  onPlugins: () => void;
}) {
  return (
    <header className="workspace-header">
      {workspacePicker}
      <span className="header-divider" />
      <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回工作流列表">
        <ArrowLeft size={14} />
      </Button>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          maxWidth: 220,
        }}
      >
        {name || '未命名工作流'}
      </span>
      <span className={`status-tag ${dirty ? 'dirty' : ''}`}>
        {dirty ? '未保存' : `草稿 r${revision}`}
      </span>
      <div className="header-actions">
        <div className="mobile-panels">
          <Button variant="ghost" size="icon" aria-label="展开节点库" onClick={onLibrary}>
            <LayoutPanelLeft />
          </Button>
          <Button variant="ghost" size="icon" aria-label="展开属性和对话" onClick={onInspector}>
            <MessageSquare />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onPlugins}
          title="插件与模型连接"
          aria-label="插件与模型连接"
          className="hide-small"
        >
          <Settings2 />
        </Button>
        <Button variant="ghost" size="icon" onClick={onRuns} title="运行记录" aria-label="运行记录">
          <History />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onValidate}
          disabled={pending}
          title="校验工作流"
          aria-label="校验工作流"
          className="hide-small"
        >
          <CheckCheck />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || pending || !dirty}
          onClick={onSave}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Save />}保存
        </Button>
        <Button variant="secondary" size="sm" disabled={readOnly || pending} onClick={onPublish}>
          <FileUp />
          发布
        </Button>
        <Button size="sm" disabled={readOnly || pending || !published} onClick={onRun}>
          <Play size={12} />
          运行
          <ChevronRight size={12} />
        </Button>
      </div>
    </header>
  );
}

export function SaveNotice({ message, valid }: { message: string; valid: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        color: valid ? '#b6e48c' : '#e7c17d',
        fontSize: 11,
      }}
    >
      <CheckCircle2 size={13} />
      {message}
    </span>
  );
}
