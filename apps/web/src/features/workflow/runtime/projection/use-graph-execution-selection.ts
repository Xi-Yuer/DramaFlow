'use client';

import { useState } from 'react';
import {
  graphPathContains,
  graphExecutionChoiceKey,
  validGraphExecutionChoice,
  type GraphExecutionChoice,
  type GraphExecutionSelection,
} from './graph-execution-projection';

export interface GraphExecutionSelectionState {
  choices: readonly GraphExecutionChoice[];
  select(selection: GraphExecutionSelection, executionId: string): void;
}

// 原 Item selection 的唯一会话状态；按 Run / Version / Definition Location 保存明确父身份。
export function useGraphExecutionSelection(): GraphExecutionSelectionState {
  const [choices, setChoices] = useState<readonly GraphExecutionChoice[]>([]);
  return {
    choices,
    select(selection, executionId) {
      if (!selection.candidates.some((candidate) => candidate.executionId === executionId)) return;
      const choice: GraphExecutionChoice = {
        workflowRunId: selection.workflowRunId,
        definition: selection.definition,
        parentInstance: selection.parentInstance,
        parentNodeRunId: selection.parentNodeRunId,
        executionId,
      };
      setChoices((current) => {
        const previous = current.find(
          (old) => graphExecutionChoiceKey(old) === graphExecutionChoiceKey(choice),
        );
        if (previous?.executionId === executionId && validGraphExecutionChoice(selection, previous))
          return current;
        return [
          ...current.filter(
            (old) =>
              old.workflowRunId !== choice.workflowRunId ||
              old.definition.workflowVersionId !== choice.definition.workflowVersionId ||
              !graphPathContains(choice.definition.path, old.definition.path),
          ),
          choice,
        ];
      });
    },
  };
}
