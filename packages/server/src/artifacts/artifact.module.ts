import { DefaultDataStoragePolicyResolver } from '@dramaflow/workflow';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { ArtifactRepository } from './artifact-repository.js';
import { ArtifactRuntimeFactory } from './artifact-runtime.factory.js';

@Module({
  imports: [DatabaseModule, StorageModule],
  providers: [ArtifactRepository, ArtifactRuntimeFactory, DefaultDataStoragePolicyResolver],
  exports: [ArtifactRuntimeFactory, ArtifactRepository, StorageModule],
})
export class ArtifactModule {}
