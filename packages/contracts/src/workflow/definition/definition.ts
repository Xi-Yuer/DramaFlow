// Workflow 保留既有产品入口；根与局部图共享同一份定义协议及校验。
export {
  graphInputDefinitionSchema as workflowInputDefinitionSchema,
  graphDraftDefinitionSchema as workflowDraftDefinitionSchema,
  graphOutputDefinitionSchema as workflowOutputDefinitionSchema,
  graphDefinitionSchema as workflowDefinitionSchema,
  type GraphInputDefinition as WorkflowInputDefinition,
  type GraphOutputDefinition as WorkflowOutputDefinition,
  type GraphDefinition as WorkflowDefinition,
} from '../graph/definition.js';
