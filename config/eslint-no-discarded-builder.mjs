// config/eslint-no-discarded-builder.mjs
//
// R24: every builder in this engine (`Turn`, `RollBuilder`, `AttackBuilder`,
// `ACBuilder`, `PMF`) is immutable — every method returns a new instance
// instead of mutating in place. An expression statement whose value is one
// of these types is therefore always dead code: `t.onFirstHit(big);` looks
// like it mutates `t`, but it silently discards the transformed value.
// `@typescript-eslint/no-unused-expressions` deliberately allows call
// expressions (for side-effecting APIs), so it does not catch this. This
// rule is type-aware — it asks the checker for the statement's static type
// rather than pattern-matching method names — so it also catches chains
// through locals, ternaries and reassigned variables.
//
// This module is plain JS (no build step): ESLint loads it directly via
// `eslint.config.mjs`, and `@typescript-eslint/utils` does not require the
// rule module itself to be type-checked to read type information from the
// program it is analyzing.

import { ESLintUtils } from "@typescript-eslint/utils";

const BUILDER_TYPE_NAMES = new Set([
  "Turn",
  "RollBuilder",
  "AttackBuilder",
  "ACBuilder",
  "PMF",
]);

/** Collects the symbol names of a type, descending into unions so
 * `Turn | undefined`-shaped results are still caught by their live half. */
function collectTypeNames(type, names = new Set()) {
  if (typeof type.isUnion === "function" && type.isUnion()) {
    for (const constituent of type.types) {
      collectTypeNames(constituent, names);
    }
    return names;
  }
  const symbol = typeof type.getSymbol === "function" ? type.getSymbol() : undefined;
  if (symbol?.name) {
    names.add(symbol.name);
  }
  return names;
}

export const noDiscardedBuilder = ESLintUtils.RuleCreator(
  (name) => `https://github.com/yipe/dice/blob/main/config/eslint-no-discarded-builder.mjs#${name}`,
)({
  name: "no-discarded-builder",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow expression statements whose value is a Turn, RollBuilder, AttackBuilder, " +
        "ACBuilder or PMF. Every method on these types is immutable and returns a new value " +
        "instead of mutating in place, so a bare expression statement of this type is always " +
        "the discarded result of a builder call.",
    },
    messages: {
      discarded:
        "This expression's value is a {{typeName}}, which is discarded here. {{typeName}} is " +
        "immutable: every method returns a new value instead of mutating in place. Assign the " +
        "result, return it, or resolve it (e.g. call .mean()/.resolve()) instead of leaving it " +
        "as a bare statement.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      ExpressionStatement(node) {
        // `x = builder.method();` (and compound forms) stores the value in
        // `x` — it is captured, not discarded. Whether `x` itself later goes
        // unused is `no-unused-vars`' job, not this rule's.
        if (node.expression.type === "AssignmentExpression") {
          return;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node.expression);
        const type = checker.getTypeAtLocation(tsNode);
        const names = collectTypeNames(type);
        const matched = [...names].find((name) => BUILDER_TYPE_NAMES.has(name));
        if (matched) {
          context.report({ node, messageId: "discarded", data: { typeName: matched } });
        }
      },
    };
  },
});

export default noDiscardedBuilder;
