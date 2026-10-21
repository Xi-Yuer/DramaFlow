import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(directory, 'image.lock.json'), 'utf8'));
const nonce = randomBytes(8).toString('hex');
const project = `dramaflow-l1-${nonce}`;
const temporary = await mkdtemp(path.join(tmpdir(), `${project}-`));
const output = path.resolve(directory, '../../.local/litellm-l1', nonce);
await mkdir(output, { recursive: true, mode: 0o700 });
const gatewayKey = `sk-l1-gateway-${randomBytes(32).toString('hex')}`;
const credentials = Object.fromEntries(
  ['a', 'b'].map((account) => [
    account,
    `sk-l1-provider-${account}-${randomBytes(24).toString('hex')}`,
  ]),
);
const rotated = `sk-l1-provider-a-${randomBytes(24).toString('hex')}`;
const secretValues = [gatewayKey, ...Object.values(credentials), rotated];
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const sanitize = (value) =>
  secretValues.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value));
const report = {
  version: lock.version,
  image: lock.image,
  platform: null,
  executedAt: new Date().toISOString(),
  checks: [],
  exposure: {},
  limitations: [
    '仅验证本地合成 OpenAI / Anthropic 协议；没有调用真实收费模型。',
    '请求级凭证及无数据库结论只覆盖固定镜像和已测试渠道，不代表完整 IAM / OAuth 支持。',
    '行为隔离、文件检查和缓存观察不能证明进程内凭证字符串被立即擦除。',
  ],
};
let composeArguments;

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
    throw new Error(
      sanitize(`${executable} ${args.slice(0, 3).join(' ')} 失败：${stderr.slice(-1800)}`),
    );
  return { stdout, stderr, code };
}
const compose = (args, options) => command('docker', [...composeArguments, ...args], options);
function check(name, evidence = {}) {
  report.checks.push({ name, passed: true, ...evidence });
  console.log(`通过：${name}`);
}
async function port(container, internalPort) {
  const { stdout } = await command('docker', ['port', container, `${internalPort}/tcp`]);
  const match = stdout.match(/127\.0\.0\.1:(\d+)/);
  assert.ok(match, '测试服务必须仅绑定 loopback');
  return `http://127.0.0.1:${match[1]}`;
}
async function waitFor(url) {
  const deadline = Date.now() + 150_000;
  let lastStatus = '尚未连接';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = error instanceof Error ? error.name : '连接异常';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`隔离测试服务未在 150 秒内就绪，最后状态：${lastStatus}`);
}
const expected = new Map();
const responseSnapshots = [];
let repeatedSuccesses = 0;
function payload(protocol, account, prompt, key = credentials[account]) {
  return {
    model:
      protocol === 'openai' ? 'openai/l1-custom-model' : 'anthropic/claude-3-5-sonnet-20241022',
    messages: [
      { role: 'system', content: 'L1 synthetic system' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.25,
    max_tokens: 64,
    stream: false,
    api_base: `http://upstream:8080/${protocol}/${account}${protocol === 'openai' ? '/v1' : ''}`,
    ...(key === undefined ? {} : { api_key: key }),
  };
}
async function invoke(base, body, auth = gatewayKey) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const result = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text,
    value,
  };
  responseSnapshots.push(result);
  return result;
}
async function success(base, protocol, account, prompt, key = credentials[account]) {
  expected.set(prompt, { protocol, account, key });
  const response = await invoke(base, payload(protocol, account, prompt, key));
  assert.equal(
    response.status,
    200,
    `统一调用失败：${protocol}/${account} HTTP ${response.status}`,
  );
  assert.equal(
    response.value?.choices?.[0]?.message?.content,
    `${protocol}:${account}:${prompt}`,
    '统一响应转换错误',
  );
  return response;
}
async function records(base) {
  const response = await fetch(`${base}/__records`);
  assert.equal(response.status, 200, '本地上游记录不可读');
  return response.json();
}
function inspectRecords(rows) {
  const seen = new Map();
  for (const row of rows) {
    const item = expected.get(row.prompt);
    if (!item) continue;
    assert.equal(row.protocol, item.protocol, '协议串用');
    assert.equal(row.account, item.account, 'endpoint 串用');
    assert.equal(row.credential, item.key, '凭证串用');
    assert.notEqual(row.credential, gatewayKey, '网关认证泄漏给上游');
    assert.equal(row.body.temperature, 0.25, 'temperature 未传递');
    assert.equal(row.body.max_tokens, 64, 'max_tokens 未传递');
    assert.equal(row.body.api_key, undefined, '凭证被混入上游业务 body');
    if (row.protocol === 'anthropic') {
      assert.equal(row.path, `/anthropic/${item.account}/v1/messages`, '未转换 Anthropic endpoint');
      assert.ok(row.anthropicVersion, '缺少 Anthropic version header');
      assert.equal(row.authorization, null, 'Anthropic 错误使用 OpenAI Authorization');
      assert.ok(row.body.system, '未转换 Anthropic system 字段');
      assert.equal(row.body.model, 'claude-3-5-sonnet-20241022', '模型路由前缀未移除');
    } else {
      assert.equal(
        row.path,
        `/openai/${item.account}/v1/chat/completions`,
        'OpenAI endpoint 映射错误',
      );
      assert.equal(row.body.model, 'l1-custom-model', '自定义模型名被替换');
    }
    seen.set(row.prompt, (seen.get(row.prompt) ?? 0) + 1);
  }
  for (const prompt of expected.keys())
    assert.equal(seen.get(prompt), 1, '成功调用未到达上游或被缓存 / 重复发送');
}
async function logs(container, filename) {
  const result = await command('docker', ['logs', container]);
  const raw = result.stdout + result.stderr;
  // 原始日志仅存在于本进程；落盘和失败输出均先替换测试 Secret。
  await writeFile(path.join(output, filename), sanitize(raw), { mode: 0o600 });
  return {
    providerCredential: [...Object.values(credentials), rotated].some((secret) =>
      raw.includes(secret),
    ),
    gatewayCredential: raw.includes(gatewayKey),
    endpoint: raw.includes('http://upstream:8080/'),
    syntheticPrompt: raw.includes('debug-openai') || raw.includes('debug-anthropic'),
    maskedCredentialField: /(?:api_key|Authorization).{0,40}(?:REDACTED|\*\*)/.test(raw),
  };
}

try {
  const inspected = await command('docker', ['image', 'inspect', lock.image], {
    allowFailure: true,
  });
  let image = lock.image;
  if (inspected.code !== 0) {
    const tagged = await command('docker', ['image', 'inspect', lock.tag], { allowFailure: true });
    if (tagged.code !== 0) throw new Error(`请先拉取固定镜像：docker pull ${lock.image}`);
    const info = JSON.parse(tagged.stdout)[0];
    const platform = `${info.Os}/${info.Architecture}`;
    assert.equal(
      info.Id,
      lock.configDigests[platform],
      '本地导入镜像不匹配已固定的 OCI config digest',
    );
    image = info.Id;
    report.localVerifiedImport = true;
  }
  const imageInfo = JSON.parse((await command('docker', ['image', 'inspect', image])).stdout)[0];
  report.platform = `${imageInfo.Os}/${imageInfo.Architecture}`;
  report.platformManifest = lock.platforms[report.platform];
  report.imageConfig = imageInfo.Id;
  report.fixtureSha256 = Object.fromEntries(
    await Promise.all(
      [
        'compose.yaml',
        'config.yaml',
        'run.mjs',
        'upstream.py',
        'relay.py',
        'cache_observer.py',
      ].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(path.join(directory, name)))
          .digest('hex'),
      ]),
    ),
  );
  const environmentFile = path.join(temporary, 'compose.env');
  const cacheConfig = path.join(temporary, 'cache-config.yaml');
  const sourceConfig = await readFile(path.join(directory, 'config.yaml'), 'utf8');
  await writeFile(
    cacheConfig,
    sourceConfig.replace('  callbacks: []', '  callbacks: [cache_observer.observer]'),
    { mode: 0o600 },
  );
  await writeFile(
    environmentFile,
    `L1_GATEWAY_IMAGE=${image}\nL1_GATEWAY_KEY=${gatewayKey}\nL1_CACHE_CONFIG=${cacheConfig}\n`,
    { mode: 0o600 },
  );
  composeArguments = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    environmentFile,
    '-f',
    path.join(directory, 'compose.yaml'),
  ];
  await compose(['up', '-d', '--pull', 'never']);
  let gateway = (await compose(['ps', '-q', 'gateway'])).stdout.trim();
  const relay = (await compose(['ps', '-q', 'relay'])).stdout.trim();
  const networkState = JSON.parse((await command('docker', ['inspect', gateway])).stdout)[0];
  const gatewayNetworks = Object.keys(networkState.NetworkSettings.Networks);
  assert.equal(gatewayNetworks.length, 1, 'Gateway 不应连接外网测试入口网络');
  const networkInfo = JSON.parse(
    (await command('docker', ['network', 'inspect', gatewayNetworks[0]])).stdout,
  )[0];
  assert.equal(networkInfo.Internal, true, 'Gateway 测试网络必须无外网出口');
  const gatewayURL = await port(relay, 4000);
  const upstreamURL = await port(relay, 8080);
  await Promise.all([
    waitFor(`${gatewayURL}/health/liveliness`),
    waitFor(`${upstreamURL}/__health`),
  ]);
  const versionProbe = await compose([
    'exec',
    '-T',
    'gateway',
    'python',
    '-c',
    'import importlib.metadata,json,os; print(json.dumps({"version":importlib.metadata.version("litellm"),"databaseConfigured":bool(os.environ.get("DATABASE_URL")),"redisConfigured":bool(os.environ.get("REDIS_URL")),"providerEnvironmentNames":[k for k in os.environ if k.endswith("API_KEY") or k in ["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"]]}))',
  ]);
  const runtime = JSON.parse(versionProbe.stdout);
  assert.equal(runtime.version, lock.version, '容器包版本与锁文件不一致');
  assert.equal(runtime.databaseConfigured, false, '实验不得连接数据库');
  assert.equal(runtime.redisConfigured, false, '实验不得连接 Redis');
  assert.deepEqual(runtime.providerEnvironmentNames, [], '实验不得配置默认厂商凭证');
  check('固定版本、独立网络、无数据库与无默认厂商凭证', runtime);

  const authentication = [];
  for (const [variant, auth] of [
    ['missing', null],
    ['incorrect', 'sk-l1-wrong-gateway'],
    ['provider-as-gateway', credentials.a],
  ]) {
    const result = await invoke(gatewayURL, payload('openai', 'a', 'unauthorized'), auth);
    authentication.push({ variant, status: result.status });
    assert.ok(
      [400, 401, 403].includes(result.status),
      `Gateway 未拒绝认证错误：HTTP ${result.status}`,
    );
  }
  assert.equal((await records(upstreamURL)).requests.length, 0, '网关认证失败仍请求了上游');
  check('缺失、错误或厂商凭证均不能充当 Gateway Credential', { authentication });

  await success(gatewayURL, 'openai', 'a', 'protocol-openai');
  await success(gatewayURL, 'anthropic', 'b', 'protocol-anthropic');
  check('同一 Chat Completions 入口转换 OpenAI 与原生 Anthropic 协议');

  const jobs = [];
  for (const protocol of ['openai', 'anthropic'])
    for (const account of ['a', 'b'])
      for (let i = 0; i < 12; i++)
        jobs.push(success(gatewayURL, protocol, account, `concurrent-${protocol}-${account}-${i}`));
  await Promise.all(jobs);
  inspectRecords((await records(upstreamURL)).requests);
  check('48 个并发请求的 credential、endpoint、模型及参数逐条隔离', {
    concurrentRequests: jobs.length,
  });

  const repeated = [
    ['a', credentials.a],
    ['a', credentials.a],
    ['b', credentials.b],
    ['a', rotated],
  ];
  for (const [account, key] of repeated) {
    const response = await invoke(
      gatewayURL,
      payload('openai', account, 'identical-cache-probe', key),
    );
    assert.equal(response.status, 200, '相同 prompt 的隔离请求失败');
    assert.equal(
      response.value?.choices?.[0]?.message?.content,
      `openai:${account}:identical-cache-probe`,
      '相同 prompt 复用了其他账户结果',
    );
    repeatedSuccesses++;
  }
  const repeatedRows = (await records(upstreamURL)).requests.filter(
    (row) => row.prompt === 'identical-cache-probe',
  );
  assert.equal(repeatedRows.length, repeated.length, '相同输入被 response cache 吞掉');
  for (let i = 0; i < repeated.length; i++) {
    assert.equal(repeatedRows[i].account, repeated[i][0], '相同 prompt 的 endpoint 串用');
    assert.equal(repeatedRows[i].credential, repeated[i][1], '相同 prompt 的 credential 串用');
  }
  check('相同模型 / prompt 的重复调用、跨账户和新凭证均真实到达上游', {
    requests: repeatedRows.length,
  });

  for (const protocol of ['openai', 'anthropic']) {
    const body = payload(protocol, 'a', `missing-credential-${protocol}`);
    delete body.api_key;
    const result = await invoke(gatewayURL, body);
    assert.ok(result.status >= 400, '缺失凭证时复用了上一请求凭证');
  }
  const missingRows = (await records(upstreamURL)).requests.filter((row) =>
    row.prompt.startsWith('missing-credential-'),
  );
  assert.ok(
    missingRows.every((row) => !secretValues.includes(row.credential)),
    '缺失凭证请求复用了已有 Secret',
  );
  check('后续省略 Provider Credential 不会复用此前凭证', { upstreamRequests: missingRows.length });

  await success(gatewayURL, 'openai', 'a', 'rotated-a', rotated);
  await success(gatewayURL, 'openai', 'a', 'original-a', credentials.a);
  await success(gatewayURL, 'openai', 'b', 'original-b', credentials.b);
  const forbidden = payload('openai', 'a', 'forbidden-endpoint');
  forbidden.api_base = 'http://upstream:8080/not-allowed/v1';
  const rejected = await invoke(gatewayURL, forbidden);
  assert.ok([400, 401, 403].includes(rejected.status), 'endpoint allowlist 未在网关拒绝请求');
  assert.ok(
    rejected.text.includes('api_base is not allowed'),
    '不能将上游 404 冒充 endpoint 策略生效',
  );
  assert.equal(
    (await records(upstreamURL)).requests.filter((row) => row.prompt === 'forbidden-endpoint')
      .length,
    0,
  );
  assert.deepEqual(
    (await records(upstreamURL)).unexpectedRequests,
    [],
    '禁止的 endpoint 实际到达上游',
  );
  check('请求级轮换、自定义 OpenAI 模型 / endpoint 和 endpoint 范围限制', {
    endpointRejectionStatus: rejected.status,
  });

  const normal = responseSnapshots.filter((response) => response.status === 200);
  report.exposure.normalResponses = {
    providerCredential: normal.some((response) =>
      [...Object.values(credentials), rotated].some((key) =>
        JSON.stringify(response).includes(key),
      ),
    ),
    gatewayCredential: normal.some((response) => JSON.stringify(response).includes(gatewayKey)),
    endpointHeaderNames: [
      ...new Set(
        normal.flatMap((response) =>
          Object.entries(response.headers)
            .filter(([, value]) => value.includes('upstream:8080'))
            .map(([key]) => key),
        ),
      ),
    ],
  };
  report.exposure.normalLogs = await logs(gateway, 'gateway-normal.log');
  assert.equal(
    report.exposure.normalResponses.providerCredential,
    false,
    '正常响应泄漏 Provider Credential',
  );
  assert.equal(
    report.exposure.normalResponses.gatewayCredential,
    false,
    '正常响应泄漏 Gateway Credential',
  );
  assert.equal(
    report.exposure.normalLogs.providerCredential,
    false,
    '普通日志泄漏 Provider Credential',
  );
  assert.equal(
    report.exposure.normalLogs.gatewayCredential,
    false,
    '普通日志泄漏 Gateway Credential',
  );

  for (const protocol of ['openai', 'anthropic']) {
    const response = await invoke(gatewayURL, payload(protocol, 'a', `reflect-error-${protocol}`));
    assert.ok(response.status >= 400, '反射错误测试未触发失败');
    report.exposure[`${protocol}UpstreamError`] = {
      status: response.status,
      providerCredentialInResponse: response.text.includes(credentials.a),
      endpointInResponse: response.text.includes(`/${protocol}/a/`),
    };
  }
  report.exposure.errorLogs = await logs(gateway, 'gateway-errors.log');
  check('完成正常响应、默认日志与上游反射错误的暴露检查', report.exposure);

  const diff = (await command('docker', ['diff', gateway])).stdout;
  const candidates = diff
    .split('\n')
    .filter((line) => /^[AC] /.test(line))
    .map((line) => line.slice(2));
  const diskScan = await command(
    'docker',
    [
      'exec',
      '-i',
      gateway,
      'python',
      '-c',
      'import sys,json,pathlib; d=json.load(sys.stdin); files=[]; hits=[]\nfor name in d["paths"]:\n p=pathlib.Path(name)\n if p.is_file() and not p.is_symlink() and p.stat().st_size < 67108864:\n  files.append(name)\n  b=p.read_bytes()\n  if any(s.encode() in b for s in d["secrets"]): hits.append(name)\nprint(json.dumps({"scannedFiles":len(files),"credentialFiles":hits}))',
    ],
    { input: JSON.stringify({ paths: candidates, secrets: secretValues }) },
  );
  report.persistence = JSON.parse(diskScan.stdout);
  assert.deepEqual(report.persistence.credentialFiles, [], '容器变更文件出现测试凭证');
  check('容器新增 / 修改文件未检出合成 credential', report.persistence);

  await compose(['up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'gateway']);
  gateway = (await compose(['ps', '-q', 'gateway'])).stdout.trim();
  await waitFor(`${gatewayURL}/health/liveliness`);
  await success(gatewayURL, 'openai', 'b', 'after-recreate-openai');
  await success(gatewayURL, 'anthropic', 'a', 'after-recreate-anthropic');
  check('全新 Gateway 容器无需模型或 credential 同步即可继续调用');

  await compose(['up', '-d', '--pull', 'never', 'gateway-debug']);
  const debugName = (await compose(['ps', '-q', 'gateway-debug'])).stdout.trim();
  const debugURL = await port(relay, 4001);
  await waitFor(`${debugURL}/health/liveliness`);
  await success(debugURL, 'openai', 'a', 'debug-openai');
  await success(debugURL, 'anthropic', 'b', 'debug-anthropic');
  report.exposure.debugLogs = await logs(debugName, 'gateway-debug.log');
  check('实际运行 detailed_debug 并记录 Secret / endpoint 暴露结果', report.exposure.debugLogs);

  await compose(['up', '-d', '--pull', 'never', 'gateway-cache']);
  const cacheURL = await port(relay, 4002);
  await waitFor(`${cacheURL}/health/liveliness`);
  await success(cacheURL, 'openai', 'a', 'cache-observer-a');
  await success(cacheURL, 'openai', 'b', 'cache-observer-b');
  await success(cacheURL, 'anthropic', 'a', 'cache-observer-anthropic');
  const observationDeadline = Date.now() + 10_000;
  let observations = [];
  while (Date.now() < observationDeadline) {
    observations = (await records(upstreamURL)).observations;
    if (observations.length >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(observations.length >= 3, '独立 Gateway 缓存探针未返回实际观察');
  report.clientCache = observations;
  for (const snapshot of observations) {
    assert.equal(snapshot.databaseClientPresent, false, '运行中 Gateway 建立了数据库 client');
    assert.deepEqual(
      snapshot.configuredModels.sort(),
      ['anthropic/*', 'openai/*'],
      '请求创建了额外共享模型配置',
    );
    assert.equal(
      snapshot.configuredProviderCredentialPresent,
      false,
      '请求凭证写入了共享 Router 配置',
    );
    assert.equal(
      snapshot.globalProviderCredentialPresent,
      false,
      '请求修改了全局 Provider Credential',
    );
  }
  check('独立 callback 探针观察 Gateway 实际内存 client cache', {
    snapshots: observations.length,
    credentialReferenceObserved: observations.some((item) => item.credentialReferences.length > 0),
  });

  const all = (await records(upstreamURL)).requests;
  inspectRecords(all);
  report.upstream = {
    totalRequests: all.length,
    expectedSuccessRequests: expected.size + repeatedSuccesses,
    credentialFingerprints: Object.fromEntries(
      Object.entries(credentials).map(([key, value]) => [key, fingerprint(value)]),
    ),
    records: all.map((row) => ({
      protocol: row.protocol,
      account: row.account,
      path: row.path,
      prompt: row.prompt,
      credentialFingerprint: fingerprint(row.credential),
      model: row.body.model,
      temperature: row.body.temperature,
      maxTokens: row.body.max_tokens,
    })),
  };
  report.decision = 'GO';
} catch (error) {
  report.decision = 'NO-GO';
  report.failure = sanitize(error instanceof Error ? error.message : '未知验证失败');
  if (composeArguments) {
    const failedLogs = await compose(['logs', '--no-color', '--tail', '100', 'gateway'], {
      allowFailure: true,
    });
    await writeFile(
      path.join(output, 'gateway-failure.log'),
      sanitize(failedLogs.stdout + failedLogs.stderr),
      { mode: 0o600 },
    );
  }
  process.exitCode = 1;
} finally {
  if (composeArguments) {
    const cleanup = await compose(
      ['--profile', 'diagnostics', 'down', '--volumes', '--remove-orphans'],
      {
        allowFailure: true,
      },
    );
    if (cleanup.code !== 0) {
      report.cleanupFailure = sanitize(cleanup.stderr.slice(-1000));
      process.exitCode = 1;
    }
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(
    path.join(output, 'result.json'),
    sanitize(JSON.stringify(report, null, 2)) + '\n',
    { mode: 0o600 },
  );
  console.log(`L1 ${report.decision}；脱敏结果：${path.join(output, 'result.json')}`);
  if (report.failure) console.error(report.failure);
}
