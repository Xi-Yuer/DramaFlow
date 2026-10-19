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
    return this.registry.listManifests();
  }
}
