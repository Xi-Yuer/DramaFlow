import { Node, mergeAttributes } from '@tiptap/core';
import type { NodeTypeManifest, WorkflowDefinition } from '@dramaflow/contracts';
import { describeNodeOutput, sourceLabel } from '../sources';

export interface VariableTokenMetadata {
  definition: Pick<WorkflowDefinition, 'nodes'>;
  manifests: readonly NodeTypeManifest[];
  disabled: boolean;
  chipClassName: string;
  chipLabelClassName: string;
  chipRemoveClassName: string;
}

export interface VariableTokenStorage {
  metadata: VariableTokenMetadata;
}

export const VariableTokenExtension = Node.create<Record<string, never>, VariableTokenStorage>({
  name: 'variableToken',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addStorage() {
    return {
      metadata: {
        definition: { nodes: [] },
        manifests: [],
        disabled: false,
        chipClassName: '',
        chipLabelClassName: '',
        chipRemoveClassName: '',
      },
    };
  },

  addAttributes() {
    return {
      alias: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-alias') ?? '',
        renderHTML: (attributes: { alias?: string }) => ({
          'data-alias': attributes.alias ?? '',
        }),
      },
      nodeId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-node-id') ?? '',
        renderHTML: (attributes: { nodeId?: string }) => ({
          'data-node-id': attributes.nodeId ?? '',
        }),
      },
      portKey: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-port-key') ?? '',
        renderHTML: (attributes: { portKey?: string }) => ({
          'data-port-key': attributes.portKey ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-variable-token]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-variable-token': String(HTMLAttributes['data-alias'] ?? ''),
        contenteditable: 'false',
      }),
    ];
  },

  renderText({ node }) {
    const alias = String(node.attrs.alias ?? '');
    return `{{${alias}}}`;
  },

  addNodeView() {
    return ({ node: initialNode, getPos, editor }) => {
      let currentNode = initialNode;
      const dom = document.createElement('span');
      const labelSpan = document.createElement('span');
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.textContent = '×';

      const syncDom = () => {
        const meta = this.storage.metadata;
        const alias = String(currentNode.attrs.alias ?? '');
        const nodeId = String(currentNode.attrs.nodeId ?? '');
        const portKey = String(currentNode.attrs.portKey ?? '');
        const described =
          nodeId && portKey
            ? describeNodeOutput(meta.definition, meta.manifests, { nodeId, portKey })
            : { nodeName: alias, portName: alias };
        const label = sourceLabel(described.nodeName, described.portName);

        dom.className = meta.chipClassName;
        dom.dataset.alias = alias;
        dom.dataset.variableToken = alias;
        dom.dataset.nodeId = nodeId;
        dom.dataset.portKey = portKey;
        dom.contentEditable = 'false';
        dom.title = `${label} ({{${alias}}})`;

        labelSpan.className = meta.chipLabelClassName;
        labelSpan.textContent = label;

        removeButton.className = meta.chipRemoveClassName;
        removeButton.disabled = meta.disabled;
        removeButton.setAttribute(
          'aria-label',
          `删除变量 ${described.nodeName} ${described.portName}`,
        );
      };

      removeButton.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });

      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.storage.metadata.disabled) return;
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos === 'number') {
          editor.view.dispatch(editor.state.tr.delete(pos, pos + currentNode.nodeSize));
        }
      });

      dom.append(labelSpan, removeButton);
      syncDom();

      const onTransaction = () => {
        syncDom();
      };
      editor.on('transaction', onTransaction);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          syncDom();
          return true;
        },
        selectNode() {
          dom.dataset.selected = 'true';
        },
        deselectNode() {
          delete dom.dataset.selected;
        },
        stopEvent(event) {
          return event.target === removeButton;
        },
        ignoreMutation() {
          return true;
        },
        destroy() {
          editor.off('transaction', onTransaction);
        },
      };
    };
  },
});
