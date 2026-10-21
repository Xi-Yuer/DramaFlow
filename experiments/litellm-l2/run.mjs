import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeOnce, projectOperation, projectResponse, projectTransport } from './protocol.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(
  await readFile(path.join(directory, '../litellm-l1/image.lock.json'), 'utf8'),
);
const batch = randomBytes(8).toString('hex');
const project = `dramaflow-l2-${batch}`;
const temporary = await mkdtemp(path.join(tmpdir(), `${project}-`));
const output = path.resolve(directory, '../../.local/litellm-l2', batch);
await mkdir(output, { recursive: true, mode: 0o700 });
const gatewayKey = `sk-l2-gateway-${randomBytes(32).toString('hex')}`;
const keys = ['a', 'b'].map((id) => `sk-l2-provider-${id}-${randomBytes(24).toString('hex')}`);
const sentinels = [
  gatewayKey,
  ...keys,
  'L2-PRIVATE-BODY',
  'L2-TRACEBACK',
  'L2-INTERNAL-METADATA',
  'L2-PRIVATE-HEADER',
];
const sanitize = (text) =>
  [gatewayKey, ...keys]
    .reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), String(text))
    .replaceAll('http://upstream:8080', '[UPSTREAM]')
    .replaceAll('http://upstream:8099', '[UPSTREAM-UNREACHABLE]');
const report = {
  version: lock.version,
  image: lock.image,
  executedAt: new Date().toISOString(),
  checks: [],
  matrix: [],
  exposure: {},
};
let composeArguments;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function command(executable, args, { input, allowFailure = false } = {}) {
  const child = spawn(executable, args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0 && !allowFailure)
    throw new Error(sanitize(`${executable} ${args[0]} 失败：${stderr.slice(-1600)}`));
  return { code, stdout, stderr };
}
const compose = (args, options) => command('docker', [...composeArguments, ...args], options);
function check(name, evidence = {}) {
  report.checks.push({ name, passed: true, ...evidence });
  console.log(`通过：${name}`);
}
async function port(container, number) {
  const text = (await command('docker', ['port', container, `${number}/tcp`])).stdout;
  const match = text.match(/127\.0\.0\.1:(\d+)/);
  assert.ok(match, '测试端口必须仅绑定 loopback');
  return `http://127.0.0.1:${match[1]}`;
}
async function ready(base) {
  const deadline = Date.now() + 100_000;
  let lastStatus = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health/liveliness`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = error instanceof Error ? error.name : 'Error';
    }
    await sleep(300);
  }
  throw new Error(`Gateway 启动失败：${lastStatus}`);
}
async function records(base) {
  const response = await fetch(`${base}/__records`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}
function request(protocol, id, scenario, key = keys[0]) {
  return {
    model: protocol === 'openai' ? 'openai/l2-model' : 'anthropic/claude-3-5-sonnet-20241022',
    messages: [
      { role: 'system', content: 'L2-PRIVATE-SYSTEM' },
      { role: 'user', content: `case:${id}:${scenario}` },
    ],
    api_key: key,
    api_base: `http://upstream:${scenario === 'provider-unreachable' ? 8099 : 8080}/${protocol}${protocol === 'openai' ? '/v1' : ''}`,
    max_tokens: 64,
    temperature: 0.25,
    stream: false,
    timeout: 1.2,
    num_retries: 0,
    max_retries: 0,
    disable_fallbacks: true,
    drop_params: false,
    modify_params: false,
  };
}
const operationLogs = [];
const rawObservations = [];
let oracleBase;
async function runCase(
  base,
  protocol,
  scenario,
  { auth = gatewayKey, deadlineMs = 4000, target } = {},
) {
  const id = randomUUID();
  const body = request(protocol, id, scenario);
  const result = await invokeOnce(target ?? `${base}/v1/chat/completions`, auth, body, deadlineMs);
  rawObservations.push(result);
  const operation = projectOperation(id, result.elapsedMs, result.projected);
  const projected = JSON.stringify({ result: result.projected, operation });
  assert.ok(
    sentinels.every((secret) => !projected.includes(secret)),
    '安全投影包含诊断输入',
  );
  assert.ok(
    !projected.includes('upstream:') && !projected.includes('traceback'),
    '安全投影包含内部协议信息',
  );
  operationLogs.push(operation);
  const item = {
    id,
    protocol,
    scenario,
    workerDeadlineMs: deadlineMs,
    upstreamTimeoutMs: 1200,
    elapsedMs: Math.round(result.elapsedMs),
    gateway: {
      httpStatus: result.status,
      transportError: result.transportError ?? null,
      errorType: result.value?.error?.type ?? null,
      errorCode: result.value?.error?.code ?? null,
      bodyPreview: sanitize(result.raw).slice(0, 1600),
      errorBodyKeys:
        result.value?.error && typeof result.value.error === 'object'
          ? Object.keys(result.value.error)
          : [],
      retryAfter: result.headers['retry-after'] ?? null,
      upstreamEndpointHeader: Object.entries(result.headers).some(
        ([name]) => name === 'x-litellm-model-api-base',
      ),
    },
    projected: result.projected,
  };
  if (oracleBase) {
    const live = (await records(oracleBase)).requests.filter((row) => row.caseId === id);
    item.oracleAtReturn = {
      upstreamRequests: live.length,
      generated: live.some((row) => row.generated),
    };
  }
  report.matrix.push(item);
  console.log(
    `观察：${protocol}/${scenario} → ${result.status ?? result.transportError?.name}，${result.projected.ok ? 'success' : result.projected.error.outcome}`,
  );
  return item;
}
function unsafeSummary(text) {
  return {
    providerCredential: keys.some((key) => text.includes(key)),
    gatewayCredential: text.includes(gatewayKey),
    upstreamEndpoint: text.includes('http://upstream:'),
    internalAddress: text.includes('/app/private/'),
    requestContent: text.includes('case:') || text.includes('L2-PRIVATE-SYSTEM'),
    traceback: text.includes('Traceback (most recent call last)') || text.includes('L2-TRACEBACK'),
    internalMetadata: text.includes('L2-INTERNAL-METADATA'),
    privateHeader: text.includes('L2-PRIVATE-HEADER'),
  };
}

try {
  let image = lock.image;
  const official = await command('docker', ['image', 'inspect', image], { allowFailure: true });
  if (official.code !== 0) {
    const info = JSON.parse((await command('docker', ['image', 'inspect', lock.tag])).stdout)[0];
    assert.equal(
      info.Id,
      lock.configDigests[`${info.Os}/${info.Architecture}`],
      '本地镜像不匹配固定 digest',
    );
    image = info.Id;
  }
  report.imageConfig = JSON.parse(
    (await command('docker', ['image', 'inspect', image])).stdout,
  )[0].Id;
  report.fixtureSha256 = Object.fromEntries(
    await Promise.all(
      [
        'compose.yaml',
        'config.yaml',
        'logging.json',
        'safe_logging.py',
        'upstream.py',
        'relay.py',
        'cache_probe.py',
        'cache_lifecycle.py',
        'protocol.mjs',
        'run.mjs',
      ].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(path.join(directory, name)))
          .digest('hex'),
      ]),
    ),
  );
  const config = await readFile(path.join(directory, 'config.yaml'), 'utf8');
  const probeConfig = path.join(temporary, 'probe.yaml');
  await writeFile(
    probeConfig,
    config.replace('  callbacks: []', '  callbacks: [cache_probe.probe]'),
    { mode: 0o600 },
  );
  const env = path.join(temporary, 'compose.env');
  await writeFile(
    env,
    `L2_IMAGE=${image}\nL2_GATEWAY_KEY=${gatewayKey}\nL2_PROBE_CONFIG=${probeConfig}\n`,
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
  const baseline = await port(relay, 4100),
    safe = await port(relay, 4101),
    probe = await port(relay, 4102),
    oracle = await port(relay, 8080);
  oracleBase = oracle;
  await Promise.all([ready(baseline), ready(safe), ready(probe)]);
  const version = (
    await compose([
      'exec',
      '-T',
      'gateway',
      'python',
      '-c',
      'import importlib.metadata;print(importlib.metadata.version("litellm"))',
    ])
  ).stdout.trim();
  assert.equal(version, lock.version);
  check('真实 Gateway 固定为 LiteLLM 1.104.5，独立实验环境已就绪');

  for (const protocol of ['openai', 'anthropic']) {
    const success = await runCase(baseline, protocol, 'success');
    assert.equal(success.projected.ok, true, '正向对照未成功');
    await runCase(baseline, protocol, 'redirect307');
    for (const scenario of [
      '400',
      '401',
      '403',
      '429',
      '500',
      '503',
      '500-after-generation',
      'timeout-before-result',
      'timeout-after-result',
      'provider-unreachable',
      'disconnect-after-accept',
      'partial-disconnect',
      'partial-stall',
      'malformed-json',
      'malformed-schema',
      'reflect-key-success',
      'context-limit',
      'content-policy',
      'unprocessable',
    ]) {
      const item = await runCase(baseline, protocol, scenario);
      assert.equal(item.projected.ok, false, `故障未被安全拒绝：${protocol}/${scenario}`);
    }
    const deadline = await runCase(baseline, protocol, 'worker-deadline', { deadlineMs: 200 });
    assert.equal(deadline.projected.error.outcome, 'outcome_unknown');
    assert.ok(deadline.elapsedMs < 1500, 'Worker 完整 deadline 未生效');
  }
  await runCase(baseline, 'openai', 'gateway-auth-failure', {
    auth: 'sk-l2-incorrect-gateway-key',
  });
  // 向已关闭的 loopback 端口发送，真实触发连接建立前 ECONNREFUSED。
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const unreachable = await runCase(baseline, 'openai', 'gateway-unreachable', {
    target: `http://127.0.0.1:${closedPort}/v1/chat/completions`,
  });
  assert.equal(unreachable.projected.error.outcome, 'definitely_failed');
  check('完整双协议故障矩阵与 Worker deadline 已执行');

  const notSent = await runCase(baseline, 'openai', 'deadline-before-dispatch', { deadlineMs: 0 });
  assert.equal(notSent.projected.error.outcome, 'definitely_failed');
  const bodyStall = await runCase(baseline, 'openai', 'gateway-body-stall', {
    deadlineMs: 200,
    target: `${oracle}/__gateway-header-stall`,
  });
  bodyStall.faultInjection = 'synthetic_gateway_response';
  assert.equal(bodyStall.gateway.httpStatus, 200, 'Worker 未覆盖收到响应头后的等待');
  assert.equal(bodyStall.projected.error.outcome, 'outcome_unknown');
  assert.ok(bodyStall.elapsedMs < 1500, '完整 body deadline 未生效');
  check('发送前预算耗尽与收到响应头后 body 停滞可明确区分');

  const beforeKill = report.matrix.length;
  const killCase = runCase(baseline, 'openai', 'worker-deadline', { deadlineMs: 4000 });
  const acceptDeadline = Date.now() + 2500;
  while (Date.now() < acceptDeadline) {
    if (
      (await records(oracle)).requests.some(
        (row) => !report.matrix.some((item) => item.id === row.caseId),
      )
    )
      break;
    await sleep(30);
  }
  await compose(['kill', '-s', 'SIGKILL', 'gateway']);
  const killed = await killCase;
  killed.scenario = 'gateway-killed-after-provider-accept';
  assert.equal(report.matrix.length, beforeKill + 1);
  assert.equal(killed.projected.error.outcome, 'outcome_unknown');
  await compose(['start', 'gateway']);
  await ready(baseline);
  check('Provider 受理后 Gateway 退出，调用结果分类为 unknown');

  for (const protocol of ['openai', 'anthropic'])
    for (const scenario of [
      'success',
      '400',
      '429',
      '500',
      'partial-disconnect',
      'reflect-key-success',
    ])
      await runCase(safe, protocol, scenario);

  for (const [index, key] of [
    [0, keys[0]],
    [1, keys[0]],
    [2, keys[1]],
  ]) {
    const body = request('openai', `cache-${index}`, 'success', key);
    const result = await invokeOnce(`${probe}/v1/chat/completions`, gatewayKey, body, 4000);
    assert.equal(result.projected.ok, true, '缓存观察正向调用失败');
  }
  await sleep(3500); // 等待晚到的上游处理完成及日志 / callback 排空，不再次发送生成。
  const rows = await records(oracle);
  assert.ok(rows.observations.length >= 3, '未收到真实 Gateway 缓存观察');
  report.cacheSnapshots = rows.observations;
  const cacheRows = rows.requests.filter((row) => row.caseId.startsWith('cache-'));
  assert.equal(cacheRows.length, 3);
  report.cacheConnectionReuse = {
    sameCredentialReusedConnection: cacheRows[0].peerPort === cacheRows[1].peerPort,
    allCredentialsMatched: cacheRows.every(
      (row, index) => row.credential === keys[index === 2 ? 1 : 0],
    ),
  };
  assert.equal(
    report.cacheConnectionReuse.allCredentialsMatched,
    true,
    'SDK client reuse 串用了 credential',
  );
  const lifecycle = await command('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-e',
    'LITELLM_LOCAL_MODEL_COST_MAP=True',
    '-v',
    `${directory}:/experiment:ro`,
    '--entrypoint',
    'python',
    image,
    '/experiment/cache_lifecycle.py',
  ]);
  report.cacheLifecycle = JSON.parse(lifecycle.stdout);
  assert.equal(report.cacheLifecycle.sdkInsertionTtl, 3600);
  assert.ok(report.cacheSnapshots.every((snapshot) => snapshot.routerClientTtlSeconds === 1));
  assert.ok(
    report.cacheSnapshots.every((snapshot) =>
      snapshot.clients.every(
        (client) => client.sdkMaxRetries === 0 && client.remainingTtlSeconds > 3500,
      ),
    ),
  );
  check(
    '实际 SDK TTL、Router TTL 分离、cache key、eviction 和关闭后的引用已验证',
    report.cacheLifecycle,
  );

  const zeroCases = new Set([
    'provider-unreachable',
    'gateway-auth-failure',
    'gateway-unreachable',
    'deadline-before-dispatch',
    'gateway-body-stall',
  ]);
  let repeated = false;
  for (const item of report.matrix) {
    const accepted = rows.requests.filter((row) => row.caseId === item.id);
    item.upstreamRequests = accepted.length;
    item.oracleGenerated = accepted.some((row) => row.generated);
    item.oracleAccepted = accepted.some((row) => row.accepted);
    item.redirectedRequests = accepted.filter((row) => row.redirected).length;
    if (!item.projected.ok && item.projected.error.outcome !== 'outcome_unknown')
      assert.equal(
        item.oracleGenerated,
        false,
        `错误宣称确定未生成：${item.protocol}/${item.scenario}`,
      );
    assert.ok(
      accepted.every((row) => row.stream === false),
      '实验开启了 streaming',
    );
    if (item.scenario !== 'redirect307')
      assert.equal(
        accepted.length,
        zeroCases.has(item.scenario) ? 0 : 1,
        `单次 invocation 上游次数不正确：${item.protocol}/${item.scenario}`,
      );
    repeated ||= accepted.length > 1;
  }
  report.retry = {
    everyInvocationAtMostOnce: !repeated,
    totalUpstreamRequests: rows.requests.length,
    routerRetries: rows.observations.map((row) => row.routerNumRetries),
    sdkRetries: rows.observations.flatMap((row) =>
      row.clients.map((client) => client.sdkMaxRetries),
    ),
  };
  if (repeated) {
    report.blockers = report.matrix
      .filter((item) => item.upstreamRequests > 1)
      .map((item) => ({
        protocol: item.protocol,
        scenario: item.scenario,
        upstreamRequests: item.upstreamRequests,
        redirectedRequests: item.redirectedRequests,
      }));
    console.error('架构阻塞：零 retry / fallback 配置下仍观察到重复上游生成请求');
  } else check('所有故障逐条核对 upstream 次数，无重复生成', { scenarios: report.matrix.length });

  // 故意塞入危险未知字段，验证采用新建 allowlist 对象，而非原错误对象删字段。
  const poison = {
    choices: [{ message: { content: 'safe output', private: keys[0] }, finish_reason: 'stop' }],
    headers: { Authorization: gatewayKey },
    metadata: { endpoint: 'http://upstream:8080' },
    traceback: 'L2-TRACEBACK',
    messages: 'L2-PRIVATE-SYSTEM',
  };
  assert.deepEqual(projectResponse(200, poison), { ok: true, output: { text: 'safe output' } });
  assert.equal(
    projectResponse(400, { error: { type: 'invalid_request_error', code: '400' } }).error.outcome,
    'outcome_unknown',
  );
  assert.equal(
    projectResponse(401, { error: { type: 'unknown_error' } }).error.outcome,
    'outcome_unknown',
  );
  assert.deepEqual(projectTransport(new Error('raw private error'), { dispatched: false }), {
    ok: false,
    error: { code: 'CALL_NOT_DISPATCHED', outcome: 'definitely_failed', message: '模型请求未发送' },
  });
  for (const service of ['gateway', 'safe-gateway']) {
    const container = (await compose(['ps', '-q', service])).stdout.trim();
    const logs = await command('docker', ['logs', container]);
    const raw = logs.stdout + logs.stderr;
    report.exposure[service] = unsafeSummary(raw);
    await writeFile(path.join(output, `${service}.log`), sanitize(raw), { mode: 0o600 });
  }
  const safeSummary = report.exposure['safe-gateway'];
  assert.ok(
    Object.values(safeSummary).every((flag) => !flag),
    '安全 Gateway 日志配置仍输出受保护字段',
  );
  report.exposure.responses = unsafeSummary(
    rawObservations.map((row) => row.raw + JSON.stringify(row.headers)).join('\n'),
  );
  report.exposure.operations = unsafeSummary(JSON.stringify(operationLogs));
  assert.ok(
    Object.values(report.exposure.operations).every((flag) => !flag),
    '平台运维投影出现非允许字段',
  );
  check('成功 / 失败投影及平台日志 allowlist、安全 Gateway 日志配置通过');
  assert.equal(repeated, false, '固定 Gateway 配置未满足单次 invocation 最多一次上游生成请求');
  report.decision = 'GO';
} catch (error) {
  report.decision = 'NO-GO';
  report.failure = sanitize(error instanceof Error ? error.message : '验证失败');
  process.exitCode = 1;
  if (composeArguments) {
    const logs = await compose(['logs', '--no-color', '--tail', '120'], { allowFailure: true });
    await writeFile(path.join(output, 'failure.log'), sanitize(logs.stdout + logs.stderr), {
      mode: 0o600,
    });
  }
} finally {
  if (composeArguments) {
    const cleanup = await compose(['down', '--volumes', '--remove-orphans'], {
      allowFailure: true,
    });
    if (cleanup.code !== 0) {
      report.cleanupFailure = sanitize(cleanup.stderr);
      process.exitCode = 1;
    }
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(
    path.join(output, 'result.json'),
    sanitize(JSON.stringify(report, null, 2)) + '\n',
    { mode: 0o600 },
  );
  console.log(`L2 ${report.decision}；脱敏结果：${path.join(output, 'result.json')}`);
  if (report.failure) console.error(report.failure);
}
