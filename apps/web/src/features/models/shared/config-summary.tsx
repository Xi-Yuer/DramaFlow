import { fieldLabel } from './schema-fields';

export function ConfigSummary({
  values,
  empty,
}: {
  values: Record<string, unknown>;
  empty?: string;
}) {
  const entries = Object.entries(values);
  return entries.length ? (
    <dl className="model-config-summary">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>
            {typeof value === 'boolean'
              ? value
                ? '是'
                : '否'
              : typeof value === 'string' || typeof value === 'number'
                ? String(value)
                : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  ) : empty ? (
    <p className="model-status-note">{empty}</p>
  ) : null;
}
