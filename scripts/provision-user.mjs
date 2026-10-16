import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
if (existsSync('.env')) process.loadEnvFile('.env');
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { z } = require('zod');
const admin = process.argv.includes('--admin');
const input = z
  .object({
    email: z.email(),
    name: z.string().trim().min(1).max(80),
    password: z.string().min(12).max(128),
  })
  .safeParse({
    email: (admin ? process.env.ADMIN_EMAIL : process.env.NEW_USER_EMAIL)?.trim().toLowerCase(),
    name: admin ? process.env.ADMIN_NAME : process.env.NEW_USER_NAME,
    password: admin ? process.env.ADMIN_PASSWORD : process.env.NEW_USER_PASSWORD,
  });
if (!input.success)
  throw new Error(
    `账号初始化配置无效：${input.error.issues.map((issue) => issue.path.join('.')).join('、')}；请检查 ${admin ? 'ADMIN' : 'NEW_USER'} 环境变量`,
  );
const { createDatabase } = await import('../packages/database/dist/index.js');
const { createAuth } = await import('../apps/api/dist/auth/auth.factory.js');
const db = createDatabase();
try {
  const existing = await db.user.findUnique({ where: { email: input.data.email } });
  if (existing) {
    if (admin && existing.role !== 'admin')
      throw new Error('该邮箱已有普通账号，初始化工具不会自动提权');
    console.info('账号已存在，保留原密码与资料。');
  } else {
    const auth = createAuth(db);
    const result = await auth.api.createUser({
      body: { ...input.data, role: admin ? 'admin' : 'user' },
    });
    await db.userProfile.upsert({
      where: { userId: result.user.id },
      create: { userId: result.user.id },
      update: {},
    });
    console.info(
      admin
        ? '初始管理员已创建，登录凭证保存在本机 .env 的 ADMIN_* 中。'
        : '成员账号已创建。请妥善交付并清理 NEW_USER_PASSWORD 配置。',
    );
  }
} finally {
  await db.$disconnect();
}
