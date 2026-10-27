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
import type { AvailableOutput, NodeOutputVariables } from '../types';
import { VariablePickerContent } from './variable-picker-content';

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
