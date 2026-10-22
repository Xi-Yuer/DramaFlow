import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const b1 = path.resolve(directory, '../bifrost-b1');
const lock = JSON.parse(await readFile(path.join(b1, 'image.lock.json'), 'utf8'));
const fixture = JSON.parse(await readFile(path.join(b1, 'fixture-image.lock.json'), 'utf8'));
const audit = JSON.parse(await readFile(path.join(directory, 'source-audit.json'), 'utf8'));
const batch = randomBytes(8).toString('hex');
const project = `dramaflow-b11-${batch}`;
const temporary = await mkdtemp(path.join(tmpdir(), project));
const output = path.resolve(directory, '../../.local/bifrost-b11', batch);
await mkdir(output, { recursive: true, mode: 0o700 });
const gatewayKey = `sk-bf-b11-${randomBytes(24).toString('hex')}`;
const providerKey = `sk-b11-provider-${randomBytes(24).toString('hex')}`;
const report = {
  executedAt: new Date().toISOString(),
  version: lock.version,
  image: lock.image,
  transportTestsExecuted: false,
  transportTestReason:
    '固定 Gateway 未暴露 fasthttp 正式控制入口；依照范围不重复 B1 transport 用例',
  authentication: null,
  decision: 'NO-GO',
};
let composeArgs;

async function command(executable, args, input, allowFailure = false) {
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
  if (result.code !== 0 && !allowFailure) throw new Error(`${executable} 退出 ${result.code}`);
  return result;
}
const compose = (args, allowFailure = false) =>
  command('docker', [...composeArgs, ...args], undefined, allowFailure);

try {
  const image = JSON.parse((await command('docker', ['image', 'inspect', lock.image])).stdout)[0];
  assert.equal(image.Id, lock.configDigests[`${image.Os}/${image.Architecture}`]);
  report.imageConfig = image.Id;
  const files = [
    'run.mjs',
    'compose.yaml',
    'upstream.py',
    'auth_probe.py',
    'source-audit.json',
    '../bifrost-b1/config.json',
    '../bifrost-b1/image.lock.json',
    '../bifrost-b1/fixture-image.lock.json',
    '../bifrost-b1/result.json',
  ];
  report.fixtureSha256 = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(path.join(directory, file)))
          .digest('hex'),
      ]),
    ),
  );
  report.sourceAuditSha256 = report.fixtureSha256['source-audit.json'];
  const historical = JSON.parse(await readFile(path.join(b1, 'result.json'), 'utf8'));
  // 仅引用已完成 B1 记录，不重新 dispatch normal / EOF / TCP RST。
  report.historicalTransportEvidence = ['openai', 'anthropic'].flatMap((protocol) =>
    ['success', 'reset', 'tcp-rst'].map((scenario) => {
      const row = historical.matrix.find(
        (value) =>
          value.protocol === protocol && value.scenario === scenario && value.generationPosts > 0,
      );
      assert.ok(row);
      return {
        protocol,
        scenario,
        id: row.id,
        gatewayStatus: row.gatewayStatus,
        generationPosts: row.generationPosts,
        source: '../bifrost-b1/result.json',
        executedAt: historical.executedAt,
      };
    }),
  );
  assert.equal(audit.gatewayControlExposed, false);
  const config = JSON.parse(await readFile(path.join(b1, 'config.json'), 'utf8'));
  for (const key of ['pricing_url', 'model_parameters_url'])
    config.framework.pricing[key] = config.framework.pricing[key].replace('/experiment/', '/b1/');
  config.providers = { openai: config.providers.openai };
  config.providers.openai.network_config.base_url = 'http://upstream:8081';
  config.governance.virtual_keys[0].value = 'env.B11_GATEWAY_KEY';
  config.governance.virtual_keys[0].provider_configs =
    config.governance.virtual_keys[0].provider_configs.filter(
      (value) => value.provider === 'openai',
    );
  config.setup_token = 'env.B11_GATEWAY_KEY';
  await writeFile(path.join(temporary, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const env = path.join(temporary, 'compose.env');
  await writeFile(
    env,
    `B11_IMAGE=${lock.image}\nB11_FIXTURE_IMAGE=${fixture.image}\nB11_GATEWAY_KEY=${gatewayKey}\nB11_TEMP=${temporary}\n`,
    { mode: 0o600 },
  );
  composeArgs = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    env,
    '-f',
    path.join(directory, 'compose.yaml'),
  ];
  await compose(['up', '-d', '--pull', 'never']);
  const container = (await compose(['ps', '-q', 'upstream'])).stdout.trim();
  report.authentication = JSON.parse(
    (
      await command(
        'docker',
        ['exec', '-i', container, 'python', '/experiment/auth_probe.py'],
        JSON.stringify({ providerKey }),
      )
    ).stdout,
  );
  assert.deepEqual(
    report.authentication.cases.map((row) => [row.case, row.gatewayStatus, row.generationPosts]),
    [
      ['missing', 400, 0],
      ['empty', 200, 1],
      ['invalid', 401, 0],
    ],
  );
  report.completed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : '实验失败';
} finally {
  if (composeArgs) {
    const down = await compose(['down', '--volumes', '--remove-orphans'], true);
    if (down.code !== 0) report.cleanupFailure = '测试 Compose 清理失败';
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`B1.1 ${report.decision}: ${path.join(output, 'result.json')}`);
  if (report.failure) console.error(report.failure);
  process.exitCode = 1;
}
