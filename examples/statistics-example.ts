import { DiceQuery, parse } from "../src/index";
import {
  buildDynamicExpressionStatistics,
  printStatisticsPanelASCII,
  printSummary,
} from "./print";

function createQuery(expression: string) {
  const pmf = parse(expression);
  return new DiceQuery(pmf);
}
// Example: A typical D&D attack roll
function basicAttackExample() {
  const expression = "(d20 + 5 AC 15) * (1d6+2) crit (2d6 + 2)";
  const advExpression = "(d20 > d20 + 5 AC 15) * (1d6+2) crit (2d6 + 2)";
  const disExpression = "(d20 < d20 + 5 AC 15) * (1d6+2) crit (2d6 + 2)";
  const query = createQuery(expression);
  const advQuery = createQuery(advExpression);
  const disQuery = createQuery(disExpression);

  const statistics = buildDynamicExpressionStatistics({
    normal: query,
    advantage: advQuery,
    disadvantage: disQuery,
  });

  printSummary(expression, query);

  printStatisticsPanelASCII(statistics); // new panel
  //   printQuery("Normal", query);
  //   printQuery("Advantage", advQuery);
  //   printQuery("Disadvantage", disQuery);
}

basicAttackExample();
