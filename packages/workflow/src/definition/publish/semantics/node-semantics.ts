import {
  CompositeDefinitionError,
  isSubworkflowNodeManifest,
  resolveNodePorts,
  validateIterationInputMapping,
  type GraphDefinitionPath,
  type NodeDefinition,
  type ResolvedNodePorts,
} from '@dramaflow/contracts';
import { StateGraph } from '@langchain/langgraph';
import type { NodeRegistry } from '../../../node/registry/registry.js';
import type { NodeDeclaration } from '../../../node/registry/type.js';
import { isHumanReviewNodeManifest } from '../../../node/builtin/human-review.js';
import { isIterationNodeManifest } from '../../../node/builtin/iteration.js';
import { DefaultDataStoragePolicyResolver } from '../../../runtime/values/data-storage-policy-resolver.js';
import { WorkflowStateAnnotation } from '../../../runtime/state/state.js';
import { invalid } from '../publish-issue.js';
import type { ValidatedDefinitionNode } from '../types.js';

export function isSupportedIf(nodeType: NodeDeclaration): boolean {
  const { manifest } = nodeType;
  return (
    manifest.type === 'flow.if' && manifest.version === 1 && manifest.executionKind === 'control'
  );
}

// 仅调用官方 addNode 的命名检查，不 compile / invoke；绝不提供运行时替身或业务结果。
function staticOnlyNode(): never {
  throw new Error('发布校验不能执行节点');
}

export class NodeSemanticsValidator {
  private readonly names = new StateGraph(WorkflowStateAnnotation);
  private readonly storage = new DefaultDataStoragePolicyResolver();

  constructor(private readonly registry: NodeRegistry) {}

  validate(node: NodeDefinition, definitionPath: GraphDefinitionPath): ValidatedDefinitionNode {
    let declaration;
    try {
      declaration = this.registry.get(node.type, node.typeVersion);
    } catch {
      return invalid('NODE_TYPE_UNAVAILABLE', node.id);
    }
    if (
      !isIterationNodeManifest(declaration.manifest) &&
      !isSubworkflowNodeManifest(declaration.manifest) &&
      !isSupportedIf(declaration) &&
      !isHumanReviewNodeManifest(declaration.manifest) &&
      (declaration.manifest.executionKind !== 'action' || !declaration.execute)
    )
      return invalid('NODE_EXECUTION_KIND_UNSUPPORTED', node.id);
    const nodeType = declaration;
    try {
      this.names.addNode(node.id, staticOnlyNode);
    } catch {
      return invalid('NODE_ID_INVALID', node.id);
    }
    const config = nodeType.configSchema.strict().safeParse(node.config);
    if (!config.success) return invalid('NODE_CONFIG_INVALID', node.id);
    for (const output of nodeType.manifest.outputs) {
      if (output.storagePolicy === undefined || output.storagePolicy === 'auto') {
        try {
          this.storage.resolve(output.dataType, undefined);
        } catch {
          return invalid('OUTPUT_STORAGE_UNSUPPORTED', node.id, output.key);
        }
      }
    }
    let ports: ResolvedNodePorts;
    try {
      ports = resolveNodePorts(node, nodeType.manifest);
      if (isIterationNodeManifest(nodeType.manifest)) validateIterationInputMapping(node, ports);
    } catch (error) {
      if (error instanceof CompositeDefinitionError)
        return invalid(error.code, node.id, error.portKey);
      throw error;
    }
    return {
      node,
      nodeType,
      config: config.data,
      ports,
      ...(definitionPath.length ? { definitionPath } : {}),
    };
  }
}
