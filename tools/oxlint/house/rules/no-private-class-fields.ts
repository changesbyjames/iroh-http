import { defineRule } from "@oxlint/plugins";

/** Disallow JavaScript private class fields (`#name`) in favor of TypeScript `private`. */
export const noPrivateClassFieldsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow JavaScript private class fields; use TypeScript `private` for compile-time visibility.",
    },
    messages: {
      privateClassField:
        "Replace `#{{name}}` with TypeScript `private {{name}}`. `#` fields are a runtime feature; `private` is the visibility contract this codebase uses.",
    },
  },
  createOnce(context) {
    return {
      PrivateIdentifier(node) {
        context.report({
          node,
          messageId: "privateClassField",
          data: { name: node.name },
        });
      },
    };
  },
});
