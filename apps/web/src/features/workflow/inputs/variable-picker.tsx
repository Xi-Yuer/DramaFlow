'use client';

import { useState } from 'react';
import { Braces } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  sourceLabel,
  variableNameForPort,
  type AvailableOutput,
  type NodeOutputVariables,
} from './template-input';

export function VariablePicker({
  portName,
  open,
  onOpenChange,
  outputs,
  variables,
  disabled,
  slashQuery = '',
  onSelect,
}: {
  portName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outputs: readonly AvailableOutput[];
  variables: NodeOutputVariables;
  disabled: boolean;
  slashQuery?: string;
  onSelect: (output: AvailableOutput) => void;
}) {
  const [searchState, setSearchState] = useState<{ slashQuery: string; value: string }>({
    slashQuery,
    value: slashQuery,
  });
  const search = searchState.slashQuery === slashQuery ? searchState.value : slashQuery;

  const groups = new Map<string, AvailableOutput[]>();
  for (const output of outputs) {
    const group = groups.get(output.nodeId) ?? [];
    group.push(output);
    groups.set(output.nodeId, group);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSearchState({ slashQuery: '', value: '' });
        }
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`向${portName}插入变量`}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Braces size={13} />
          <span>插入变量</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Command label={`${portName}变量选择`}>
          <CommandInput
            aria-label={`搜索${portName}可用变量`}
            placeholder="搜索上游节点或输出…"
            value={search}
            onValueChange={(value) => setSearchState({ slashQuery, value })}
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
      </PopoverContent>
    </Popover>
  );
}
