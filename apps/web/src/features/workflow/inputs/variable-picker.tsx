'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement,
  type VirtualElement,
} from '@floating-ui/dom';
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

export function VariablePicker({
  portName,
  open,
  onOpenChange,
  outputs,
  variables,
  disabled,
  onSelect,
}: {
  portName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outputs: readonly AvailableOutput[];
  variables: NodeOutputVariables;
  disabled: boolean;
  onSelect: (output: AvailableOutput) => void;
}) {
  const [search, setSearch] = useState('');

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSearch('');
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
        data-testid="button-variable-popover"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <VariablePickerContent
          portName={portName}
          outputs={outputs}
          variables={variables}
          search={search}
          onSearchChange={setSearch}
          onSelect={onSelect}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface CaretFloatingPosition {
  x: number;
  y: number;
  placement: Placement;
  strategy: 'fixed' | 'absolute';
}

export async function computeCaretFloatingPosition(
  reference: VirtualElement,
  floating: HTMLElement,
): Promise<CaretFloatingPosition> {
  const { x, y, placement, strategy } = await computePosition(reference, floating, {
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 8, crossAxis: false }), shift({ padding: 8 })],
  });
  return { x, y, placement, strategy };
}

export function CaretFloatingVariablePicker({
  portName,
  open,
  onClose,
  outputs,
  variables,
  slashQuery,
  slashRange,
  getReferenceClientRect,
  contextElement,
  commandRef,
  onSelect,
}: {
  portName: string;
  open: boolean;
  onClose: () => void;
  outputs: readonly AvailableOutput[];
  variables: NodeOutputVariables;
  slashQuery: string;
  slashRange: { from: number; to: number } | null;
  getReferenceClientRect: () => DOMRect;
  contextElement: Element | null;
  commandRef?: Ref<HTMLDivElement>;
  onSelect: (output: AvailableOutput) => void;
}) {
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const getRectRef = useRef(getReferenceClientRect);
  const onCloseRef = useRef(onClose);

  const [searchState, setSearchState] = useState<{ slashQuery: string; value: string }>({
    slashQuery,
    value: slashQuery,
  });
  const search = searchState.slashQuery === slashQuery ? searchState.value : slashQuery;

  const applyPositionToDom = useCallback((pos: CaretFloatingPosition) => {
    const el = floatingRef.current;
    if (!el) return;
    el.style.position = pos.strategy;
    el.style.left = `${Math.round(pos.x)}px`;
    el.style.top = `${Math.round(pos.y)}px`;
    el.dataset.placement = pos.placement;
  }, []);

  useLayoutEffect(() => {
    getRectRef.current = getReferenceClientRect;
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    if (!open) return;
    const floatingEl = floatingRef.current;
    if (!floatingEl) return;

    const initialRect = getRectRef.current();
    applyPositionToDom({
      x: initialRect.left,
      y: initialRect.bottom + 6,
      placement: 'bottom-start',
      strategy: 'fixed',
    });

    const virtualReference: VirtualElement = {
      contextElement: contextElement ?? undefined,
      getBoundingClientRect: () => getRectRef.current(),
    };

    let active = true;
    const updatePosition = () => {
      const currentFloating = floatingRef.current;
      if (!active || !currentFloating) return;
      void computeCaretFloatingPosition(virtualReference, currentFloating).then((pos) => {
        if (!active) return;
        applyPositionToDom(pos);
      });
    };

    const cleanupAutoUpdate = autoUpdate(virtualReference, floatingEl, updatePosition, {
      ancestorScroll: true,
      ancestorResize: true,
      elementResize: typeof ResizeObserver === 'function',
      layoutShift: typeof IntersectionObserver === 'function',
    });

    return () => {
      active = false;
      cleanupAutoUpdate();
    };
  }, [open, contextElement, slashQuery, slashRange?.from, slashRange?.to, applyPositionToDom]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (floatingRef.current?.contains(target)) return;
      if (contextElement?.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, contextElement]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={floatingRef}
      role="dialog"
      aria-label={`选择${portName}变量`}
      data-testid="caret-variable-suggestion"
      data-placement="bottom-start"
      className="z-50 w-72 rounded-xl border border-white/12 bg-[#191a1e] p-0 text-popover-foreground shadow-xl outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <VariablePickerContent
        portName={portName}
        outputs={outputs}
        variables={variables}
        search={search}
        onSearchChange={(value) => setSearchState({ slashQuery, value })}
        onSelect={onSelect}
        commandRef={commandRef}
      />
    </div>,
    document.body,
  );
}
