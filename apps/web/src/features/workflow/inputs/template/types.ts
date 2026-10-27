import type { StaticInputBinding, TemplateBinding } from '@dramaflow/contracts';

export interface AvailableOutput {
  nodeId: string;
  nodeName: string;
  portKey: string;
  portName: string;
}

export type NodeOutputVariables = {
  [name: string]: Extract<TemplateBinding['variables'][string], { type: 'node_output' }>;
};

export type TextBindingDraft =
  { status: 'clear' } | { status: 'ready'; binding: StaticInputBinding } | { status: 'invalid' };

export interface TemplateEditorTextNode {
  type: 'text';
  text: string;
}

export interface TemplateEditorVariableNode {
  type: 'variableToken';
  attrs: {
    alias: string;
    nodeId: string;
    portKey: string;
  };
}

export interface TemplateEditorHardBreakNode {
  type: 'hardBreak';
}

export type TemplateEditorInlineNode =
  TemplateEditorTextNode | TemplateEditorVariableNode | TemplateEditorHardBreakNode;

export interface TemplateEditorParagraphNode {
  type: 'paragraph';
  content?: TemplateEditorInlineNode[];
}

export interface TemplateEditorDocument {
  type: 'doc';
  content: TemplateEditorParagraphNode[];
}
