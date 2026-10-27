import { EditorContent } from '@tiptap/react';
import { VariablePicker } from '../variables/variable-picker';
import { CaretFloatingVariablePicker } from '../variables/caret-floating-variable-picker';
import { resolveSuggestionClientRect } from '../variables/variable-slash-extension';
import { TemplateEditorFallback } from './template-editor-fallback';
import { useTemplateEditor } from './use-template-editor';
import type { TemplateInputProps } from './types';
import styles from './template-input-editor.module.css';

export function EditableTemplateInput(props: TemplateInputProps) {
  const { portName, rows, outputs, disabled } = props;
  const { editor, picker, closeSlashPicker, handleInsertVariable, currentVariables } =
    useTemplateEditor(props);
  return (
    <div className={`nodrag nopan nowheel ${styles.editor}`}>
      <div className={styles.labelRow}>
        <span className={styles.label}>{portName}</span>
        <span className={styles.hint}>输入 / 插入变量</span>
      </div>
      <div
        className={`${styles.composer}${disabled ? ` ${styles.composerDisabled}` : ''}`}
        role="group"
        aria-label={portName}
        style={{ minHeight: `${rows * 1.65}em` }}
      >
        {editor ? <EditorContent editor={editor} /> : <TemplateEditorFallback {...props} />}
      </div>
      <CaretFloatingVariablePicker
        portName={portName}
        open={picker.slashPickerOpen && !disabled}
        onClose={closeSlashPicker}
        outputs={outputs}
        variables={currentVariables}
        slashQuery={picker.slashQuery}
        slashRange={picker.slashRange}
        getReferenceClientRect={() =>
          resolveSuggestionClientRect(
            editor,
            picker.slashRangeRef.current,
            picker.slashClientRectRef.current,
          )
        }
        contextElement={editor && !editor.isDestroyed ? editor.view.dom : null}
        commandRef={picker.slashCommandRef}
        onSelect={(output) => handleInsertVariable(output, 'slash')}
      />
      <div className={styles.footer}>
        <VariablePicker
          portName={portName}
          open={picker.buttonPickerOpen && !disabled}
          onOpenChange={(next) => {
            if (!disabled) {
              if (next) {
                closeSlashPicker();
              }
              picker.setButtonPickerOpen(next);
            }
          }}
          outputs={outputs}
          variables={currentVariables}
          disabled={disabled}
          onSelect={(output) => handleInsertVariable(output, 'button')}
        />
      </div>
    </div>
  );
}
