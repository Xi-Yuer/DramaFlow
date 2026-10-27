import type { NodeCatalogEntry, NodeTypeManifest } from '@dramaflow/contracts';
import { NodeCatalog } from '@dramaflow/server';
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
    // 产品创建入口使用独立的 node-catalog，不在此裁剪 Runtime 能力。
    return this.registry.listManifests();
  }
}

@Controller('workflow/node-catalog')
export class NodeCatalogController {
  constructor(@Inject(NodeCatalog) private readonly catalog: NodeCatalog) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(): NodeCatalogEntry[] {
    return this.catalog.list();
  }
}
