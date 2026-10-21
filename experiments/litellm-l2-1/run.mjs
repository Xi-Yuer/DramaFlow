import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeOnce } from '../litellm-l2/protocol.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(
  await readFile(path.join(directory, '../litellm-l1/image.lock.json'), 'utf8'),
);
const batch = randomBytes(8).toString('hex');
const project = `dramaflow-l21-${batch}`;
const temporary = await mkdtemp(path.join(tmpdir(), project));
const output = path.resolve(directory, '../../.local/litellm-l2-1', batch);
await mkdir(output, { recursive: true, mode: 0o700 });
const gatewayKey = `sk-l21-gateway-${randomBytes(24).toString('hex')}`;
const providerKey = `sk-l21-provider-${randomBytes(24).toString('hex')}`;
const fingerprint = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const sanitize = (text) =>
  String(text).replaceAll(gatewayKey, '[GATEWAY-KEY]').replaceAll(providerKey, '[PROVIDER-KEY]');
const report = {
  version: lock.version,
  image: lock.image,
  executedAt: new Date().toISOString(),
  matrix: [],
  checks: [],
};
let composeArguments;
let oracle;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(executable, args, { allowFailure = false } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0 && !allowFailure)
    throw new Error(sanitize(`${executable} failed: ${result.stderr.slice(-2000)}`));
  return result;
}
const compose = (args, options) => command('docker', [...composeArguments, ...args], options);
async function port(container, internal) {
  const value = JSON.parse((await command('docker', ['inspect', container])).stdout)[0];
  return `http://127.0.0.1:${value.NetworkSettings.Ports[`${internal}/tcp`][0].HostPort}`;
}
async function ready(base, suffix = '/health/liveliness') {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(base + suffix, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    await pause(700);
  }
  throw new Error('实验服务未就绪');
}
async function observation() {
  const response = await fetch(`${oracle}/__records`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}

async function runCase(gateway, mode, protocol, status, relation, profile = false) {
  const id = randomUUID();
  const from =
    relation === 'https-http' || relation === 'https-path'
      ? 'https://upstream:8443'
      : relation === 'default-upgrade'
        ? 'http://upstream:80'
        : 'http://upstream:8080';
  const targetPath = `/target/${id}/${protocol}`;
  const targetOrigin = {
    'same-origin': from,
    'hostname-change': 'http://other-host:8080',
    'port-change': 'http://upstream:8081',
    'cross-origin': 'https://other-host:8443',
    'http-https': 'https://upstream:8443',
    'https-http': 'http://upstream:8080',
    'default-upgrade': 'https://upstream:443',
  }[relation];
  const location = targetOrigin ? targetOrigin + targetPath : targetPath;
  const registered = await fetch(`${oracle}/__case`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status, protocol, location }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(registered.status, 200);
  const body = {
    model: `${protocol}/l21-model`,
    api_key: providerKey,
    api_base: `${from}/${id}/${protocol === 'openai' ? 'openai/v1' : 'anthropic'}`,
    messages: [{ role: 'user', content: id }],
    max_tokens: 8,
    stream: false,
    timeout: 3.0,
    num_retries: 0,
    max_retries: 0,
    disable_fallbacks: true,
    drop_params: false,
    modify_params: false,
    ...(profile ? { metadata: { l21_probe: true } } : {}),
  };
  const response = await invokeOnce(`${gateway}/v1/chat/completions`, gatewayKey, body, 8000);
  await pause(profile ? 300 : 30);
  const rows = (await observation()).requests.filter((row) => row.caseId === id);
  const targets = rows.filter((row) => row.target);
  assert.ok(rows.length >= 1, `${mode}/${protocol}/${status}/${relation} 未到达首次 Provider`);
  assert.equal(rows[0].method, 'POST');
  assert.equal(
    protocol === 'openai' ? rows[0].authorizationFingerprint : rows[0].apiKeyFingerprint,
    fingerprint(providerKey),
  );
  const item = {
    id,
    mode,
    protocol,
    providerStatus: status,
    relation,
    gatewayStatus: response.status,
    errorType: response.value?.error?.type ?? null,
    transportError: response.transportError ?? null,
    bodyPreview: sanitize(response.raw).slice(0, 700),
    projected: response.projected,
    upstreamRequests: rows.length,
    upstreamPosts: rows.filter((row) => row.method === 'POST').length,
    targetRequests: targets.length,
    targetMethods: targets.map((row) => row.method),
    credentialAtTarget: targets.some(
      (row) =>
        row.authorizationFingerprint === fingerprint(providerKey) ||
        row.apiKeyFingerprint === fingerprint(providerKey),
    ),
    bodyRepeated: targets.some((row) => row.bodyBytes > 0 && row.bodySha256 === rows[0].bodySha256),
    records: rows,
  };
  report.matrix.push(item);
  console.log(
    `${mode}/${protocol}/${status}/${relation}: requests=${rows.length}, POST=${item.upstreamPosts}, targetCredential=${item.credentialAtTarget}, Gateway=${response.status}`,
  );
  return item;
}

try {
  let image = lock.image;
  const exact = await command('docker', ['image', 'inspect', image], { allowFailure: true });
  if (exact.code !== 0) {
    const info = JSON.parse((await command('docker', ['image', 'inspect', lock.tag])).stdout)[0];
    assert.equal(info.Id, lock.configDigests[`${info.Os}/${info.Architecture}`]);
    image = info.Id;
  }
  report.imageConfig = JSON.parse(
    (await command('docker', ['image', 'inspect', image])).stdout,
  )[0].Id;
  const fixtures = [
    'compose.yaml',
    'config.yaml',
    'upstream.py',
    'forward.py',
    'relay.py',
    'probe.py',
    'run.mjs',
    'source_audit.py',
    '../litellm-l2/protocol.mjs',
    '../litellm-l2/safe_logging.py',
    '../litellm-l2/logging.json',
  ];
  report.fixtureSha256 = Object.fromEntries(
    await Promise.all(
      fixtures.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(path.join(directory, file)))
          .digest('hex'),
      ]),
    ),
  );
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
    'subjectAltName=DNS:upstream,DNS:other-host',
    '-keyout',
    path.join(temporary, 'server.key'),
    '-out',
    path.join(temporary, 'server.crt'),
  ]);
  const env = path.join(temporary, 'compose.env');
  await writeFile(
    env,
    `L21_IMAGE=${image}\nL21_GATEWAY_KEY=${gatewayKey}\nL21_CERTS=${temporary}\n`,
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
    injected = await port(relay, 4101),
    forward = await port(relay, 4102),
    httpx = await port(relay, 4103);
  oracle = await port(relay, 8080);
  await Promise.all([
    ready(baseline),
    ready(injected),
    ready(forward),
    ready(httpx),
    ready(oracle, '/__health'),
  ]);
  report.sourceAudit = JSON.parse(
    (await compose(['exec', '-T', 'gateway', 'python', '/experiment/source_audit.py'])).stdout,
  );
  assert.equal(report.sourceAudit.versions.litellm, lock.version);
  for (const [mode, gateway] of [
    ['baseline', baseline],
    ['official-openai-session', injected],
    ['ordinary-forward-proxy', forward],
    ['official-httpx-transport', httpx],
  ]) {
    for (const protocol of ['openai', 'anthropic']) {
      const row = await runCase(gateway, mode, protocol, 200, 'path-only', true);
      assert.equal(row.gatewayStatus, 200, '成功对照未通过');
      assert.equal(row.upstreamRequests, 1);
    }
  }
  for (const protocol of ['openai', 'anthropic']) {
    for (const status of [301, 302, 303, 307, 308]) {
      for (const relation of [
        'path-only',
        'same-origin',
        'hostname-change',
        'port-change',
        'cross-origin',
        'http-https',
        'https-http',
        'default-upgrade',
      ]) {
        await runCase(
          baseline,
          'baseline',
          protocol,
          status,
          relation,
          status === 307 && relation === 'path-only',
        );
      }
      await runCase(injected, 'official-openai-session', protocol, status, 'path-only');
      await runCase(
        httpx,
        'official-httpx-transport',
        protocol,
        status,
        'path-only',
        status === 307,
      );
      await runCase(
        forward,
        'ordinary-forward-proxy',
        protocol,
        status,
        'path-only',
        status === 307,
      );
      await runCase(
        forward,
        'ordinary-forward-proxy',
        protocol,
        status,
        'https-path',
        status === 307,
      );
    }
  }
  await pause(500);
  report.observations = (await observation()).observations;
  const proxyTraffic = report.observations.filter((row) => row.kind === 'forward-transport');
  assert.ok(
    proxyTraffic.some((row) => row.method === 'CONNECT'),
    '未证明 HTTPS 流量经过 CONNECT',
  );
  const forwardHttpRows = report.matrix.filter(
    (row) => row.mode === 'ordinary-forward-proxy' && row.relation === 'path-only',
  );
  assert.ok(
    forwardHttpRows.every((row) => proxyTraffic.some((event) => event.target.includes(row.id))),
    '存在绕过 forward proxy 的 HTTP 用例',
  );
  const baselineRows = report.matrix.filter(
    (row) => row.mode === 'baseline' && row.providerStatus !== 200,
  );
  assert.equal(baselineRows.length, 80);
  assert.ok(
    baselineRows.every((row) => row.targetRequests === 1),
    '基线未完整复现重定向',
  );
  const injectedRows = report.matrix.filter(
    (row) => row.mode === 'official-openai-session' && row.providerStatus !== 200,
  );
  assert.ok(
    injectedRows
      .filter((row) => row.protocol === 'openai')
      .every((row) => row.upstreamRequests === 1 && !row.projected.ok),
  );
  assert.ok(
    injectedRows
      .filter((row) => row.protocol === 'anthropic')
      .every((row) => row.targetRequests === 1),
  );
  assert.ok(
    report.matrix
      .filter((row) => row.mode === 'ordinary-forward-proxy' && row.providerStatus !== 200)
      .every((row) => row.targetRequests === 1),
    '普通代理对照没有通过',
  );
  assert.ok(
    report.matrix
      .filter((row) => row.mode === 'official-httpx-transport' && row.providerStatus !== 200)
      .every((row) => row.targetRequests === 1),
  );
  for (const row of baselineRows) {
    assert.equal(row.upstreamPosts, row.providerStatus >= 307 ? 2 : 1);
    const credentialExpected =
      row.protocol === 'anthropic' ||
      ['path-only', 'same-origin', 'default-upgrade'].includes(row.relation);
    assert.equal(row.credentialAtTarget, credentialExpected, 'credential 转发行为发生变化');
    assert.equal(row.bodyRepeated, row.providerStatus >= 307);
  }
  report.checks.push(
    '80 个双协议、跨 origin/TLS 重定向基线已执行',
    '正式 OpenAI session 注入仅覆盖 OpenAI',
    '普通 forward proxy 与 HTTPS CONNECT 均不能阻止客户端第二跳',
    '正式 DISABLE_AIOHTTP_TRANSPORT 仅切换 transport，两协议仍 follow',
  );
  report.decision = 'NO-GO';
  report.blockers = [
    '没有验收到覆盖 OpenAI / 原生 Anthropic 的正式 no-redirect 控制',
    '普通 forward proxy / CONNECT 不改变客户端 redirect 行为',
  ];
} catch (error) {
  report.decision = 'NO-GO';
  report.failure = sanitize(error instanceof Error ? error.stack : '验证失败');
} finally {
  if (composeArguments) {
    const logs = await compose(['logs', '--no-color'], { allowFailure: true });
    await writeFile(path.join(output, 'gateway.log'), sanitize(logs.stdout + logs.stderr), {
      mode: 0o600,
    });
    const down = await compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });
    if (down.code !== 0) report.cleanupFailure = sanitize(down.stderr);
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`L2.1 ${report.decision}: ${path.join(output, 'result.json')}`);
  if (report.failure) console.error(report.failure);
  process.exitCode = report.decision === 'GO' ? 0 : 1;
}
