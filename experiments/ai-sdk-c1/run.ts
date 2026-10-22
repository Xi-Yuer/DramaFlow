import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APICallError } from 'ai';
import { invokeText } from './adapter.ts';
import { createOracle, type Protocol } from './upstream.ts';
import type { CapabilityInvocationContext } from '../../packages/plugins/src/provider-plugin.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
const batch = randomBytes(8).toString('hex');
const output = path.resolve(directory, '../../.local/ai-sdk-c1', batch);
await mkdir(output, { recursive: true, mode: 0o700 });
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const nativeFetch = globalThis.fetch;
const oracle = await createOracle();
const matrix: unknown[] = [];
const report = {
  executedAt: new Date().toISOString(),
  node: process.version,
  decision: 'NO-GO',
  matrix,
  fixtureSha256: {} as Record<string, string>,
  packages: {} as Record<string, string>,
  failure: undefined as string | undefined,
};

try {
  assert.match(process.version, /^v24\./, 'C1 使用与项目一致的 Node 24');
  const files = [
    'adapter.ts',
    'run.ts',
    'upstream.ts',
    'package.json',
    'package-lock.json',
    'versions.lock.json',
    'runtime.lock.json',
    'tsconfig.json',
  ];
  report.fixtureSha256 = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, sha256(await readFile(path.join(directory, file)))]),
    ),
  );
  for (const name of [
    'ai',
    '@ai-sdk/openai',
    '@ai-sdk/anthropic',
    '@ai-sdk/provider',
    '@ai-sdk/provider-utils',
  ]) {
    const value: unknown = JSON.parse(
      await readFile(path.join(directory, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.ok(
      typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        typeof value.version === 'string',
    );
    report.packages[name] = value.version;
  }
  for (const protocol of ['openai', 'anthropic'] satisfies Protocol[]) {
    for (const status of [200, 307, 308] as const) {
      const id = randomUUID();
      const apiKey = `sk-c1-${randomBytes(24).toString('hex')}`;
      const prompt = `C1-prompt-${id}`,
        system = `C1-system-${id}`;
      const providerInstance = {
        id: randomUUID(),
        configuration: {
          provider: protocol,
          baseURL: `${oracle.sourceOrigin}/case/${id}/v1`,
          timeoutMs: 10_000,
        },
        credentials: { apiKey },
      };
      const modelConfiguration = {
        providerId: providerInstance.id,
        model: protocol === 'openai' ? 'gpt-4.1-mini' : 'claude-sonnet-4-6',
        settings: { temperature: 0.2, maxOutputTokens: 16 },
      };
      const context: CapabilityInvocationContext = {
        configuration: providerInstance.configuration,
        credentials: providerInstance.credentials,
        model: modelConfiguration.model,
        settings: modelConfiguration.settings,
      };
      oracle.cases.set(id, { id, protocol, status, prompt, system });
      let fetchCalls = 0;
      // SDK 正式 fetch 注入口；不改全局、不 patch SDK，不使用自定义重试 dispatcher。
      const noRedirectFetch: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        assert.equal(url.origin, oracle.sourceOrigin, '只允许本地测试上游');
        assert.equal(
          url.pathname,
          `/case/${id}/v1/${protocol === 'openai' ? 'chat/completions' : 'messages'}`,
        );
        fetchCalls++;
        return nativeFetch(input, { ...init, redirect: 'manual' });
      };
      let result: { text: string } | undefined;
      let failure: { name: string; status: number | undefined } | undefined;
      try {
        result = await invokeText({ prompt, system }, context, noRedirectFetch);
      } catch (error) {
        // 原始错误可能含 request/URL/headers；只保存固定类型及数字 status。
        if (!APICallError.isInstance(error)) throw error;
        failure = { name: 'APICallError', status: error.statusCode };
      }
      const records = oracle.records.filter((row) => row.id === id);
      const source = records.filter((row) => !row.target),
        targets = records.filter((row) => row.target);
      assert.equal(fetchCalls, 1, 'SDK 不应重新调用生成 fetch');
      assert.equal(source.length, 1, 'Provider 应只收到一次 POST');
      assert.equal(targets.length, 0, 'redirect target 不应收到请求');
      const wire = source[0];
      assert.ok(wire);
      assert.equal(wire.method, 'POST');
      assert.equal(wire.credentialFingerprint, sha256(apiKey).slice(0, 16));
      assert.equal(wire.model, modelConfiguration.model);
      assert.equal(wire.maxOutputTokens, 16);
      assert.equal(wire.temperature, 0.2);
      assert.ok(wire.promptMatches && wire.systemMatches && !wire.streaming);
      assert.equal(wire.authorizationPresent, protocol === 'openai');
      assert.equal(wire.apiKeyPresent, protocol === 'anthropic');
      if (protocol === 'anthropic') assert.equal(wire.anthropicVersion, '2023-06-01');
      if (status === 200) assert.deepEqual(result, { text: `C1-output-${id}` });
      else assert.equal(failure?.status, status);
      const row = {
        protocol,
        status,
        id,
        fetchCalls,
        generationPosts: source.length,
        targetRequests: targets.length,
        result,
        error: failure,
        records,
      };
      assert.ok(!JSON.stringify(row).includes(apiKey));
      matrix.push(row);
      console.log(
        `${protocol} ${status}: fetch=${fetchCalls}, POST=${source.length}, target=${targets.length}`,
      );
    }
  }
  assert.equal(oracle.failures.length, 0);
  report.decision = 'GO';
} catch (error) {
  report.failure = error instanceof Error ? error.name : 'UnknownError';
  process.exitCode = 1;
} finally {
  await oracle.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`C1 ${report.decision}: ${path.join(output, 'result.json')}`);
}
