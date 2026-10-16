import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createDatabase } from './index.js';

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  throw new Error('请设置 ADMIN_EMAIL 与至少 12 位的 ADMIN_PASSWORD；密码不得通过命令行参数传递');
}
const db = createDatabase();
try {
  const auth = betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
    database: prismaAdapter(db, { provider: 'postgresql' }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
  });
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: process.env.ADMIN_NAME ?? '管理员' },
    });
    user = await db.user.findUniqueOrThrow({ where: { id: result.user.id } });
  }
  const userId = user.id;
  const workspace = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.upsert({
      where: { slug: process.env.WORKSPACE_SLUG ?? 'default' },
      update: {},
      create: {
        slug: process.env.WORKSPACE_SLUG ?? 'default',
        name: process.env.WORKSPACE_NAME ?? '我的工作空间',
      },
    });
    await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
      update: { role: 'owner' },
      create: { workspaceId: workspace.id, userId, role: 'owner' },
    });
    return workspace;
  });
  console.info(`管理员已关联工作空间：${workspace.slug} (${workspace.id})`);
} finally {
  await db.$disconnect();
}
