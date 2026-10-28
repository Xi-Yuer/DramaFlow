import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const [task, ...args] = process.argv.slice(2);
const commands = {
  dev: ['exec', 'turbo', 'run', 'dev'],
  build: ['exec', 'turbo', 'run', 'build'],
  typecheck: ['exec', 'turbo', 'run', 'typecheck'],
  lint: ['exec', 'turbo', 'run', 'lint'],
  test: ['exec', 'turbo', 'run', 'test'],
  generate: ['--filter', '@dramaflow/database', 'generate'],
  migrate: ['--filter', '@dramaflow/database', 'migrate:deploy'],
};
if (!commands[task]) throw new Error(`未知任务 ${task}`);
// 只限制 test 的包级并发；-- 后的参数仍原样交给 Vitest。
const separator = args.indexOf('--');
const turboArgs = separator < 0 ? args : args.slice(0, separator);
if (
  task === 'test' &&
  !turboArgs.some((arg) => arg === '--concurrency' || arg.startsWith('--concurrency='))
)
  commands.test.push('--concurrency=1');
const child = spawn('pnpm', [...commands[task], ...args], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
