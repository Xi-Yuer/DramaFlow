import {
  compatibleConnectionSchema,
  compatibleManifest,
  textParametersSchema,
} from '../../manifest.js';
import type { ModelProvider } from '../../sdk.js';
import { ProviderError, validateProviderContext } from '../../sdk.js';
import { generateOpenAIText } from '../openai/text.js';

export const compatibleProvider: ModelProvider = {
  manifest: compatibleManifest,
  validateConnection: (configuration) => compatibleConnectionSchema.parse(configuration),
  validateParameters(capability, parameters) {
    if (capability !== 'text.generate' && capability !== 'chat')
      throw new ProviderError('UNSUPPORTED_CAPABILITY', '兼容接口仅支持文本');
    return textParametersSchema.parse(parameters);
  },
  async generateText(request, context) {
    validateProviderContext(context, true);
    return generateOpenAIText(request, context);
  },
};
