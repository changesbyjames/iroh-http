import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

function isDirectTypeAliasBody(node: ESTree.TSTypeLiteral): boolean {
  let current: ESTree.Node = node;
  let parent: ESTree.Node | null = node.parent;
  while (parent !== null && parent.type === "TSParenthesizedType") {
    current = parent;
    parent = parent.parent;
  }
  return parent?.type === "TSTypeAliasDeclaration" && parent.typeAnnotation === current;
}

/** Disallow inline object types; name them as a type alias or interface and reference that name. */
export const noInlineObjectTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow inline object types in annotations and type arguments; extract a named type or interface and reference it.",
    },
    messages: {
      inlineObjectType:
        "This inline object type is unnamed. Extract it to a named type or interface (for example `RecordingResponse`) and reference that name here.",
    },
  },
  createOnce(context) {
    return {
      TSTypeLiteral(node) {
        if (isDirectTypeAliasBody(node)) return;
        context.report({ node, messageId: "inlineObjectType" });
      },
    };
  },
});
