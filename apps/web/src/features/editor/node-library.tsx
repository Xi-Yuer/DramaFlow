'use client';

import { useState } from 'react';
import { Grip, Plus, Search } from 'lucide-react';
import type { NodeDefinition } from '@dramaflow/contracts';
import { nodePresentation } from './node-presentation';
import { useEditorStore } from './editor-store';
import { cn } from '@/lib/utils';
import { creationPresets } from './creation-presets';

export function NodeLibrary({
  catalog,
  collapsed,
  readOnly,
}: {
  catalog: NodeDefinition[];
  collapsed: boolean;
  readOnly: boolean;
}) {
  const [search, setSearch] = useState('');
  const addNode = useEditorStore((state) => state.addNode);
  const groups = [
    { category: 'generation', label: '生成能力' },
    { category: 'flow', label: '流程控制' },
    { category: 'data', label: '数据与结果' },
  ];
  return (
    <aside className={cn('node-library', collapsed && 'collapsed')} aria-label="节点库">
      <div className="panel-toolbar">
        <h2>节点库</h2>
        <small>NODE LIBRARY</small>
      </div>
      <div className="library-search">
        <Search size={13} />
        <input
          aria-label="搜索节点"
          placeholder="搜索节点能力…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="library-list">
        <div className="library-section-label">漫剧预设</div>
        {creationPresets
          .filter((preset) => `${preset.title} ${preset.description}`.includes(search))
          .map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="library-node"
              disabled={readOnly || !catalog.some((entry) => entry.type === 'text')}
              draggable={!readOnly}
              onClick={() => {
                const definition = catalog.find((entry) => entry.type === 'text');
                if (definition) addNode(definition, undefined, preset);
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/dramaflow-node', 'text');
                event.dataTransfer.setData('application/dramaflow-preset', preset.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              style={{ '--node-color': '#a8c5f0' } as React.CSSProperties}
            >
              <span className="library-node-icon">
                <nodePresentation.text.icon size={15} />
              </span>
              <span>
                <span className="library-node-name">{preset.title}</span>
                <span className="library-node-desc">{preset.description}</span>
              </span>
              <Plus size={13} className="add-node" />
            </button>
          ))}
        {groups.map((group) => (
          <div key={group.category}>
            <div className="library-section-label">{group.label}</div>
            {catalog
              .filter(
                (entry) =>
                  entry.category === group.category &&
                  `${entry.label} ${entry.description}`.includes(search),
              )
              .map((entry) => {
                const { icon: Icon, color } = nodePresentation[entry.type];
                return (
                  <button
                    type="button"
                    key={entry.type}
                    className="library-node"
                    disabled={readOnly}
                    draggable={!readOnly}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/dramaflow-node', entry.type);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => addNode(entry)}
                    style={{ '--node-color': color } as React.CSSProperties}
                  >
                    <span className="library-node-icon">
                      <Icon size={15} />
                    </span>
                    <span>
                      <span className="library-node-name">{entry.label}</span>
                      <span className="library-node-desc">{entry.description.slice(0, 15)}</span>
                    </span>
                    <Plus size={13} className="add-node" />
                  </button>
                );
              })}
          </div>
        ))}
      </div>
      <div className="library-footer">
        <Grip size={15} />
        拖动节点到画布，或点击添加。
        <br />
        生成能力需要手动选择插件。
      </div>
    </aside>
  );
}
