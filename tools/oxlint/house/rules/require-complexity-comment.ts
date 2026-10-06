import { defineRule } from '@oxlint/plugins';
import type { ESTree, SourceCode } from '@oxlint/plugins';

type Scope = { node: ESTree.Node; complexity: number; boundary: boolean };

const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const decisions = new Set([
  'IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement',
  'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause',
  'LogicalExpression', 'AssignmentPattern'
]);
const commentOwners = new Set([
  'VariableDeclarator', 'VariableDeclaration', 'ExportNamedDeclaration',
  'ExportDefaultDeclaration', 'Property', 'MethodDefinition', 'PropertyDefinition'
]);

function hasExplanation(source: SourceCode, node: ESTree.Node): boolean {
  const meaningful = (comment: { value: string }) => {
    const text = comment.value.replace(/\*/gu, '').trim();
    return /[\p{L}\p{N}]/u.test(text) && !/^(?:eslint|oxlint|@ts-|prettier|istanbul|c8)\b/u.test(text);
  };
  // Walk only declaration wrappers, so a comment on an enclosing function cannot
  // accidentally document a nested scope. Inline explanations must belong to this
  // scope, rather than to a nested function or block.
  let owner = node;
  while (true) {
    if (source.getCommentsBefore(owner).some(meaningful)) return true;
    if (!owner.parent || !commentOwners.has(owner.parent.type)) break;
    owner = owner.parent;
  }
  return source.getCommentsInside(node).some(comment => {
    if (!meaningful(comment)) return false;
    let current = source.getNodeByRangeIndex(comment.start);
    while (current && current !== node) {
      if (functions.has(current.type) || current.type === 'StaticBlock') return false;
      if (current.type === 'BlockStatement' && current.parent !== node) return false;
      current = current.parent;
    }
    return current === node;
  });
}

/** Require an explanation for each executable scope whose complexity exceeds five. */
export const requireComplexityCommentRule = defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Require a logic comment for scope blocks with cyclomatic complexity greater than 4.' },
    schema: [],
    messages: {
      missingExplanation: 'This scope has cyclomatic complexity {{complexity}} (greater than 4). Add a comment explaining its logic.'
    }
  },
  createOnce(context) {
    const scopes: Scope[] = [];
    return {
      before() { scopes.length = 0; },
      '*': (node: ESTree.Node) => {
        // Each scope starts with one path. Decisions propagate through enclosing
        // blocks, stopping at functions, static blocks, and field initializers,
        // whose execution paths are independent of their enclosing scope.
        const boundary = functions.has(node.type) || node.type === 'StaticBlock' || node.type === 'PropertyDefinition';
        const functionBody = node.type === 'BlockStatement' && functions.has(node.parent.type);
        if (boundary || (node.type === 'BlockStatement' && !functionBody)) {
          scopes.push({ node, complexity: 1, boundary });
        }
        const decision = decisions.has(node.type)
          || (node.type === 'SwitchCase' && node.test !== null)
          || (node.type === 'AssignmentExpression' && ['&&=', '||=', '??='].includes(node.operator))
          || ((node.type === 'MemberExpression' || node.type === 'CallExpression') && node.optional);
        if (!decision) return;
        for (let index = scopes.length - 1; index >= 0; index--) {
          const scope = scopes[index];
          scope.complexity++;
          if (scope.boundary) break;
        }
      },
      '*:exit': (node: ESTree.Node) => {
        const scope = scopes.at(-1);
        if (!scope || scope.node !== node) return;
        scopes.pop();
        if (scope.complexity > 4 && !hasExplanation(context.sourceCode, node)) {
          context.report({ node, messageId: 'missingExplanation', data: { complexity: String(scope.complexity) } });
        }
      }
    };
  }
});
