import { Button } from 'antd';
import { Check } from 'lucide-react';
import type { SelectorGroup, SelectorModelRow } from '../selection/model-selector-options';

function EnableModelButton({
  name,
  configurationId,
  busy,
  onEnable,
}: {
  name: string;
  configurationId: string;
  busy: boolean;
  onEnable: (configurationId: string) => void;
}) {
  return (
    <Button
      size="small"
      autoInsertSpace={false}
      aria-label={`启用 ${name}`}
      loading={busy}
      onClick={() => onEnable(configurationId)}
    >
      启用
    </Button>
  );
}

function modelStatusLabel(kind: Exclude<SelectorModelRow['status']['kind'], 'available'>) {
  if (kind === 'not-added') return '尚未添加';
  if (kind === 'unconfigured') return '未配置';
  return '已停用';
}

export function ModelGroup({
  group,
  selectedId,
  busyId,
  onSelect,
  onEnable,
  onConfigure,
  onManage,
  onAdd,
}: {
  group: SelectorGroup;
  selectedId: string | undefined;
  busyId: string | null;
  onSelect: (configurationId: string) => void;
  onEnable: (configurationId: string) => void;
  onConfigure: (row: SelectorModelRow) => void;
  onManage: () => void;
  onAdd: (row: SelectorModelRow) => void;
}) {
  return (
    <div role="group" aria-label={group.providerName}>
      <h3>{group.providerName}</h3>
      <ul>
        {group.models.map((model) => (
          <li key={model.id}>
            {model.status.kind === 'available' ? (
              model.status.choices.map((choice) => {
                const selected = choice.configurationId === selectedId;
                return (
                  <button
                    key={choice.configurationId}
                    type="button"
                    className="model-selector-option"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelect(choice.configurationId)}
                  >
                    <span className="model-selector-name">{model.displayName}</span>
                    <span className="model-selector-state">
                      {selected ? <Check size={14} aria-hidden="true" /> : null}
                      可用
                    </span>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </button>
                );
              })
            ) : (
              <div className="model-selector-static">
                <span className="model-selector-name">{model.displayName}</span>
                <span className="model-selector-state pending">
                  {modelStatusLabel(model.status.kind)}
                </span>
                <div className="model-selector-actions">
                  {model.status.kind === 'unconfigured' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      aria-label={`配置 ${group.providerName}`}
                      onClick={() => onConfigure(model)}
                    >
                      配置
                    </Button>
                  ) : null}
                  {model.status.kind === 'provider-disabled' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      aria-label={`管理 ${group.providerName}`}
                      onClick={onManage}
                    >
                      管理
                    </Button>
                  ) : null}
                  {model.status.kind === 'disabled' ? (
                    <EnableModelButton
                      name={model.displayName}
                      configurationId={model.status.configurationId}
                      busy={busyId === model.status.configurationId}
                      onEnable={onEnable}
                    />
                  ) : null}
                  {model.status.kind === 'not-added' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      aria-label={`添加 ${model.displayName}`}
                      onClick={() => onAdd(model)}
                    >
                      添加
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
