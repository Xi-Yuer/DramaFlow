import type { JsonObject } from '@dramaflow/contracts';

/** 场景预设只复用文本节点，不固定厂商、模型或凭证。 */
export const creationPresets: {
  id: string;
  title: string;
  description: string;
  config: JsonObject;
}[] = [
  {
    id: 'script',
    title: '剧本生成',
    description: '把故事需求展开为可制作剧本',
    config: {
      prompt:
        '根据绑定的创作要求或上下文，编写适合漫剧制作的剧本。明确人物、场景、对白、动作与情绪，保持叙事连贯。信息不足时指出缺失信息，不擅自替换用户约束。',
    },
  },
  {
    id: 'storyboard',
    title: '分镜描述',
    description: '将剧本拆解为清晰的镜头说明',
    config: {
      prompt:
        '根据绑定的剧本，为漫剧制作整理逐镜头分镜。每个镜头说明场景、人物、构图、景别、动作、对白与画面提示词，保留角色和视觉风格的一致性。',
    },
  },
];
