# LangGraph Iteration Runtime Experiment

结论：**可以，但需要约束**。`Send + per-invocation body subgraph + PostgresSaver + interrupt` 可以承载逐项执行和跨进程人工审核恢复。当前锁定的 LangGraph.js 1.5.0 存在已实际复现的 `maxConcurrency=1` 缺陷；部分恢复的 pending 投影和嵌套 wrapper 重入也需要明确适配，尚不能直接交付正式 Iteration。

本目录仅为实验，不进入 pnpm workspace、Turbo 生产构建或任何生产依赖。未修改 Workflow Contract、Compiler、Runtime、NodeRun、Prisma Schema、Web、API、根依赖或锁文件；没有调用模型、运行 Browser E2E、执行 Prisma migration 或实现正式 Iteration。

## 环境与复现

最终证据运行于 2026-10-24 10:28:00–10:28:13（Asia/Shanghai），run ID 为 `800f6bc1-88f3-436d-b29a-0359cb74a846`。

| 组件                          | 实际版本            |
| ----------------------------- | ------------------- |
| Node                          | 24.22.1             |
| LangGraph.js                  | 1.5.0               |
| langgraph-checkpoint          | 1.2.0               |
| langgraph-checkpoint-postgres | 1.1.0               |
| PostgreSQL                    | 17.11，项目现有容器 |

依赖从现有 workflow / server 安装位置解析，运行时核对精确版本；实验没有安装或升级依赖。使用与正式服务相同的官方 `PostgresSaver(pg.Pool, undefined, { schema: 'langgraph' })` 路径，不实例化业务模块，也没有自制 Saver。

数据库为本机独立的 `dramaflow_iteration_experiment`，端口 5432，checkpoint schema 为 `langgraph`。脚本只允许本机连接，不能落到业务库；官方 `setup()` 仅初始化实验库的 Saver 存储，没有运行项目迁移。保留实验 checkpoint 供复核；没有清理业务数据。首次运行启动了 Docker 和项目 postgres 服务。

在根目录已有冻结依赖安装、Node 24、PostgreSQL 可用的前提下：

```sh
node experiments/langgraph-iteration-runtime/run.ts
node node_modules/typescript/bin/tsc -p experiments/langgraph-iteration-runtime/tsconfig.json
node node_modules/eslint/bin/eslint.js experiments/langgraph-iteration-runtime/*.ts
```

脚本从被忽略的根 `.env` 读取连接信息，再派生独立实验库；子进程只接收实验库连接，不输出凭证。也可显式提供 `DRAMAFLOW_RUNTIME_EXPERIMENT_DATABASE_URL`，数据库名仍必须是上述实验库。不要在本目录单独安装另一套依赖。

重新运行会更换 thread / task / interrupt ID 并覆盖同名原始证据文件；本报告的具体 ID 和 PID 对应上述已保存运行。汇总保存锁文件及实验源码 SHA-256，可核对对应代码。

## Graph 与测量方式

```text
START → dispatch → Send({index, value, outerIndex}) × N
                    → body wrapper
                        → body subgraph: stepA → [review] → stepB
                    → collect → END
```

- `stepA` 计算 `value * 2`，同步追加一次 `stepA_effect` 到证据 JSONL，模拟可跨进程计数的副作用。
- `stepB` 计算上一步结果加一。节点 delay 随 index 变化，制造不一致的完成顺序。
- `review` 直接调用原生 `interrupt()`，不使用 DramaFlow Human Review。
- body 子图默认 compile，继承父 Saver；wrapper 每次只调用一次子图，并通过公开 `subgraphs` 选项注册，支持递归 `getState`。
- 空集合走显式 collect 路径。结果 reducer 拒绝重复 item，collect 按 index 排序。
- `activeCount` 统计当前正在执行的 item body wrapper，包括子图执行及 checkpoint 等待；interrupt 抛出后减一。它不是“含人工等待的业务在途 item 数”。嵌套用同一 Recorder 观测所有 inner body。
- 事件记录 PID、时间、开始 / 结束、active / peak、item / outer index、taskId、checkpointNs、nodeAttempt。Recorder 只承担观测；item 和 scope 输入均通过原生图状态传递。
- 每个 start、inspect、resume 都启动新的 Node 进程；进程正常退出后才启动下一阶段。没有在进程内保存恢复上下文，没有强杀正在进行的数据库或外部副作用。

## 已验证：基础 Send 与 maxConcurrency

以下 12 个组合均实际使用 PostgresSaver；“完成项数”取 wrapper 完成事件，“输出”取 checkpoint 的有序最终输出。

| items | maxConcurrency | body 峰值 | 完成项数 | 结果             |
| ----- | -------------- | --------- | -------- | ---------------- |
| 0     | 1              | 0         | 0        | 空输出，完成     |
| 1     | 1              | 1         | 1        | 正确，完成       |
| 10    | 1              | 1         | 1        | 异常，仅首项完成 |
| 100   | 1              | 1         | 1        | 异常，仅首项完成 |
| 0     | 2              | 0         | 0        | 空输出，完成     |
| 1     | 2              | 1         | 1        | 正确，完成       |
| 10    | 2              | 2         | 10       | 正确，完成       |
| 100   | 2              | 2         | 100      | 正确，完成       |
| 0     | 5              | 0         | 0        | 空输出，完成     |
| 1     | 5              | 1         | 1        | 正确，完成       |
| 10    | 5              | 5         | 10       | 正确，完成       |
| 100   | 5              | 5         | 100      | 正确，完成       |

所有成功组合均断言无遗漏、无重复、每项 stepA 恰好执行一次、结果为 `2 * index + 1`。10 项 / concurrency=5 的实际完成顺序为 `[3,4,0,1,2,7,5,6,8,9]`；另外两个独立 thread 的完成顺序分别为 `[3,1,4,2,0,5,6,7,8,9]`、`[1,0,2,4,3,5,6,7,9,8]`。三次最终输出均按 `[0,1,...,9]` 排列。

原始记录见 [summary.json](evidence/summary.json)、各 `basic-*.json` 与 `*.events.jsonl`。`harnessStatus=completed` 表示调查场景执行完成，不表示 concurrency=1 正确；汇总单独标记该异常。

### maxConcurrency=1 最小复现与判断

[repro-max-concurrency.ts](repro-max-concurrency.ts) 去掉 subgraph、wrapper、delay、审核和生产 Runtime，只保留两项 Send 及数组 reducer。

```sh
node experiments/langgraph-iteration-runtime/repro-max-concurrency.ts 1 memory
node --env-file=.env experiments/langgraph-iteration-runtime/repro-max-concurrency.ts 1 postgres
```

两种 Saver 均实际得到：

```json
{
  "executed": [0],
  "invokeStatus": "returned",
  "invokeValues": [],
  "checkpointValues": [0],
  "next": ["item"],
  "interrupts": []
}
```

同一最小图改为 2 或 5 后，两种 Saver 均执行 `[0,1]` 并正常结束。[六组原始复现](evidence/minimal-reproductions.json)均已保存；独立 CLI 进程也再次复现了 1 的异常。

判断为 **LangGraph.js 1.5.0 原生 runner 的并发缺陷**。配置在顶层，排除了 nested scope、Postgres 和 DramaFlow 使用方式；不是没有收到 resume，也没有 pending interrupt。实际复现后核对本地 runner，发现续跑条件只看首次启动或仍在执行的任务，未涵盖尚未启动的任务；单个任务结束、执行集合清空后会提前退出，与观测一致。

异常尤其危险的地方是 `invoke` 没有抛错，也不返回 interrupt，但尚未完成。不能把返回成功直接等同图完成，也不能把所有残留 `next/tasks` 自动当成人工等待。本实验没有用额外循环、重复 invoke、改成 concurrency=2 或修改正式 Runtime 来修复 concurrency=1。

## 已验证：Postgres checkpoint 与多个 interrupt

三个 item 全部进入同名 `review` 后，得到三个不同 interrupt；子图 namespace 和 review task identity 也各自不同。

逐项恢复流程的 PID 为：

```text
start 98105 → exit
inspect 98137 → exit
resume A 98138 → exit
resume B 98139 → exit
resume C 98155 → exit
```

新进程仅凭同一 thread 和重新构造的同版本 graph，即读到相同的 task、namespace、interrupt ID 和已完成 stepA 状态。每轮 pending item 的身份均与前一轮深比较一致。一次全量恢复另用 start 98169、inspect 98183、resume 98186，得到相同业务输出。

### Partial Resume 与返回值

| 调用                     | 新完成 item | invoke 返回的 interrupt | 递归叶级 pending | 含父 task 历史的 interrupt 数 | collect         |
| ------------------------ | ----------- | ----------------------- | ---------------- | ----------------------------- | --------------- |
| start                    | 无          | A、B、C                 | 3                | 3                             | 未执行          |
| 仅 resume A              | A           | B、C                    | 2                | 3                             | 未执行          |
| 仅 resume B              | B           | C                       | 1                | 3                             | 未执行          |
| 仅 resume C              | C           | 无                      | 0                | 0                             | 执行，输出 3 项 |
| 独立场景一次 resume 全部 | A、B、C     | 无                      | 0                | 0                             | 执行，输出相同  |

第一次部分恢复的 invoke 正常返回父状态，包含 A 的结果以及 B/C 的 `__interrupt__`；根 `next` 仍为两个 body。未获决策的 review 函数会重入并再次 interrupt，任务身份保持不变；它们不会错误消费 A 的决策。

**与预期不同：`getState(..., {subgraphs:true}).tasks.flatMap(t => t.interrupts)` 不能直接当 pending 列表。** A 已结束的父 task 仍保留旧 interrupt；其子图则明确 `next=[] / tasks=[]`。根 Saver 的 pending writes 也同时保留 A 的旧 interrupt、resume 和成功结果写入。根 task 列表包含已完成 task，不能用 task 数直接计未完成数。

实验观测通过展开子图、读取叶级待执行任务区分真正 pending，同时完整保留未经处理的 snapshot / Saver pending writes。此逻辑只是调查投影，没有驱动调度。正式适配必须以原生任务完成信息建立并验证 pending 投影，不能只过滤一次 invoke 返回值，也不能未经验证推广这段实验提取代码。

### Completed Work Replay

三个普通 item 在逐项恢复及全量恢复中，stepA 的持久计数均为 `{0:1,1:1,2:1}`；stepB 也各执行一次。A 完成后，后续 B/C 的恢复没有重放 A 的 body wrapper。

这些结论覆盖已成功 checkpoint 的节点与正常进程退出，不覆盖“计数副作用刚写完、checkpoint 尚未落盘时进程崩溃”的窗口；没有证明外部 exactly-once。

## 已验证：Nested Scope

两项 outer 各派发两项 inner，四项 inner 均进入同名 review，逐项跨进程恢复至完成。最终四个结果无重复，四项 stepA / stepB 均各执行一次。

有两项额外观测：

1. 根配置 `maxConcurrency=2`，所有 inner body 的合计峰值为 **4**。原生参数作用于各 graph runner，继承配置不会成为跨层共享的 semaphore，也不是全局 Provider 配额。
2. nested 部分恢复时，`outer=0,inner=0` 和 `outer=1,inner=0` 的 item wrapper 完成代码分别运行两次；其他 wrapper 一次。四项 stepA、review 成功决策消费、stepB 仍各一次，最终聚合也没有重复。父 wrapper 重入可能再次执行已完成子图调用周围的代码，因此审计 / 副作用不能放在无幂等保护的 wrapper 尾部。

## Identity Observation

完整映射保存在 [identity-observations.json](evidence/identity-observations.json)。以下为普通场景的实际 ID：

| conceptual item | body task ID                           | review task ID                         | interrupt ID                       |
| --------------- | -------------------------------------- | -------------------------------------- | ---------------------------------- |
| index=0         | `85bfa704-b797-5a88-a105-39bc49990dad` | `a9cf1f71-b148-5726-97c8-27afb3c4162c` | `4feefda370ed7f30b7d7455645322fe7` |
| index=1         | `b58ce2f3-4927-5490-8e14-253df45be808` | `52187276-d1ae-50ee-ba3a-bfea03ebed01` | `d721035efdb27a67dcc86c594bce86bd` |
| index=2         | `aa0a4b03-e889-54fd-bc6d-a1f39bf5f8a1` | `16d61b35-4622-57c1-ac39-cef1814de563` | `e94e2ea5c67355cc745a482a36cc7585` |

以 index=0 为例：

```text
conceptual item index=0
  → body task 85bfa704-b797-5a88-a105-39bc49990dad
  → subgraph checkpoint namespace
    body:85bfa704-b797-5a88-a105-39bc49990dad
  → review task a9cf1f71-b148-5726-97c8-27afb3c4162c
  → review executionInfo.checkpointNs
    body:85bfa704-b797-5a88-a105-39bc49990dad|review:a9cf1f71-b148-5726-97c8-27afb3c4162c
  → interrupt 4feefda370ed7f30b7d7455645322fe7
```

review 的完整 task namespace 与实际保存子图 checkpoint 的 namespace 不同；`taskId`、父 task ID、`interruptId` 也不相等。根 pending write 归属 body task，但 payload 中记录的是 review task。

嵌套时，同一个 inner index 在不同 outer scope 中具有不同的完整路径：

| conceptual item  | 完整 review checkpointNs                        | interrupt ID                              |
| ---------------- | ----------------------------------------------- | ----------------------------------------- |
| outer=0, inner=0 | `outerBody:53d0b8a1-8c27-500e-ab36-f7871e04a1de | body:392a25b5-5505-5a26-b552-b84f657c33d7 | review:ef2c0af4-6f80-55b7-af80-3621d7e37b7a` | `cabf97f4e0dede3d332f7e9b680a1d12` |
| outer=1, inner=0 | `outerBody:3996ed57-08b8-5dca-8e93-8acd8b30ac37 | body:0a064675-2817-51e9-a5cf-046b6a03b146 | review:496958a6-cbb3-5ca9-acdf-15c397c6beb5` | `130d3aff2ebf2d3f314a85916e265aa4` |

| identity              | 本实验确认的稳定范围                                                            | 对领域模型的判断                                                      |
| --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| taskId / checkpointNs | 相同 thread、checkpoint 血缘及相同编译图的跨进程恢复中保持                      | 可作 runtime 映射，不作为跨调用 / 版本的 occurrence 主键              |
| subgraph namespace    | 同一次子图调用在恢复中保持，嵌套可区分                                          | 关联原生持久化位置，不把 namespace 字符串格式固化到 Contract          |
| interruptId           | 未处理的同一 interrupt 在 inspect / 多轮 resume 中保持；全新 thread 产生其他 ID | 定向恢复 token，不代表完整逻辑执行身份，也不表示它仍 pending          |
| nodeAttempt           | 所有观测均为 1，包括 review / wrapper 重入                                      | 不等于函数进入次数；本实验未测试 retry，不能据此决定持久 attempt 规则 |
| index / outerIndex    | 由实验固定输入定义，通过 Send 明确传递                                          | 表达当前输入位置；正式 occurrence 还需要 Run、父 scope 与节点定义身份 |

## 与预期不同及剩余限制

- `maxConcurrency=1` 不是单纯慢速串行，实际提前返回且留有未执行任务。
- 多 interrupt 的定向部分恢复有效，但父 snapshot 和根 pending writes 保留历史 interrupt；简单 flatten 会误报 pending。
- 嵌套的并发上限不是全局上限；wrapper 重入范围大于业务节点重放范围。
- 没有发现 Send 输入串项、子图 namespace 冲突、决策串项或已完成 stepA / stepB 重放。
- 一次探索运行出现 PostgreSQL pool 连接获取超时，invoke 抛错时 checkpoint 已是完成态；保留于 [observed-connection-timeout.json](evidence/observed-connection-timeout.json)。没有自动重试掩盖该结果；随后修订 harness 的观察断言并在新 thread 完整重跑，最终矩阵没有连接错误。不能据此认为基础设施错误与 checkpoint 终态已实现自动对账。
- 没有测试断电 / 强杀提交窗口、收费请求、retry、跨版本图变更、超大集合、取消或长期保留；不推导 exactly-once 或正式 recovery 能力。

## 推荐结论与下一步

**可以，但需要以下约束：**

1. 当前 1.5.0 的 concurrency=1 为阻塞项，须先取得上游修复或经单独评审的依赖方案；本轮不升级、不修补依赖、不在生产 Runtime 写补偿调度循环。
2. body 使用显式局部输入输出和 per-invocation namespace；保持同一 Run 的固定图定义及恢复兼容性。
3. occurrence / attempt 独立建模；wrapper 与审核重入复用身份，不能每进入一次就新增 attempt。
4. pending / completion 根据原生 checkpoint 任务事实投影；支持多个和嵌套 interrupt，不能把残留任务直接标成 waiting review。
5. bounded item concurrency、nested graph task concurrency、Worker 并发与 Provider 配额分别定义。要求全局在途 item 上限时仍需后续验证原生编译表达，不能假定一个根 maxConcurrency 已解决。
6. 副作用与 interrupt 分离，wrapper 周围代码可安全重入，并保留业务审计与 checkpoint 的异常对账边界。

下一步建议先评审 concurrency=1 最小复现和 pending / wrapper 重入观察，再确定依赖处理与 occurrence 身份底座任务。本实验到此停止，不推进正式 Iteration、数据库演进或 UI。

## 证据与验证入口

- [汇总](evidence/summary.json)：12 组基础矩阵、2 次排序复测、6 组最小复现、partial / all / nested 场景、源码和锁文件哈希。
- [原生身份映射](evidence/identity-observations.json)：普通三项和嵌套四项的完整身份。
- `evidence/*-start.json`、`*-resume-*.json`、`*-new-process-inspect.json`：invoke 原始返回、递归 snapshot、Saver 各 namespace head 及 pending writes。
- `evidence/*.events.jsonl`：节点及 wrapper 事件、时间、并发、持久计数和 runtime identity。
- `evidence/*.process.json`：子进程 PID、退出码和标准输出；`*.request.json` 仅含实验参数，不含数据库连接。
- 验证仅覆盖本目录严格 TypeScript、ESLint、格式、JSON / JSONL、报告链接、凭证泄漏检查及 workspace 排除；未运行生产全量检查或 Browser E2E。
