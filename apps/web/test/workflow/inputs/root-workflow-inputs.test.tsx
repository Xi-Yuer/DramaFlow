// @vitest-environment happy-dom
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnyType,
  BooleanType,
  NumberType,
  StringType,
  nodeTypeManifestSchema,
  workflowDraftDefinitionSchema,
  type DataType,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { WorkflowInputDialog } from '../../../src/features/workflow/inputs/workflow-input-dialog';
import {
  addGraphInput,
  removeGraphInput,
  updateGraphInput,
} from '../../../src/features/workflow/inputs/definitions/graph-inputs';
import { bindGraphInput } from '../../../src/features/workflow/inputs/bindings/graph-input-bindings';
import { initializeIterationBody } from '../../../src/features/workflow/iteration/iteration-body-inputs';
import {
  isBodyInputConnection,
  projectBodyInputBoundary,
} from '../../../src/features/workflow/iteration/body-input-boundary';
import { WorkflowBodyInputs } from '../../../src/features/workflow/iteration/body-input-boundary-node';
import {
  disconnectWorkflowEdge,
  fromReactFlowEdge,
} from '../../../src/features/workflow/canvas/react-flow-adapter';

afterEach(cleanup);
const list = (itemType: DataType): DataType => ({ kind: 'array', itemType });
const iterationManifest = nodeTypeManifestSchema.parse({
  type: 'flow.iteration',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'iteration',
  metadata: { name: '逐项处理', category: 'flow' },
  inputs: [{ key: 'items', name: '集合', dataType: list(AnyType), required: true }],
  outputs: [],
  config: [],
});
const manifests = [iterationManifest];

function definition(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      initializeIterationBody({
        id: 'iterate',
        type: 'flow.iteration',
        typeVersion: 1,
        name: '逐项处理',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      }),
    ],
    edges: [],
    outputs: [],
  };
}

describe('Root Graph Input 类型、边界与绑定', () => {
  it.each([
    ['string', StringType, '文本'],
    ['number', NumberType, '数字'],
    ['boolean', BooleanType, '布尔'],
    ['string[]', list(StringType), '(文本)[]'],
    ['number[]', list(NumberType), '(数字)[]'],
  ] as const)('编辑 %s 后边界保留类型和 output handle', (choice, type, label) => {
    let current = addGraphInput(definition());
    function Editor() {
      const [graph, setGraph] = useState(current);
      current = graph;
      return (
        <WorkflowInputDialog
          definition={graph}
          manifests={manifests}
          disabled={false}
          onEdit={setGraph}
          onClose={() => undefined}
        />
      );
    }
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <Editor />
      </ConfigProvider>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: '工作流输入类型 input' }), {
      target: { value: choice },
    });
    expect(current.inputs[0]?.type).toEqual(type);
    const boundary = projectBodyInputBoundary(current, undefined, { scope: 'root' });
    expect(boundary.node.data.inputs[0]?.type).toEqual(type);
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <WorkflowBodyInputs
          id={boundary.node.id}
          type="workflowBodyInputs"
          data={boundary.node.data}
          selected={false}
          dragging={false}
          zIndex={0}
          selectable
          deletable={false}
          draggable
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain('工作流输入边界');
    expect(markup).toContain(label);
    expect(markup).toContain('data-handleid="input"');
    expect(markup).toContain('source');
    expect(workflowDraftDefinitionSchema.parse(current).inputs).toEqual(current.inputs);
    expect(current.nodes).toHaveLength(1);
    expect(current.edges).toEqual([]);
  });

  it('字符串列表仅连接兼容端口；虚线不可导出，删线清除 binding', () => {
    let graph = addGraphInput(definition());
    graph = updateGraphInput(graph, 'input', { name: 'items', type: list(StringType) }, manifests);
    const boundary = projectBodyInputBoundary(graph, undefined, { scope: 'root' });
    const connection = {
      source: boundary.node.id,
      sourceHandle: 'items',
      target: 'iterate',
      targetHandle: 'items',
    };
    expect(isBodyInputConnection(graph, manifests, connection, boundary.node.id)).toBe(true);
    for (const type of [StringType, NumberType, BooleanType, list(NumberType)]) {
      const incompatible = updateGraphInput(graph, 'items', { type }, manifests);
      expect(isBodyInputConnection(incompatible, manifests, connection, boundary.node.id)).toBe(
        false,
      );
      expect(() => bindGraphInput(incompatible, manifests, 'iterate', 'items', 'items')).toThrow(
        /不兼容/,
      );
    }
    const bound = bindGraphInput(graph, manifests, 'iterate', 'items', 'items');
    const projection = projectBodyInputBoundary(bound, undefined, { scope: 'root' }).edges[0]!;
    expect(projection).toMatchObject({
      data: { kind: 'data', projection: 'workflow-input' },
      reconnectable: false,
    });
    expect(() => fromReactFlowEdge(projection)).toThrow();
    expect(bound.nodes[0]?.inputs.items).toEqual({ type: 'workflow_input', key: 'items' });
    expect(bound.edges).toEqual([]);
    expect(disconnectWorkflowEdge(bound, projection).nodes[0]?.inputs.items).toBeUndefined();
    const renamed = updateGraphInput(bound, 'items', { name: 'texts', required: false }, manifests);
    expect(renamed.nodes[0]?.inputs.items).toEqual({ type: 'workflow_input', key: 'texts' });
    expect(renamed.inputs[0]?.required).toBe(false);
    expect(
      updateGraphInput(renamed, 'texts', { type: list(NumberType) }, manifests).nodes[0]?.inputs
        .items,
    ).toBeUndefined();
    expect(removeGraphInput(renamed, 'texts').nodes[0]?.inputs.items).toBeUndefined();
    expect(bound.inputs[0]?.name).toBe('items');
  });

  it('校验名称并保留已有 scalar 和非预设类型；锁定时禁止编辑', () => {
    let graph = addGraphInput(addGraphInput(definition()));
    expect(() => updateGraphInput(graph, 'input_2', { name: 'input' }, manifests)).toThrow(/重复/);
    expect(() => updateGraphInput(graph, 'input', { name: 'bad name' }, manifests)).toThrow();
    graph = updateGraphInput(graph, 'input', { type: AnyType }, manifests);
    render(
      <WorkflowInputDialog
        definition={graph}
        manifests={manifests}
        disabled
        onEdit={() => {
          throw new Error('不应编辑');
        }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('combobox', { name: '工作流输入类型 input' })).toHaveProperty(
      'value',
      'custom',
    );
    expect(screen.getByRole('combobox', { name: '工作流输入类型 input' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: '添加 工作流输入' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(graph.inputs[1]?.type).toEqual(StringType);
  });
});
