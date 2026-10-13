import { d20, d8 } from "@yipe/dice/builder";

const withAdvantage = d20.withAdvantage().plus(7).ac(15).onHit(d8.plus(4));
withAdvantage.toQuery().probAtLeastOne(["hit", "crit"]); // 0.8775
withAdvantage.mean();                                    // 7.8975
