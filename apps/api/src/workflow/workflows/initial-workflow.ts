// 显式创建独立 Workflow 的空草稿；不建立版本或运行。
export function createInitialWorkflowData(name: string) {
  return {
    name,
    draft: { inputs: [], nodes: [], edges: [], outputs: [] },
  };
}
