import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { isZodSchemaExpression, zodValueImportNames } from "../shared/zod-schema.ts";

const PASCAL_CASE_SCHEMA = /^[A-Z][A-Za-z0-9]*Schema$/u;

function suggestedSchemaName(name: string): string {
  const withoutSuffix = name.replace(/schema$/iu, "");
  const head = withoutSuffix.charAt(0);
  if (head === "") return "DomainSchema";
  return `${head.toUpperCase()}${withoutSuffix.slice(1)}Schema`;
}

function bindingName(id: ESTree.BindingPattern): string | null {
  return id.type === "Identifier" ? id.name : null;
}

/** Require Zod schema bindings to use PascalCase names that end in `Schema`. */
export const requirePascalCaseSchemaNameRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Zod schema bindings to be PascalCase identifiers that end in `Schema`.",
    },
    messages: {
      pascalCaseSchema:
        "Rename `{{name}}` to PascalCase ending in `Schema` (for example `{{suggestion}}`).",
    },
  },
  createOnce(context) {
    let zodNames: ReadonlySet<string> = new Set();
    const schemaBindings = new Set<string>();

    const checkBinding = (id: ESTree.BindingPattern, init: ESTree.Expression | null | undefined) => {
      if (init === null || init === undefined) return;
      const name = bindingName(id);
      if (name === null) return;
      if (!isZodSchemaExpression(init, zodNames, schemaBindings)) return;
      schemaBindings.add(name);
      if (PASCAL_CASE_SCHEMA.test(name)) return;
      context.report({
        node: id,
        messageId: "pascalCaseSchema",
        data: { name, suggestion: suggestedSchemaName(name) },
      });
    };

    return {
      Program(node) {
        zodNames = zodValueImportNames(node);
        schemaBindings.clear();
      },
      VariableDeclarator(node) {
        checkBinding(node.id, node.init);
      },
      PropertyDefinition(node) {
        if (node.computed || node.key.type !== "Identifier" || node.value === null) return;
        checkBinding(node.key, node.value);
      },
      AssignmentExpression(node) {
        if (node.left.type !== "Identifier") return;
        checkBinding(node.left, node.right);
      },
    };
  },
});
