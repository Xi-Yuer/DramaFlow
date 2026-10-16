export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://dramaflow:dramaflow@localhost:5432/dramaflow',
  },
};
