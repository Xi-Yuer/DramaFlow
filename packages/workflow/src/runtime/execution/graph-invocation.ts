import {
  executionScopeKeySchema,
  graphDefinitionSchema,
  isTypeAssignable,
  runtimeValueSchema,
  workflowPortNameSchema,
  type GraphDefinition,
  type GraphInputDefinition,
  type RuntimeValue,
} from '@dramaflow/contracts';
import { graphDefinitionLocationSchema, type GraphDefinitionLocation } from './execution-scope.js';
import {
  workflowStateSchema,
  type WorkflowRunContext,
  type WorkflowState,
} from '../state/state.js';

export interface GraphInputMapping {
  readonly source: string;
  readonly target: string;
}
export class GraphInputMappingError extends Error {
  constructor(
    readonly code:
      'UNKNOWN_INPUT' | 'DUPLICATE_TARGET' | 'SOURCE_MISSING' | 'INPUT_REQUIRED' | 'TYPE_MISMATCH',
    readonly inputName: string,
  ) {
    super(`局部图输入映射失败：${code} (${inputName})`);
    this.name = 'GraphInputMappingError';
  }
}

// 调用方仅提供明确来源，不接受父 State。返回新 map，保留各 RuntimeValue 原对象。
export function mapGraphInvocationInputs(
  inputs: readonly GraphInputDefinition[],
  sources: Readonly<Record<string, RuntimeValue>>,
  mappings: readonly GraphInputMapping[],
): Record<string, RuntimeValue> {
  const declarations = new Map(inputs.map((input) => [input.name, input]));
  if (declarations.size !== inputs.length) throw new Error('图输入声明不能重复');
  const seen = new Set<string>();
  const entries: [string, RuntimeValue][] = [];
  for (const mapping of mappings) {
    const target = workflowPortNameSchema.parse(mapping.target);
    const declaration = declarations.get(target);
    if (!declaration) throw new GraphInputMappingError('UNKNOWN_INPUT', target);
    if (seen.has(target)) throw new GraphInputMappingError('DUPLICATE_TARGET', target);
    seen.add(target);
    if (!Object.hasOwn(sources, mapping.source))
      throw new GraphInputMappingError('SOURCE_MISSING', target);
    const value = sources[mapping.source]!;
    runtimeValueSchema.parse(value); // 校验 envelope，但不能使用 parse 的复制结果替换来源。
    if (!isTypeAssignable(value.type, declaration.type))
      throw new GraphInputMappingError('TYPE_MISMATCH', target);
    entries.push([target, value]);
  }
  for (const input of inputs) {
    if (input.required && !seen.has(input.name))
      throw new GraphInputMappingError('INPUT_REQUIRED', input.name);
  }
  return Object.fromEntries(entries);
}

export interface LocalGraphInvocation {
  readonly definition: GraphDefinition;
  readonly definitionLocation: GraphDefinitionLocation;
  readonly scopeKey: string;
  readonly state: WorkflowState;
}

export function createLocalGraphInvocation(input: {
  readonly definition: GraphDefinition;
  readonly definitionLocation: GraphDefinitionLocation;
  readonly scopeKey: string;
  readonly run: WorkflowRunContext;
  readonly sources: Readonly<Record<string, RuntimeValue>>;
  readonly mappings: readonly GraphInputMapping[];
}): LocalGraphInvocation {
  const definition = graphDefinitionSchema.parse(input.definition);
  const state: WorkflowState = {
    run: { ...input.run },
    inputs: mapGraphInvocationInputs(definition.inputs, input.sources, input.mappings),
    outputs: {},
    variables: {},
    execution: {},
  };
  workflowStateSchema.parse(state);
  return {
    definition,
    definitionLocation: graphDefinitionLocationSchema.parse(input.definitionLocation),
    scopeKey: executionScopeKeySchema.parse(input.scopeKey),
    state,
  };
}
