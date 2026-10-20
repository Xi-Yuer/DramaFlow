import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import pg from 'pg';

const schema = 'langgraph';
const probeConfig = { configurable: { thread_id: '__dramaflow_checkpoint_probe__' } };

function unavailable(cause?: unknown): ServiceUnavailableException {
  return new ServiceUnavailableException(
    { code: 'WORKFLOW_CHECKPOINT_UNAVAILABLE', message: '工作流 Checkpoint 尚未就绪' },
    { cause },
  );
}

// API / Worker 各持有一个应用级实例；实际 checkpoint 表、序列化和 pending writes 归官方 Saver。
@Injectable()
export class WorkflowCheckpointerService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly instance: PostgresSaver;
  private initialized = false;
  private closed = false;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !URL.canParse(connectionString)) throw unavailable();
    if (!['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
      throw unavailable();
    this.pool = new pg.Pool({
      connectionString,
      application_name: 'dramaflow-checkpointer',
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    this.pool.on('error', () => {
      // 不打印连接配置或原始驱动错误；存活检查仍由真实 Saver 查询决定。
      new Logger(WorkflowCheckpointerService.name).error('Checkpoint PostgreSQL 空闲连接异常');
    });
    this.instance = new PostgresSaver(this.pool, undefined, { schema });
  }

  get saver(): BaseCheckpointSaver {
    if (!this.initialized || this.closed) throw unavailable();
    return this.instance;
  }

  async onModuleInit(): Promise<void> {
    try {
      const lock = await this.pool.connect();
      try {
        await lock.query('BEGIN');
        // 官方 setup 不自带跨实例迁移锁；只串行化其初始化，不实现或复制 checkpoint DDL。
        await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          'dramaflow:langgraph:setup',
        ]);
        await this.instance.setup();
        await this.instance.getTuple(probeConfig);
        await lock.query('COMMIT');
      } finally {
        // 关闭专用连接，失败时也释放事务及锁，不将未结束的事务放回连接池。
        lock.release(true);
      }
      this.initialized = true;
    } catch (cause) {
      let failure = cause;
      try {
        await this.onModuleDestroy();
      } catch (closingError) {
        failure = new AggregateError([cause, closingError], 'Checkpoint 初始化及连接关闭均失败', {
          cause,
        });
      }
      throw unavailable(failure);
    }
  }

  async ping(): Promise<void> {
    const saver = this.saver;
    try {
      // 通过官方读取路径验证 checkpoint / blobs / pending writes，而不只检查 PostgreSQL TCP。
      await saver.getTuple(probeConfig);
    } catch (cause) {
      throw unavailable(cause);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.initialized = false;
    if (this.closed) return;
    this.closed = true;
    await this.instance.end();
  }
}
