import { Annotation } from '@langchain/langgraph';
import { z } from 'zod';
import { executionScopeKeySchema, workflowIdentifierSchema, runtimeValueMapSchema } from '@dramaflow/contracts';
import { WorkflowStateAnnotation, workflowStateSchema, type WorkflowState } from '../../runtime/state/state.js';

export const SUBWORKFLOW_FRAME = '__dramaflow:subworkflow_frame';
export const SUBWORKFLOW_CALL = '__dramaflow:subworkflow_call';
export const SUBWORKFLOW_RESULT = '__dramaflow:subworkflow_result';
export const SUBWORKFLOW_INVOCATION_KEY = 'subworkflow:graph';
export const subworkflowCallSchema=z.object({parentNodeRunId:workflowIdentifierSchema,childExecutionId:workflowIdentifierSchema,scopeKey:executionScopeKeySchema}).strict();
export const subworkflowFrameSchema=subworkflowCallSchema.extend({state:workflowStateSchema}).strict();
export const subworkflowResultSchema=subworkflowCallSchema.extend({outputs:runtimeValueMapSchema}).strict();
const ParentInput=Annotation.Root({
  run:Annotation<WorkflowState['run']>(),inputs:Annotation<WorkflowState['inputs']>(),outputs:Annotation<WorkflowState['outputs']>(),variables:Annotation<WorkflowState['variables']>(),execution:Annotation<WorkflowState['execution']>(),
});
const ParentOutput=Annotation.Root({outputs:Annotation<WorkflowState['outputs']>()});
export const SubworkflowState=Annotation.Root({...ParentInput.spec,
  [SUBWORKFLOW_FRAME]:Annotation<z.infer<typeof subworkflowFrameSchema>>(),
  [SUBWORKFLOW_RESULT]:Annotation<z.infer<typeof subworkflowResultSchema>>(),
});
export const SubworkflowChildInput=Annotation.Root({[SUBWORKFLOW_FRAME]:Annotation<z.infer<typeof subworkflowFrameSchema>>()});
export const SubworkflowChildOutput=Annotation.Root({[SUBWORKFLOW_RESULT]:Annotation<z.infer<typeof subworkflowResultSchema>>()});
export const SubworkflowChildState=Annotation.Root({...WorkflowStateAnnotation.spec,
  ...SubworkflowChildInput.spec,
  [SUBWORKFLOW_CALL]:Annotation<z.infer<typeof subworkflowCallSchema>>(),
  ...SubworkflowChildOutput.spec,
});
export {ParentInput as SubworkflowParentInput,ParentOutput as SubworkflowParentOutput};
