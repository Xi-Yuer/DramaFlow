'use client';
import { useEffect, useRef } from 'react';
import type { NodeDefinition } from '@dramaflow/contracts';

export type PaneMenu = {
  kind: 'pane';
  x: number;
  y: number;
  flow: { x: number; y: number };
};
export type NodeMenuState = { kind: 'node'; x: number; y: number; nodeId: string };
export type CanvasMenu = PaneMenu | NodeMenuState;

export function NodeMenu({
  menu,
  catalog,
  onAdd,
  onDelete,
  onClose,
}: {
  menu: CanvasMenu;
  catalog: NodeDefinition[];
  onAdd: (definition: NodeDefinition, flow: { x: number; y: number }) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = panel.current?.querySelector('button');
    first?.focus();
    function onPointer(event: PointerEvent) {
      if (!panel.current?.contains(event.target as globalThis.Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 280));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 320));
  return (
    <div
      ref={panel}
      className="node-menu"
      style={{ left, top }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.kind === 'node' ? (
        <button type="button" role="menuitem" onClick={() => onDelete(menu.nodeId)}>
          <strong>删除节点</strong>
          <span>同时移除与它相连的执行线</span>
        </button>
      ) : (
        <>
          <p>添加节点</p>
          {catalog.length === 0 ? (
            <span className="node-menu-empty">当前没有可添加的节点</span>
          ) : (
            catalog.map((definition) => (
              <button
                key={`${definition.type}@${definition.version}`}
                type="button"
                role="menuitem"
                onClick={() => onAdd(definition, menu.flow)}
              >
                <strong>{definition.title}</strong>
                <span>{definition.description}</span>
              </button>
            ))
          )}
        </>
      )}
    </div>
  );
}
