'use client';

import { useContext, useState } from 'react';
import {
  isIterationNodeManifest,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NodeInputBindingField } from '../inspector/node-input-binding-field';
import panel from '../inspector/workflow-node-inspector.module.css';
import { WorkflowInputContext } from '../inputs/workflow-input-context';
import { resolveWorkflowNodePorts } from '../ports/resolve-workflow-node-ports';
import { DataTypeSelect, GraphInputEditor } from './graph-input-editor';
import styles from './graph-input-editor.module.css';
import {
  addBodyInput,
  addInvariantInput,
  bodyInputSourceOptions,
  formatDataType,
  initializeIterationBody,
  removeBodyInput,
  removeInvariantInput,
  setBodyInputMapping,
  setIterationItemType,
  updateBodyInput,
  updateInvariantInput,
} from './iteration-body-inputs';

export function IterationInspector({
  node,
  manifest,
  onUpdateNode,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
  onUpdateNode: (node: NodeDefinition) => void;
}) {
  const actions = useContext(WorkflowInputContext);
  const disabled = actions?.disabled ?? false;
  const manifests = actions?.manifests ?? [];
  const [message, setMessage] = useState<string | null>(null);
  const composite = node.composite?.kind === 'iteration' ? node.composite : undefined;
  const ports = resolveWorkflowNodePorts(node, manifest);
  const items = ports.inputs.find((port) => port.key === 'items');

  function commit(recipe: (current: NodeDefinition) => NodeDefinition) {
    try {
      onUpdateNode(recipe(node));
      setMessage(null);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法更新 Iteration');
      return false;
    }
  }

  return (
    <div className={panel.sections}>
      {message ? (
        <Alert variant="warning">
          <AlertTitle>{message}</AlertTitle>
        </Alert>
      ) : null}

      <section className={panel.section} aria-label="集合">
        <span className={panel.fieldLabel}>集合</span>
        {composite ? (
          <label className={panel.field}>
            <span className={panel.fieldLabel}>元素类型</span>
            <DataTypeSelect
              value={composite.itemType}
              disabled={disabled}
              ariaLabel="元素类型"
              onChange={(type) => commit((current) => setIterationItemType(current, type))}
            />
          </label>
        ) : (
          <p className={styles.hint}>初始化 Body 后可设置元素类型。</p>
        )}
        {items ? (
          <>
            <p className={styles.hint}>
              {items.name} · {formatDataType(items.dataType)}
              {items.required ? ' · 必填' : ''}
            </p>
            <NodeInputBindingField
              nodeId={node.id}
              port={items}
              binding={node.inputs[items.key]}
              rows={2}
            />
          </>
        ) : null}
      </section>

      <section className={panel.section} aria-label="不变输入">
        <span className={panel.fieldLabel}>不变输入</span>
        <p className={styles.hint}>这些输入是 Iteration 节点的正式端口，并可映射进 Body。</p>
        {composite ? (
          <GraphInputEditor
            label="不变输入"
            inputs={composite.invariantInputs}
            disabled={disabled}
            empty="尚未添加。名称不能使用 items。"
            onAdd={() => commit((current) => addInvariantInput(current))}
            onRemove={(name) => commit((current) => removeInvariantInput(current, name))}
            onRename={(name, next) =>
              commit((current) => updateInvariantInput(current, name, { name: next }))
            }
            onType={(name, type) =>
              commit((current) => updateInvariantInput(current, name, { type }))
            }
            onRequired={(name, required) =>
              commit((current) => updateInvariantInput(current, name, { required }))
            }
            renderExtra={(input) => {
              const port = ports.inputs.find((item) => item.key === input.name);
              return port ? (
                <NodeInputBindingField
                  nodeId={node.id}
                  port={port}
                  binding={node.inputs[port.key]}
                  rows={2}
                />
              ) : null;
            }}
          />
        ) : (
          <p className={styles.hint}>初始化 Body 后可添加。</p>
        )}
      </section>

      <section className={panel.section} aria-label="Body 输入">
        <span className={panel.fieldLabel}>Body 输入</span>
        <p className={styles.hint}>
          进入 Body 后只看到这些输入名称。来源在这里配置，不会写进 Body 定义。
        </p>
        {composite ? (
          <GraphInputEditor
            label="Body 输入"
            inputs={composite.body.inputs}
            disabled={disabled}
            empty="尚未添加。"
            onAdd={() => commit((current) => addBodyInput(current))}
            onRemove={(name) => commit((current) => removeBodyInput(current, name))}
            onRename={(name, next) =>
              commit((current) => updateBodyInput(current, name, { name: next }, manifests))
            }
            onType={(name, type) =>
              commit((current) => updateBodyInput(current, name, { type }, manifests))
            }
            onRequired={(name, required) =>
              commit((current) => updateBodyInput(current, name, { required }, manifests))
            }
            renderExtra={(input) => {
              const mapping = composite.bodyInputMapping.find((item) => item.target === input.name);
              const options = bodyInputSourceOptions(composite, input.type);
              const selected = mapping
                ? options.find(
                    (option) =>
                      option.source.type === mapping.source.type &&
                      (option.source.type !== 'iteration_input' ||
                        mapping.source.type !== 'iteration_input' ||
                        option.source.key === mapping.source.key),
                  )
                : undefined;
              return (
                <label className={panel.field}>
                  <span className={panel.fieldLabel}>来源</span>
                  <select
                    className={styles.select}
                    aria-label={`${input.name} 的来源`}
                    disabled={disabled}
                    value={selected?.id ?? ''}
                    onChange={(event) => {
                      const option = options.find((item) => item.id === event.target.value);
                      commit((current) =>
                        setBodyInputMapping(current, input.name, option?.source ?? null),
                      );
                    }}
                  >
                    <option value="">未配置</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {selected ? null : (
                    <span className={styles.status} role="status">
                      {mapping ? '来源与类型不兼容' : '未配置'}
                    </span>
                  )}
                </label>
              );
            }}
          />
        ) : (
          <p className={styles.hint}>初始化 Body 后可添加。</p>
        )}
      </section>

      <section className={panel.section} aria-label="Body">
        <span className={panel.fieldLabel}>Body</span>
        {composite ? (
          <p className={styles.hint}>
            局部图在画布中编辑。Body 里看到的是上面声明的输入，不是当前元素或当前序号。
          </p>
        ) : (
          <>
            <p className={styles.hint}>
              尚未配置 Body。初始化后可进入局部图，不会自动创建 Action。
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !isIterationNodeManifest(manifest)}
              onClick={() => commit((current) => initializeIterationBody(current))}
            >
              初始化 Body
            </Button>
          </>
        )}
      </section>

      <section className={panel.section} aria-label="Body 输出">
        <span className={panel.fieldLabel}>Body 输出</span>
        {!composite || composite.body.outputs.length === 0 ? (
          <p className={styles.hint}>尚未声明。在 Body 画布把节点输出连到结束边界。</p>
        ) : (
          <ul className={styles.hint}>
            {composite.body.outputs.map((output) => {
              const parent = ports.outputs.find((port) => port.key === output.name);
              return (
                <li key={output.name}>
                  {output.name} · {formatDataType(output.type)}
                  {parent ? ` → 父端口 ${formatDataType(parent.dataType)}` : ''}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
