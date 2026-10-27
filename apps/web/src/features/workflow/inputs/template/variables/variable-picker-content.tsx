import type { Ref } from 'react';
import { Braces } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ScrollArea } from '@/components/ui/scroll-area';
import { sourceLabel } from '../sources';
import { variableNameForPort } from '../binding';
import type { AvailableOutput, NodeOutputVariables } from '../types';

export function VariablePickerContent({
  portName,
  outputs,
  variables,
  search,
  onSearchChange,
  onSelect,
  commandRef,
}: {
  portName: string;
  outputs: readonly AvailableOutput[];
  variables: NodeOutputVariables;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (output: AvailableOutput) => void;
  commandRef?: Ref<HTMLDivElement>;
}) {
  const groups = new Map<string, AvailableOutput[]>();
  for (const output of outputs) {
    const group = groups.get(output.nodeId) ?? [];
    group.push(output);
    groups.set(output.nodeId, group);
  }

  return (
    <Command ref={commandRef} label={`${portName}变量选择`}>
      <CommandInput
        aria-label={`搜索${portName}可用变量`}
        placeholder="搜索上游节点或输出…"
        value={search}
        onValueChange={onSearchChange}
      />
      <ScrollArea className="max-h-64">
        <CommandList role="listbox" aria-label={`${portName}的可用上游输出`}>
          {groups.size === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              没有可引用的上游文本输出
            </p>
          ) : (
            <>
              <CommandEmpty>没有匹配的变量</CommandEmpty>
              {[...groups.values()].map((group) => {
                const nodeName = group[0]?.nodeName ?? '';
                return (
                  <CommandGroup key={group[0]?.nodeId} heading={nodeName} aria-label={nodeName}>
                    {group.map((output) => {
                      const canInsert =
                        variableNameForPort(output.portKey, variables, output) !== null;
                      const display = sourceLabel(output.nodeName, output.portName);
                      return (
                        <CommandItem
                          key={`${output.nodeId}:${output.portKey}`}
                          value={`${output.nodeName} ${output.portName} ${output.portKey}`}
                          disabled={!canInsert}
                          aria-label={`${output.nodeName} ${output.portName}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onSelect={() => {
                            if (!canInsert) return;
                            onSelect(output);
                          }}
                        >
                          <Braces
                            size={13}
                            className="shrink-0 text-primary/80"
                            aria-hidden="true"
                          />
                          <span className="truncate">{display}</span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              })}
            </>
          )}
        </CommandList>
      </ScrollArea>
    </Command>
  );
}
