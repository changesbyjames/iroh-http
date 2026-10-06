import { defineRule } from "@oxlint/plugins";
import type { Scope } from "@oxlint/plugins";

/** Ban access to Object.freeze, including calls and references saved for later use. */
export const noObjectFreezeRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow Object.freeze." },
    schema: [],
    messages: {
      objectFreeze: "Object.freeze is not allowed by house rules.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.object.name !== "Object") return;
        const property = node.property;
        const isFreeze = node.computed
          ? (property.type === "Literal" && property.value === "freeze") ||
            (property.type === "TemplateLiteral" && property.expressions.length === 0 &&
              property.quasis[0]?.value.cooked === "freeze")
          : property.type === "Identifier" && property.name === "freeze";
        if (!isFreeze) return;

        // Resolve the binding so a local object named Object is not confused with
        // the built-in constructor. An absent or definition-free binding is global.
        let scope: Scope | null = context.sourceCode.getScope(node.object);
        while (scope) {
          const variable = scope.set.get("Object");
          if (variable) {
            if (variable.defs.length > 0) return;
            break;
          }
          scope = scope.upper;
        }
        context.report({ node, messageId: "objectFreeze" });
      },
    };
  },
});
