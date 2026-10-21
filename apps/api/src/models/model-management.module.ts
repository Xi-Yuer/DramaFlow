import { Module } from '@nestjs/common';
import { ModelProviderModule } from '@dramaflow/server';
import { ModelManagementController } from './model-management.controller.js';

@Module({
  imports: [ModelProviderModule],
  controllers: [ModelManagementController],
})
export class ModelManagementModule {}
