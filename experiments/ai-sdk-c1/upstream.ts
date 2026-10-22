import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export type Protocol = 'openai' | 'anthropic';
export interface CaseDefinition {
  id: string;
  protocol: Protocol;
  status: 200 | 307 | 308;
  prompt: string;
  system: string;
}
export interface WireRecord {
  id: string;
  target: boolean;
  method: string | undefined;
  path: string;
  credentialFingerprint: string;
  authorizationPresent: boolean;
  apiKeyPresent: boolean;
  anthropicVersion: string | undefined;
  model: string;
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  bodyKeys: string[];
  bodySha256: string;
  promptMatches: boolean;
  systemMatches: boolean;
  streaming: boolean;
}
const bodySchema = z.object({
  model: z.string(),
  messages: z.array(z.unknown()),
  system: z.unknown().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
});
const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

export async function createOracle() {
  const cases = new Map<string, CaseDefinition>();
  const records: WireRecord[] = [];
  const failures: string[] = [];

  async function handle(request: IncomingMessage, response: ServerResponse, target: boolean) {
    const route = request.url ?? '';
    const id = route.split('/')[2];
    const definition = id === undefined ? undefined : cases.get(id);
    if (!definition) throw new Error('C1_UNKNOWN_CASE');
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const raw = Buffer.concat(chunks).toString();
    const body: unknown = JSON.parse(raw);
    const value = bodySchema.parse(body);
    const authorization = request.headers.authorization;
    const apiKey = request.headers['x-api-key'];
    const credential =
      typeof apiKey === 'string' ? apiKey : (authorization?.replace(/^Bearer /, '') ?? '');
    records.push({
      id: definition.id,
      target,
      method: request.method,
      path: route,
      credentialFingerprint: fingerprint(credential),
      authorizationPresent: authorization !== undefined,
      apiKeyPresent: apiKey !== undefined,
      anthropicVersion:
        typeof request.headers['anthropic-version'] === 'string'
          ? request.headers['anthropic-version']
          : undefined,
      model: value.model,
      maxOutputTokens: value.max_completion_tokens ?? value.max_tokens,
      temperature: value.temperature,
      bodyKeys: Object.keys(z.record(z.string(), z.unknown()).parse(body)).sort(),
      bodySha256: createHash('sha256').update(raw).digest('hex'),
      promptMatches: raw.includes(definition.prompt),
      systemMatches: raw.includes(definition.system),
      streaming: value.stream === true,
    });
    response.setHeader('Content-Type', 'application/json');
    if (!target && definition.status !== 200) {
      response.writeHead(definition.status, {
        Location: `${targetOrigin}/target/${definition.id}`,
      });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'C1 redirect response' },
        }),
      );
      return;
    }
    const output = `C1-output-${definition.id}`;
    response.writeHead(200);
    response.end(
      JSON.stringify(
        definition.protocol === 'openai'
          ? {
              id: definition.id,
              object: 'chat.completion',
              created: 1,
              model: value.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: output },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
            }
          : {
              id: definition.id,
              type: 'message',
              role: 'assistant',
              model: value.model,
              content: [{ type: 'text', text: output }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 2, output_tokens: 3 },
            },
      ),
    );
  }

  const server = (target: boolean) =>
    createServer((request, response) => {
      void handle(request, response, target).catch((error) => {
        failures.push(error instanceof Error ? error.name : 'UnknownError');
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  const sourceServer = server(false),
    targetServer = server(true);
  const listen = async (instance: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
    const address = instance.address();
    if (!address || typeof address === 'string') throw new Error('C1_ORACLE_ADDRESS_INVALID');
    return `http://127.0.0.1:${address.port}`;
  };
  const sourceOrigin = await listen(sourceServer);
  const targetOrigin = await listen(targetServer);
  return {
    cases,
    records,
    failures,
    sourceOrigin,
    async close() {
      await Promise.all(
        [sourceServer, targetServer].map(
          (instance) =>
            new Promise<void>((resolve, reject) => {
              instance.close((error) => (error ? reject(error) : resolve()));
              instance.closeAllConnections();
            }),
        ),
      );
    },
  };
}
