import {
  graphInputDefinitionSchema,
  workflowPortNameSchema,
  type GraphInputDefinition,
  type DataType,
} from '@dramaflow/contracts';

export type GraphInputPatch = {
  name?: string;
  type?: DataType;
  required?: boolean;
};

export function fail(error: { issues: readonly { message: string }[] }, fallback: string): never {
  throw new Error(error.issues[0]?.message ?? fallback);
}

export function parseInput(input: GraphInputDefinition) {
  const parsed = graphInputDefinitionSchema.safeParse(input);
  if (!parsed.success) fail(parsed.error, '输入无效');
  return parsed.data;
}

export function parsePortName(name: string) {
  const parsed = workflowPortNameSchema.safeParse(name);
  if (!parsed.success) fail(parsed.error, '输入名称不合法');
  return parsed.data;
}

export function uniqueName(base: string, used: ReadonlySet<string>) {
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base}_${index}`;
    index += 1;
  }
  return name;
}
