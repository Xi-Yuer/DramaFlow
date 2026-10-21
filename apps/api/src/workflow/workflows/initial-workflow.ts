// 新项目与已有项目的显式初始化共用同一份初始值；不建立版本或运行。
export function createInitialWorkflowData() {
  return {
    name: '默认工作流',
    draft: { inputs: [], nodes: [], edges: [], outputs: [] },
  };
}
