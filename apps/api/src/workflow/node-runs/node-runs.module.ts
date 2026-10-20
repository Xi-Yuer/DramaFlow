import { Module } from '@nestjs/common';
import { NodeRunRepositories } from './node-run-repository.js';

@Module({ providers: [NodeRunRepositories], exports: [NodeRunRepositories] })
export class NodeRunsModule {}
