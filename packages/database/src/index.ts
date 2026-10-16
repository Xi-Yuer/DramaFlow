import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient, Prisma } from './generated/prisma/client.js';
export * from './generated/prisma/enums.js';

export function createDatabase(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) throw new Error('DATABASE_URL 未配置');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
