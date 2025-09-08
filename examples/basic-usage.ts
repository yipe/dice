import {
  printCDFChart,
  printOutcomeTable,
  printPMFChart,
  printSummary,
} from "../examples/print";
import { DiceQuery, parse } from "../src/index";

function createQuery(expression: string) {
  const pmf = parse(expression);
  return new DiceQuery(pmf);
}

function basicAttackExample() {
  const expression = "(d20 + 5 AC 15) * (1d6+2) crit (2d6 + 2)";
  const query = createQuery(expression);

  printSummary(expression, query);
  printPMFChart(query);
  printCDFChart(query);
  printOutcomeTable(query.combined);
}

basicAttackExample();
