import { Check } from 'lucide-react';
import type { ConfiguredSelectorGroup } from '../selection/model-selector-options';

export function ConfiguredModelGroup({
  group,
  selectedId,
  onSelect,
}: {
  group: ConfiguredSelectorGroup;
  selectedId: string | undefined;
  onSelect: (configurationId: string) => void;
}) {
  return (
    <div role="group" aria-label={group.providerName}>
      <h3>{group.providerName}</h3>
      <ul>
        {group.models.map((model) => {
          const selected = model.configurationId === selectedId;
          return (
            <li key={model.configurationId}>
              <button
                type="button"
                className="model-selector-option"
                role="option"
                aria-selected={selected}
                data-configuration-id={model.configurationId}
                onClick={() => onSelect(model.configurationId)}
              >
                <span className="model-selector-name">{model.displayName}</span>
                <span className="model-selector-state">
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                  可用
                </span>
                {model.detail ? <small>{model.detail}</small> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
