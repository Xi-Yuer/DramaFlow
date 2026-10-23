import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cli = new URL('./configure-model-provider.mjs', import.meta.url);

function config() {
  return {
    ownerId: randomUUID(),
    name: 'CLI 验证',
    pluginId: 'openai_compatible',
    pluginVersion: 1,
    configuration: { baseURL: 'https://provider.example.test/v1' },
    credentialsEnv: { apiKey: 'DRAMAFLOW_CLI_MISSING_TEST_CREDENTIAL' },
    model: { capability: 'text.generate', model: 'explicit-test-model', settings: {} },
  };
}

test('CLI 失败不输出原输入、密钥、文件路径或 stack，也不调用外部模型', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dramaflow-model-cli-'));
  const file = join(directory, 'server-config.json');
  try {
    for (const [name, content, args] of [
      ['损坏 JSON', '{"credential":"secret-marker",', [file]],
      [
        '拒绝明文 credentials',
        JSON.stringify({ ...config(), credentials: { apiKey: 'secret-marker' } }),
        [file],
      ],
      ['拒绝密文输入', JSON.stringify({ ...config(), ciphertext: 'secret-marker' }), [file]],
      ['缺少显式凭证环境变量', JSON.stringify(config()), [file]],
      ['不接受命令行密钥', JSON.stringify(config()), [file, '--api-key=secret-marker']],
    ]) {
      await t.test(name, async () => {
        await writeFile(file, content, { mode: 0o600 });
        const environment = { ...process.env };
        delete environment.DRAMAFLOW_CLI_MISSING_TEST_CREDENTIAL;
        const result = spawnSync(process.execPath, [cli.pathname, ...args], {
          cwd: directory,
          encoding: 'utf8',
          env: environment,
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^模型配置失败，/);
        assert.doesNotMatch(result.stderr, /secret-marker|server-config\.json|\.mjs:\d|Error:/);
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
