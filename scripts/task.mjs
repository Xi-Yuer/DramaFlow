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
  bootstrap: ['--filter', '@dramaflow/database', 'bootstrap-admin'],
};
if (!commands[task]) throw new Error(`未知任务 ${task}`);
const child = spawn('pnpm', [...commands[task], ...args], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
