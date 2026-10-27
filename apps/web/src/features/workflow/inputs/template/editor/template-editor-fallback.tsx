import type { TemplateInputProps } from './types';
import { bindingToTemplateEditorDocument } from '../document';
import { describeNodeOutput, sourceLabel } from '../sources';
import styles from './template-input-editor.module.css';

export function TemplateEditorFallback({
  portName,
  binding,
  disabled,
  definition,
  manifests,
}: TemplateInputProps) {
  const staticDoc = bindingToTemplateEditorDocument(binding);
  return (
    <div
      className={styles.prosemirror}
      role="textbox"
      aria-multiline="true"
      aria-label={`${portName}文本`}
      aria-disabled={disabled ? 'true' : 'false'}
    >
      {staticDoc.content.map((paragraph, pIndex) => (
        <p key={pIndex}>
          {(paragraph.content ?? []).map((inline, iIndex) => {
            if (inline.type === 'text') {
              return <span key={iIndex}>{inline.text}</span>;
            }
            if (inline.type === 'variableToken') {
              const described = describeNodeOutput(definition, manifests, {
                nodeId: inline.attrs.nodeId,
                portKey: inline.attrs.portKey,
              });
              const label = sourceLabel(described.nodeName, described.portName);
              return (
                <span
                  key={`${inline.attrs.alias}:${iIndex}`}
                  className={styles.chip}
                  data-alias={inline.attrs.alias}
                  data-variable-token={inline.attrs.alias}
                >
                  <span className={styles.chipLabel}>{label}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    disabled={disabled}
                    aria-label={`删除变量 ${described.nodeName} ${described.portName}`}
                  >
                    ×
                  </button>
                </span>
              );
            }
            return null;
          })}
        </p>
      ))}
    </div>
  );
}
