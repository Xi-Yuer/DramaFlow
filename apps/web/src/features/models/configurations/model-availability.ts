import type { ModelAvailability, ManagedModelConfiguration } from '@dramaflow/contracts';

const reasons: Record<NonNullable<ModelAvailability['unavailableReason']>, string> = {
  MODEL_DISABLED: '模型已停用',
  PROVIDER_DISABLED: '供应商已停用',
  PLUGIN_UNAVAILABLE: '接入方式当前不可用',
  CAPABILITY_UNAVAILABLE: '接入方式当前不支持此能力',
  CONFIGURATION_INVALID: '配置与当前能力要求不匹配，请新建配置',
};
export function availabilityLabel(model: ManagedModelConfiguration) {
  return model.availability.selectable
    ? '可供工作流选择'
    : reasons[model.availability.unavailableReason!];
}
