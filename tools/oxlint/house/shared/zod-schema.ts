import type { ESTree } from "@oxlint/plugins";

const SCHEMA_CONSUMING_METHODS = new Set([
  "decode",
  "decodeAsync",
  "encode",
  "encodeAsync",
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
  "spa",
]);

export function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

export function unwrapType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === "TSParenthesizedType") {
    current = current.typeAnnotation;
  }
  return current;
}

export function zodValueImportNames(program: ESTree.Program): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "zod") continue;
    if (statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.importKind === "type") continue;
      names.add(specifier.local.name);
    }
  }
  return names;
}

function calleeObject(callee: ESTree.Expression): ESTree.Expression | null {
  if (callee.type === "ChainExpression") return calleeObject(callee.expression);
  if (!("object" in callee)) return null;
  return callee.object;
}

function terminalCallMethod(expression: ESTree.Expression): string | null {
  const call = unwrapExpression(expression);
  if (call.type !== "CallExpression") return null;
  if (call.callee.type === "Super" || call.callee.type === "V8IntrinsicExpression") return null;
  let callee: ESTree.Expression = unwrapExpression(call.callee);
  if (callee.type === "ChainExpression") callee = unwrapExpression(callee.expression);
  if (!("property" in callee) || callee.computed) return null;
  return callee.property.type === "Identifier" ? callee.property.name : null;
}

function expressionRoot(expression: ESTree.Expression): ESTree.Expression {
  let current = unwrapExpression(expression);
  while (true) {
    if (current.type === "ChainExpression") {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (current.type === "CallExpression") {
      if (current.callee.type === "Super" || current.callee.type === "V8IntrinsicExpression") {
        return current;
      }
      current = unwrapExpression(current.callee);
      continue;
    }
    const object = calleeObject(current);
    if (object === null) return current;
    current = unwrapExpression(object);
  }
}

export function isZodSchemaExpression(
  expression: ESTree.Expression,
  zodNames: ReadonlySet<string>,
  schemaBindings: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  const method = terminalCallMethod(unwrapped);
  if (method !== null && SCHEMA_CONSUMING_METHODS.has(method)) return false;
  const root = expressionRoot(unwrapped);
  return root.type === "Identifier" && (zodNames.has(root.name) || schemaBindings.has(root.name));
}

export function collectTopLevelZodSchemaBindings(
  program: ESTree.Program,
  zodNames: ReadonlySet<string>,
): ReadonlyMap<string, ESTree.Identifier> {
  const schemaBindings = new Set<string>();
  const result = new Map<string, ESTree.Identifier>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.init === null) continue;
      if (!isZodSchemaExpression(declarator.init, zodNames, schemaBindings)) continue;
      schemaBindings.add(declarator.id.name);
      result.set(declarator.id.name, declarator.id);
    }
  }
  return result;
}

function isZodOutputName(typeName: ESTree.TSTypeName, zodNames: ReadonlySet<string>): boolean {
  if (typeName.type === "TSQualifiedName") {
    return (
      typeName.left.type === "Identifier" &&
      zodNames.has(typeName.left.name) &&
      typeName.right.name === "output"
    );
  }
  return false;
}

export function isZodOutputOfSchema(
  type: ESTree.TSType,
  schemaName: string,
  zodNames: ReadonlySet<string>,
): boolean {
  const reference = unwrapType(type);
  if (reference.type !== "TSTypeReference" || !isZodOutputName(reference.typeName, zodNames)) {
    return false;
  }
  const argument = reference.typeArguments?.params[0];
  if (
    reference.typeArguments === null ||
    reference.typeArguments === undefined ||
    reference.typeArguments.params.length !== 1 ||
    argument === undefined
  ) {
    return false;
  }
  const query = unwrapType(argument);
  return (
    query.type === "TSTypeQuery" &&
    query.exprName.type === "Identifier" &&
    query.exprName.name === schemaName
  );
}
