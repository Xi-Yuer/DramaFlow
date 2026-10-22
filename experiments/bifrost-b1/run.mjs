import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectResponse } from '../litellm-l2/protocol.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(directory, 'image.lock.json'), 'utf8'));
const fixtureLock = JSON.parse(
  await readFile(path.join(directory, 'fixture-image.lock.json'), 'utf8'),
);
const batch = randomBytes(8).toString('hex');
const project = `dramaflow-b1-${batch}`;
const temporary = await mkdtemp(path.join(tmpdir(), project));
const output = path.resolve(directory, '../../.local/bifrost-b1', batch);
await mkdir(output, { recursive: true, mode: 0o700 });
const gatewayKey = `sk-bf-b1-${randomBytes(24).toString('hex')}`;
const providerKeys = ['a', 'b'].map(
  (id) => `sk-b1-provider-${id}-${randomBytes(24).toString('hex')}`,
);
const master = randomBytes(32);
const encrypted = providerKeys.map((key, index) => {
  const iv = randomBytes(12),
    owner = `owner-${index}`;
  const cipher = createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(Buffer.from(owner));
  return {
    owner,
    iv,
    ciphertext: Buffer.concat([cipher.update(key), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
});
function decrypt(index) {
  const value = encrypted[index];
  const decipher = createDecipheriv('aes-256-gcm', master, value.iv);
  decipher.setAAD(Buffer.from(value.owner));
  decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString();
}
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const sanitize = (value) =>
  [gatewayKey, ...providerKeys].reduce(
    (text, key) => text.replaceAll(key, '[REDACTED]'),
    String(value),
  );
const report = {
  version: lock.version,
  image: lock.image,
  executedAt: new Date().toISOString(),
  matrix: [],
  checks: [],
  blockers: [],
  resources: {},
};
const rawResponses = [];
let composeArguments, oracle, gatewayId, customId;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(executable, args, { allowFailure = false, input } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  if (result.code !== 0 && !allowFailure)
    throw new Error(sanitize(`${executable}: ${result.stderr.slice(-1500)}`));
  return result;
}
const compose = (args, options) => command('docker', [...composeArguments, ...args], options);
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.deadlineMs ?? 10000),
  });
  const raw = await response.text();
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  return { status: response.status, raw, value, headers: Object.fromEntries(response.headers) };
}
async function ready(base, suffix = '/health') {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await request(base + suffix, { deadlineMs: 1000 })).status === 200) return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    await pause(500);
  }
  throw new Error('实验 Gateway 未就绪');
}
async function port(container, internal) {
  const info = JSON.parse((await command('docker', ['inspect', container])).stdout)[0];
  return `http://127.0.0.1:${info.NetworkSettings.Ports[`${internal}/tcp`][0].HostPort}`;
}
async function records() {
  return (await request(`${oracle}/__records`)).value.requests;
}
async function rss(container) {
  const text = (await command('docker', ['exec', container, 'cat', '/proc/1/status'])).stdout;
  return {
    rssKiB: Number(text.match(/^VmRSS:\s+(\d+)/m)[1]),
    highWaterKiB: Number(text.match(/^VmHWM:\s+(\d+)/m)[1]),
  };
}
function exposure(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    providerCredential: providerKeys.some((key) => text.includes(key)),
    gatewayCredential: text.includes(gatewayKey),
    endpoint:
      /api\.openai\.com|api\.anthropic\.com|endpoint-a|endpoint-b|upstream:|other-host/.test(text),
    prompt: text.includes('B1-PRIVATE-PROMPT') || /B1:[a-f0-9-]{36}:/.test(text),
    internal: text.includes('B1-INTERNAL') || text.includes('/srv/private/'),
    traceback: text.includes('B1-TRACEBACK'),
    privateHeader: text.includes('B1-PRIVATE-HEADER'),
  };
}

async function runCase(
  base,
  protocol,
  scenario = 'success',
  {
    tenant = 0,
    headers = {},
    extra = {},
    redirect,
    relation,
    official = false,
    authenticated = true,
    direct = true,
    warmId = null,
  } = {},
) {
  const id = randomUUID();
  const model = `${protocol === 'openai' ? 'gpt' : 'claude'}-b1-${tenant}`;
  const targetPath = `/target/${id}/${protocol}`;
  const from = official
    ? `https://api.${protocol === 'openai' ? 'openai' : 'anthropic'}.com`
    : 'http://endpoint-a:8080';
  const origin = {
    'same-origin': from,
    'hostname-change': 'http://endpoint-b:8080',
    'port-change': 'http://endpoint-a:8081',
    'http-https': 'https://endpoint-a:8443',
    'https-http': 'http://endpoint-b:8080',
  }[relation];
  const location = (origin ?? '') + targetPath;
  await request(`${oracle}/__case`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, protocol, scenario, redirect, location }),
  });
  const payload = {
    model: `${protocol}/${model}`,
    messages: [{ role: 'user', content: `B1:${id}:${tenant}` }],
    max_tokens: 16,
    stream: false,
    ...extra,
  };
  let response;
  try {
    response = await request(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { 'x-bf-vk': gatewayKey } : {}),
        ...(direct ? { 'x-bf-direct-key': 'true', 'x-api-key': decrypt(tenant) } : {}),
        ...headers,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    response = {
      status: null,
      raw: '',
      value: null,
      headers: {},
      transportError: { name: error.name, code: error.cause?.code ?? null },
    };
  }
  rawResponses.push(response);
  const projected =
    response.status === null
      ? {
          ok: false,
          error: {
            code: 'MODEL_CALL_UNCERTAIN',
            outcome: 'outcome_unknown',
            message: '模型调用结果无法确认',
          },
        }
      : projectResponse(response.status, response.value, {
          credentials: [gatewayKey, ...providerKeys],
        });
  assert.ok(
    !exposure(projected).providerCredential &&
      !exposure(projected).gatewayCredential &&
      !exposure(projected).endpoint,
  );
  const hits = (await records()).filter((row) => row.caseId === id);
  const item = {
    id,
    protocol,
    scenario,
    tenant,
    relation: relation ?? null,
    redirect: redirect ?? null,
    official,
    warmId,
    gatewayStatus: response.status,
    errorBody: sanitize(response.raw).slice(0, 1600),
    transportError: response.transportError ?? null,
    projected,
    rawExposure: exposure(response),
    upstreamRequests: hits.length,
    generationPosts: hits.filter((row) => row.method === 'POST').length,
    targetRequests: hits.filter((row) => row.target).length,
    records: hits,
  };
  report.matrix.push(item);
  if (hits.length) {
    assert.ok(
      hits
        .filter((row) => !row.target)
        .every((row) => row.credentialFingerprint === fingerprint(providerKeys[tenant])),
      '跨租户 credential 串用',
    );
    assert.ok(
      hits
        .filter((row) => !row.target)
        .every((row) => row.model === model && row.bodyIdentity && !row.stream),
      'model/body identity 不匹配',
    );
    assert.ok(
      hits
        .filter((row) => !row.target)
        .every((row) =>
          protocol === 'openai'
            ? row.path.endsWith('/chat/completions') && row.authorizationFingerprint
            : row.path.endsWith('/messages') && row.apiKeyFingerprint,
        ),
      'wire protocol 不匹配',
    );
  }
  console.log(
    `${protocol}/${scenario}${redirect ?? ''}/${relation ?? ''}: HTTP=${response.status}, POST=${item.generationPosts}`,
  );
  return item;
}

async function memorySnapshot(container) {
  const result = await command(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--pid',
      `container:${container}`,
      '--cap-add',
      'SYS_PTRACE',
      '--security-opt',
      'seccomp=unconfined',
      '--entrypoint',
      'python',
      '-v',
      `${directory}:/experiment:ro`,
      report.fixtureImage,
      '/experiment/memory_probe.py',
    ],
    {
      allowFailure: true,
      input: JSON.stringify({ gateway: gatewayKey, a: providerKeys[0], b: providerKeys[1] }),
    },
  );
  return result.code === 0
    ? JSON.parse(result.stdout)
    : { supported: false, error: sanitize(result.stderr).slice(-400) };
}

try {
  const imageInfo = JSON.parse(
    (await command('docker', ['image', 'inspect', lock.image])).stdout,
  )[0];
  assert.equal(imageInfo.Id, lock.configDigests[`${imageInfo.Os}/${imageInfo.Architecture}`]);
  let fixtureImage = fixtureLock.image;
  const exact = await command('docker', ['image', 'inspect', fixtureImage], { allowFailure: true });
  if (exact.code !== 0) {
    const info = JSON.parse(
      (await command('docker', ['image', 'inspect', fixtureLock.tag])).stdout,
    )[0];
    assert.equal(info.Id, fixtureLock.configDigests[`${info.Os}/${info.Architecture}`]);
    fixtureImage = info.Id;
  }
  report.fixtureImage = fixtureImage;
  report.imageConfig = imageInfo.Id;
  const fixtures = [
    'image.lock.json',
    'fixture-image.lock.json',
    'dependencies.lock.json',
    'config.json',
    'catalog-pricing.json',
    'catalog-params.json',
    'compose.yaml',
    'upstream.py',
    'relay.py',
    'memory_probe.py',
    'storage_probe.py',
    'run.mjs',
    '../litellm-l2/protocol.mjs',
  ];
  report.fixtureSha256 = Object.fromEntries(
    await Promise.all(
      fixtures.map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(path.join(directory, name)))
          .digest('hex'),
      ]),
    ),
  );
  const config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
  await writeFile(path.join(temporary, 'official.json'), JSON.stringify(config), { mode: 0o600 });
  const noDb = structuredClone(config);
  noDb.config_store = { enabled: false };
  await writeFile(path.join(temporary, 'no-db.json'), JSON.stringify(noDb), { mode: 0o600 });
  const custom = structuredClone(config);
  for (const protocol of ['openai', 'anthropic'])
    custom.providers[protocol].network_config.base_url = 'http://endpoint-a:8080';
  await writeFile(path.join(temporary, 'custom.json'), JSON.stringify(custom), { mode: 0o600 });
  await command('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=upstream',
    '-addext',
    'subjectAltName=DNS:api.openai.com,DNS:api.anthropic.com,DNS:upstream,DNS:endpoint-a,DNS:endpoint-b,DNS:other-host',
    '-keyout',
    path.join(temporary, 'server.key'),
    '-out',
    path.join(temporary, 'server.crt'),
  ]);
  const env = path.join(temporary, 'compose.env');
  await writeFile(
    env,
    `B1_IMAGE=${lock.image}\nB1_STUB_IMAGE=${fixtureImage}\nB1_GATEWAY_KEY=${gatewayKey}\nB1_TEMP=${temporary}\n`,
    { mode: 0o600 },
  );
  composeArguments = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    env,
    '-f',
    path.join(directory, 'compose.yaml'),
  ];
  await compose(['up', '-d', '--pull', 'never']);
  const relay = (await compose(['ps', '-q', 'relay'])).stdout.trim();
  gatewayId = (await compose(['ps', '-q', 'gateway'])).stdout.trim();
  customId = (await compose(['ps', '-q', 'custom-gateway'])).stdout.trim();
  const gateway = await port(relay, 4100),
    customGateway = await port(relay, 4101);
  oracle = await port(relay, 8080);
  await Promise.all([ready(gateway), ready(customGateway), ready(oracle, '/__health')]);
  const started = JSON.parse((await command('docker', ['inspect', gatewayId])).stdout)[0].State
    .StartedAt;
  report.resources.startupUntilObservedReadyMs = Date.now() - Date.parse(started);
  report.resources.idle = await rss(gatewayId);
  await compose(['up', '-d', '--pull', 'never', 'no-db-gateway']);
  const noDbId = (await compose(['ps', '-a', '-q', 'no-db-gateway'])).stdout.trim();
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = JSON.parse((await command('docker', ['inspect', noDbId])).stdout)[0].State;
    if (!state.Running) break;
    await pause(500);
  }
  const noDbLog = await command('docker', ['logs', noDbId]);
  report.noDbBootstrap = {
    state: JSON.parse((await command('docker', ['inspect', noDbId])).stdout)[0].State,
    governanceStoreRequired: noDbLog.stdout
      .concat(noDbLog.stderr)
      .includes('config store is required'),
  };
  delete report.noDbBootstrap.state.Error;
  report.plugins = sanitize(
    (
      await request(`${gateway}/api/plugins/loaded`, {
        headers: { 'X-Bifrost-Setup-Token': gatewayKey },
      })
    ).raw,
  );
  const providersBefore = await request(`${gateway}/api/providers`, {
    headers: { 'X-Bifrost-Setup-Token': gatewayKey },
  });
  report.providerCatalogBefore = sanitize(providersBefore.raw);
  await runCase(gateway, 'openai', 'missing-platform-key', { authenticated: false });
  await runCase(gateway, 'openai', 'invalid-platform-key', {
    headers: { 'x-bf-vk': 'sk-bf-invalid' },
  });
  await runCase(gateway, 'openai', 'success', { direct: false });
  await runCase(gateway, 'openai', 'empty-platform-key', { headers: { 'x-bf-vk': '' } });
  const normal = await runCase(gateway, 'openai');
  assert.equal(normal.gatewayStatus, 200, '仅平台 SQLite + Direct Key 成功对照失败');
  report.resources.afterNormal = await rss(gatewayId);
  assert.equal((await runCase(gateway, 'anthropic')).gatewayStatus, 200);
  assert.equal((await runCase(customGateway, 'openai')).gatewayStatus, 200);
  assert.equal((await runCase(customGateway, 'anthropic')).gatewayStatus, 200);
  const concurrent = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      runCase(gateway, index % 2 ? 'anthropic' : 'openai', 'concurrent', {
        tenant: Math.floor(index / 2) % 2,
      }),
    ),
  );
  assert.ok(concurrent.every((row) => row.gatewayStatus === 200 && row.generationPosts === 1));
  report.resources.afterConcurrency = await rss(gatewayId);
  report.memoryAfterConcurrency = await memorySnapshot(gatewayId);
  report.discovery = [];
  for (const protocol of ['openai', 'anthropic']) {
    for (const tenant of [0, 1]) {
      const id = randomUUID();
      await request(`${oracle}/__discovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          protocol,
          credentialFingerprint: fingerprint(providerKeys[tenant]),
          status: tenant === 0 ? 200 : 403,
        }),
      });
      const response = await request(`${gateway}/v1/models?provider=${protocol}`, {
        headers: { 'x-bf-vk': gatewayKey, 'x-bf-direct-key': 'true', 'x-api-key': decrypt(tenant) },
      });
      const hits = (await request(`${oracle}/__records`)).value.discovery.filter(
        (row) => row.id === id,
      );
      report.discovery.push({
        protocol,
        tenant,
        status: response.status,
        body: sanitize(response.raw).slice(0, 1600),
        upstreamGetRequests: hits.length,
        records: hits,
        exposure: exposure(response),
      });
      assert.equal(hits.length, 1, '模型发现未走用户本次 credential 的 Provider API');
      assert.equal(response.status, tenant === 0 ? 200 : 403, '模型目录没有保持凭证权限差异');
    }
  }
  for (const protocol of ['openai', 'anthropic']) {
    for (const variant of [
      'body-api_base',
      'body-base_url',
      'header-base-url',
      'header-provider-base-url',
    ]) {
      const endpoint = 'http://endpoint-b:8080';
      await runCase(customGateway, protocol, `dynamic-${variant}`, {
        tenant: 1,
        extra:
          variant === 'body-api_base'
            ? { api_base: endpoint }
            : variant === 'body-base_url'
              ? { base_url: endpoint }
              : {},
        headers:
          variant === 'header-base-url'
            ? { 'x-bf-base-url': endpoint }
            : variant === 'header-provider-base-url'
              ? { 'x-bf-provider-base-url': endpoint }
              : {},
      });
    }
    for (const status of [301, 302, 303, 307, 308]) {
      for (const relation of ['same-origin', 'hostname-change', 'port-change', 'http-https'])
        await runCase(customGateway, protocol, 'redirect', { redirect: status, relation });
      await runCase(gateway, protocol, 'redirect', {
        redirect: status,
        relation: 'https-http',
        official: true,
      });
    }
    for (const scenario of [
      '400',
      '401',
      '403',
      '429',
      '500',
      '503',
      'timeout',
      'reset',
      'reset-once',
      'tcp-rst',
      'tcp-rst-once',
      'malformed-json',
      'malformed-schema',
      'partial-body',
      'reflect-key',
    ]) {
      const warm = await runCase(gateway, protocol, 'warmup');
      await runCase(gateway, protocol, scenario, { warmId: warm.id });
    }
  }
  await pause(7200);
  const finalRows = await records();
  for (const row of report.matrix) {
    row.records = finalRows.filter((hit) => hit.caseId === row.id);
    row.generationPosts = row.records.filter((hit) => hit.method === 'POST').length;
  }
  report.metrics = {};
  for (const [name, base] of [
    ['official', gateway],
    ['custom', customGateway],
  ]) {
    const metrics = await request(`${base}/metrics`, {
      headers: { 'X-Bifrost-Setup-Token': gatewayKey },
    });
    report.metrics[name] = {
      status: metrics.status,
      exposure: exposure(metrics.raw),
      bytes: metrics.raw.length,
    };
  }
  report.memoryAfterFaults = await memorySnapshot(gatewayId);
  report.providerCatalogAfter = sanitize(
    (
      await request(`${gateway}/api/providers`, {
        headers: { 'X-Bifrost-Setup-Token': gatewayKey },
      })
    ).raw,
  );
  report.storage = {};
  for (const [name, container] of [
    ['official', gatewayId],
    ['custom', customId],
  ]) {
    // docker cp 的容器快照不能作为 tmpfs/WAL 实际内容的审计证据；直接从运行中容器读取。
    const paths = (
      await command('docker', ['exec', container, 'find', '/app/data', '-type', 'f'])
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    const files = [];
    const database = {};
    for (const file of paths) {
      const encoded = (await command('docker', ['exec', container, 'base64', file])).stdout;
      const bytes = Buffer.from(encoded, 'base64');
      files.push({
        file: path.posix.relative('/app/data', file),
        bytes: bytes.length,
        exposure: exposure(bytes.toString()),
      });
      if (file.includes('platform.db')) database[path.posix.basename(file)] = encoded;
    }
    const databaseProbe = await command(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--entrypoint',
        'python',
        '-v',
        `${directory}:/experiment:ro`,
        report.fixtureImage,
        '/experiment/storage_probe.py',
      ],
      { input: JSON.stringify(database) },
    );
    report.storage[name] = { files, database: JSON.parse(databaseProbe.stdout) };
    const logResult = await command('docker', ['logs', container]);
    const logs = logResult.stdout + logResult.stderr;
    report[`${name}LogExposure`] = exposure(logs);
    await writeFile(path.join(output, `${name}.log`), sanitize(logs), { mode: 0o600 });
  }
  report.responseExposure = exposure(rawResponses);
  await compose(['restart', 'gateway']);
  await ready(gateway);
  report.memoryAfterRestartBeforeInvocation = await memorySnapshot(gatewayId);
  const restarted = await runCase(gateway, 'anthropic', 'after-restart', { tenant: 1 });
  assert.equal(restarted.gatewayStatus, 200);
  report.checks.push(
    '仅平台配置 SQLite、无日志 DB 的 Direct Key 与重启验证完成；平台鉴权见负向对照',
    '32 次 A/B 双协议并发 fingerprint / model / body 核对通过',
    '50 个双协议 redirect 与全部故障已记录',
  );
  assert.ok(
    report.matrix.flatMap((row) => row.records).every((row) => !row.gatewayHeaderForwarded),
    '平台凭证 header 进入 upstream',
  );
  report.dynamicEndpoint = {
    supported: false,
    sourceEvidence:
      'DirectKeyFromHeaders 仅构造 credential；OpenAI / Anthropic URL 来自 Provider networkConfig.BaseURL',
    attempts: report.matrix
      .filter((row) => row.scenario.startsWith('dynamic-'))
      .map((row) => ({
        protocol: row.protocol,
        scenario: row.scenario,
        status: row.gatewayStatus,
        actualHosts: row.records.map((hit) => hit.host),
      })),
  };
  report.dynamicEndpoint.requiredForAdmission = false;
  report.dynamicEndpoint.businessMode = '预设 Provider / endpoint + request-level user credential';
  const repeated = report.matrix.filter((row) => row.generationPosts > 1);
  if (repeated.length) report.blockers.push('max_retries=0 下仍实测重复 generation POST');
  report.repeatedInvocations = repeated.map((row) => ({
    id: row.id,
    protocol: row.protocol,
    scenario: row.scenario,
    generationPosts: row.generationPosts,
    warmId: row.warmId,
  }));
  const redirected = report.matrix.filter((row) => row.targetRequests > 0);
  if (redirected.length) report.blockers.push('redirect target 收到自动转发的请求');
  report.platformAuthentication = {
    independentKeyEnforced: !report.matrix.some(
      (row) =>
        ['missing-platform-key', 'empty-platform-key'].includes(row.scenario) &&
        row.generationPosts > 0,
    ),
    invalidKeyRejected: report.matrix.some(
      (row) =>
        row.scenario === 'invalid-platform-key' &&
        row.gatewayStatus === 401 &&
        row.generationPosts === 0,
    ),
  };
  if (!report.platformAuthentication.independentKeyEnforced)
    report.blockers.push('缺失或空值平台 VK 的请求仍能 dispatch');
  report.decision = report.blockers.length ? 'NO-GO' : 'GO';
} catch (error) {
  report.decision = 'NO-GO';
  report.failure = sanitize(error instanceof Error ? error.stack : '实验失败');
} finally {
  if (composeArguments) {
    const logs = await compose(['logs', '--no-color', '--tail', '50'], { allowFailure: true });
    await writeFile(path.join(output, 'diagnostics.log'), sanitize(logs.stdout + logs.stderr), {
      mode: 0o600,
    });
    const down = await compose(
      ['--profile', 'admission', 'down', '--volumes', '--remove-orphans'],
      { allowFailure: true },
    );
    if (down.code !== 0) report.cleanupFailure = sanitize(down.stderr);
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`B1 ${report.decision}: ${path.join(output, 'result.json')}`);
  if (report.failure) console.error(report.failure);
  process.exitCode = report.decision === 'GO' ? 0 : 1;
}
