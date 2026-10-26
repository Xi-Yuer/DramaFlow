import {
  NumberType,
  StringType,
  applyFormatTextTemplate,
  formatTextConfigSchema,
  formatTextInputSchema,
  formatTextOutputSchema,
  type FormatTextConfig,
  type FormatTextInput,
  type FormatTextOutput,
} from '@dramaflow/contracts';
import type { NodeType } from '../registry/type.js';

export const formatTextTemplateDefault = '{{text}}-{{index}}';

// 普通 Action。编译继续走 ActionNodeCompilationStrategy，不单独提供策略。
export function createFormatTextNodeType(): NodeType<
  FormatTextInput,
  FormatTextConfig,
  FormatTextOutput
> {
  return {
    manifest: {
      type: 'data.format_text',
      version: 1,
      executionKind: 'action',
      metadata: {
        name: '文本格式化',
        category: 'data',
        description: '按模板把已声明输入插值为一段文本',
      },
      inputs: [
        { key: 'text', name: '文本', dataType: StringType, required: true },
        { key: 'index', name: '序号', dataType: NumberType, required: true },
      ],
      outputs: [{ key: 'text', name: '文本', dataType: StringType }],
      config: [
        {
          key: 'template',
          name: '格式模板',
          type: 'string',
          required: true,
          defaultValue: formatTextTemplateDefault,
          ui: { component: 'textarea', placeholder: formatTextTemplateDefault },
        },
      ],
    },
    inputSchema: formatTextInputSchema,
    configSchema: formatTextConfigSchema,
    outputSchema: formatTextOutputSchema,
    async execute(input, config) {
      return { text: applyFormatTextTemplate(config.template, input) };
    },
  };
}
