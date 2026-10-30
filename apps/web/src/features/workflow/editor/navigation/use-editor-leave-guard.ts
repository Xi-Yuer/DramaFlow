'use client';
import { useLeaveGuard } from '@/lib/navigation/use-leave-guard';
import { editorLeavingUnsafe, type EditorLeaveState } from './editor-leave-safety';

export function useEditorLeaveGuard(state: EditorLeaveState) {
  return useLeaveGuard(editorLeavingUnsafe(state));
}
