import type { NodeTypeManifest } from '@dramaflow/contracts';
import { NodeRegistry } from '@dramaflow/workflow';
import { Controller, Get, Header, Inject } from '@nestjs/common';

@Controller('workflow/node-types')
export class NodeTypesController {
  constructor(
    @Inject(NodeRegistry)
    private readonly registry: NodeRegistry,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(): NodeTypeManifest[] {
    // 完整类型说明供已有 Definition 渲染、连线与 Inspector 使用。
    // 创建入口按 metadata.catalog 选择产品 surface，不在此裁剪 Runtime 能力。
    return this.registry.listManifests();
  }
}
