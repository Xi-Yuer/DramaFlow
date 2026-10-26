import { StringType, type NodeTypeManifest, type WorkflowDefinition } from '@dramaflow/contracts';
import { parseInput, parsePortName, uniqueName, type GraphInputPatch } from './input-validation';
import { rewriteGraphBindings, clearIncompatibleBindings } from '../bindings/graph-input-bindings';

export function addGraphInput(graph: WorkflowDefinition): WorkflowDefinition {
  const name = uniqueName('input', new Set(graph.inputs.map((input) => input.name)));
  return {
    ...graph,
    inputs: [...graph.inputs, parseInput({ name, type: StringType, required: true })],
  };
}

export function removeGraphInput(graph: WorkflowDefinition, name: string): WorkflowDefinition {
  return {
    ...graph,
    inputs: graph.inputs.filter((input) => input.name !== name),
    nodes: rewriteGraphBindings(graph, name, null),
  };
}

export function updateGraphInput(
  graph: WorkflowDefinition,
  previousName: string,
  patch: GraphInputPatch,
  manifests: readonly NodeTypeManifest[],
): WorkflowDefinition {
  const current = graph.inputs.find((input) => input.name === previousName);
  if (!current) throw new Error('图输入不存在');
  const name = patch.name === undefined ? current.name : parsePortName(patch.name);
  if (name !== previousName && graph.inputs.some((input) => input.name === name)) {
    throw new Error('输入名称不能重复');
  }
  const input = parseInput({ ...current, ...patch, name });
  const next = {
    ...graph,
    inputs: graph.inputs.map((item) => (item.name === previousName ? input : item)),
    nodes: name === previousName ? graph.nodes : rewriteGraphBindings(graph, previousName, name),
  };
  return {
    ...next,
    nodes: clearIncompatibleBindings(next, name, input.type, manifests),
  };
}
