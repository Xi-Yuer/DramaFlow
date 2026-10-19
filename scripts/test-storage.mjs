import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const child = spawn(
  'pnpm',
  [
    '--filter',
    '@dramaflow/server',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.config.storage.ts',
  ],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
child.once('error', (error) => {
  throw error;
});
child.once('exit', (code) => process.exit(code ?? 1));
