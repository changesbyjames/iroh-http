import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  collectTopLevelZodSchemaBindings,
  isZodOutputOfSchema,
  zodValueImportNames,
} from "../shared/zod-schema.ts";

const SCHEMA_SUFFIX = /Schema$/iu;

interface NamedType {
  name: string;
  id: ESTree.Identifier;
  alias: ESTree.TSTypeAliasDeclaration | null;
}

function pascalCasePrefix(schemaName: string): string | null {
  const prefix = schemaName.replace(SCHEMA_SUFFIX, "");
  if (prefix === "" || prefix === schemaName) return null;
  return `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
}

function collectTopLevelTypes(program: ESTree.Program): NamedType[] {
  const types: NamedType[] = [];
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "TSTypeAliasDeclaration") {
      types.push({ name: declaration.id.name, id: declaration.id, alias: declaration });
    }
    if (declaration?.type === "TSInterfaceDeclaration") {
      types.push({ name: declaration.id.name, id: declaration.id, alias: null });
    }
  }
  return types;
}

function typesForSchema(types: readonly NamedType[], schemaName: string): NamedType[] {
  const prefix = schemaName.replace(SCHEMA_SUFFIX, "");
  if (prefix === "" || prefix === schemaName) return [];
  const needle = prefix.toLowerCase();
  return types.filter((type) => type.name.toLowerCase() === needle);
}

/** Require each `SomethingSchema` to be paired with `type Something = z.output<typeof SomethingSchema>`. */
export const requireZodOutputTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the type named by a Zod schema's prefix to be `z.output<typeof ThatSchema>`, not a handwritten interface or alias.",
    },
    messages: {
      missingOutputType:
        "Schema `{{schema}}` has no paired type. Declare `type {{typeName}} = z.output<typeof {{schema}}>` so parse results are the schema's output, not a handwritten stand-in.",
      handwrittenType:
        "Type `{{typeName}}` is handwritten beside schema `{{schema}}`. Replace it with `type {{typeName}} = z.output<typeof {{schema}}>` so `parse` does not need a type assertion.",
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        const zodNames = zodValueImportNames(node);
        const schemas = collectTopLevelZodSchemaBindings(node, zodNames);
        const types = collectTopLevelTypes(node);

        for (const [schemaName, schemaId] of schemas) {
          const expectedName = pascalCasePrefix(schemaName);
          if (expectedName === null) continue;
          const matches = typesForSchema(types, schemaName);
          if (matches.length === 0) {
            context.report({
              node: schemaId,
              messageId: "missingOutputType",
              data: { schema: schemaName, typeName: expectedName },
            });
            continue;
          }
          for (const match of matches) {
            if (
              match.alias !== null &&
              isZodOutputOfSchema(match.alias.typeAnnotation, schemaName, zodNames)
            ) {
              continue;
            }
            context.report({
              node: match.id,
              messageId: "handwrittenType",
              data: { schema: schemaName, typeName: match.name },
            });
          }
        }
      },
    };
  },
});
