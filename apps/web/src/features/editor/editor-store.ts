import { create } from 'zustand';
import type {
  InputBinding,
  JsonObject,
  NodeDefinition,
  WorkflowDefinition,
  WorkflowDraft,
  WorkflowNode,
} from '@dramaflow/contracts';

interface EditorState {
  workflowId: string | null;
  revision: number;
  name: string;
  description: string;
  definition: WorkflowDefinition;
  baseline: string;
  selectedNodeId: string | null;
  past: WorkflowDefinition[];
  future: WorkflowDefinition[];
  load: (draft: WorkflowDraft) => void;
  acceptSaved: (draft: WorkflowDraft) => void;
  commit: (definition: WorkflowDefinition) => void;
  rename: (name: string) => void;
  setDescription: (description: string) => void;
  select: (nodeId: string | null) => void;
  addNode: (
    definition: NodeDefinition,
    position?: { x: number; y: number },
    preset?: { title: string; config: JsonObject },
  ) => void;
  updateNode: (
    nodeId: string,
    changes: Partial<Pick<WorkflowNode, 'title' | 'config' | 'position'>>,
  ) => void;
  moveNodes: (positions: { id: string; x: number; y: number }[]) => void;
  removeNode: (nodeId: string) => void;
  setBinding: (binding: InputBinding) => void;
  removeBinding: (nodeId: string, port: string) => void;
  undo: () => void;
  redo: () => void;
}

const empty: WorkflowDefinition = { schemaVersion: 1, nodes: [], controlEdges: [], bindings: [] };
const snapshot = (name: string, description: string, definition: WorkflowDefinition) =>
  JSON.stringify({ name, description, definition });
export const isEditorDirty = (
  state: Pick<EditorState, 'name' | 'description' | 'definition' | 'baseline'>,
) => snapshot(state.name, state.description, state.definition) !== state.baseline;

export const useEditorStore = create<EditorState>((set, get) => ({
  workflowId: null,
  revision: 0,
  name: '',
  description: '',
  definition: empty,
  baseline: snapshot('', '', empty),
  selectedNodeId: null,
  past: [],
  future: [],
  load: (draft) =>
    set({
      workflowId: draft.id,
      revision: draft.revision,
      name: draft.name,
      description: draft.description,
      definition: draft.definition,
      baseline: snapshot(draft.name, draft.description, draft.definition),
      selectedNodeId: null,
      past: [],
      future: [],
    }),
  acceptSaved: (draft) =>
    set({
      revision: draft.revision,
      name: draft.name,
      description: draft.description,
      definition: draft.definition,
      baseline: snapshot(draft.name, draft.description, draft.definition),
    }),
  commit: (definition) =>
    set((state) => ({
      definition,
      past: [...state.past.slice(-49), state.definition],
      future: [],
    })),
  rename: (name) => set({ name }),
  setDescription: (description) => set({ description }),
  select: (selectedNodeId) => set({ selectedNodeId }),
  addNode: (nodeDefinition, position, preset) => {
    const state = get();
    const id = `${nodeDefinition.type}_${crypto.randomUUID().slice(0, 8)}`;
    const node: WorkflowNode = {
      id,
      type: nodeDefinition.type,
      version: nodeDefinition.version,
      title: preset?.title ?? nodeDefinition.label,
      position: position ?? {
        x: 100 + (state.definition.nodes.length % 3) * 300,
        y: 100 + Math.floor(state.definition.nodes.length / 3) * 220,
      },
      config: preset?.config ?? {},
    };
    state.commit({ ...state.definition, nodes: [...state.definition.nodes, node] });
    set({ selectedNodeId: id });
  },
  updateNode: (nodeId, changes) => {
    const state = get();
    state.commit({
      ...state.definition,
      nodes: state.definition.nodes.map((node) =>
        node.id === nodeId ? { ...node, ...changes } : node,
      ),
    });
  },
  moveNodes: (positions) =>
    set((state) => ({
      definition: {
        ...state.definition,
        nodes: state.definition.nodes.map((node) => {
          const next = positions.find((position) => position.id === node.id);
          return next ? { ...node, position: { x: next.x, y: next.y } } : node;
        }),
      },
    })),
  removeNode: (nodeId) => {
    const state = get();
    state.commit({
      ...state.definition,
      nodes: state.definition.nodes.filter((node) => node.id !== nodeId),
      controlEdges: state.definition.controlEdges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId,
      ),
      bindings: state.definition.bindings.filter(
        (binding) =>
          binding.nodeId !== nodeId &&
          !(binding.source.kind === 'node' && binding.source.nodeId === nodeId),
      ),
    });
    if (state.selectedNodeId === nodeId) set({ selectedNodeId: null });
  },
  setBinding: (binding) => {
    const state = get();
    state.commit({
      ...state.definition,
      bindings: [
        ...state.definition.bindings.filter(
          (item) => item.nodeId !== binding.nodeId || item.port !== binding.port,
        ),
        binding,
      ],
    });
  },
  removeBinding: (nodeId, port) => {
    const state = get();
    state.commit({
      ...state.definition,
      bindings: state.definition.bindings.filter(
        (item) => item.nodeId !== nodeId || item.port !== port,
      ),
    });
  },
  undo: () =>
    set((state) =>
      state.past.length
        ? {
            definition: state.past[state.past.length - 1],
            past: state.past.slice(0, -1),
            future: [state.definition, ...state.future].slice(0, 50),
          }
        : {},
    ),
  redo: () =>
    set((state) =>
      state.future.length
        ? {
            definition: state.future[0],
            past: [...state.past, state.definition].slice(-50),
            future: state.future.slice(1),
          }
        : {},
    ),
}));
