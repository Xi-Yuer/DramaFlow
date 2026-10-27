export class ModelConfigurationError extends Error {
  constructor(
    readonly code:
      | 'MODEL_PROVIDER_CONFIGURATION_INVALID'
      | 'MODEL_CONFIGURATION_INVALID'
      | 'MODEL_CONFIGURATION_UNAVAILABLE'
      | 'MODEL_PROVIDER_UNAVAILABLE'
      | 'MODEL_CREDENTIALS_UNAVAILABLE',
  ) {
    super('模型能力配置无效或不可用');
    this.name = 'ModelConfigurationError';
  }
}
