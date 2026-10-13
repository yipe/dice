import { d20, d8 } from "@yipe/dice/builder";

// a hit rolls 1d8 + 4; a crit doubles only the dice: 2d8 + 4
const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4));
shortsword.toExpression(); // "(d20 + 7 AC 15) * (1d8 + 4) crit (2d8 + 4)"
shortsword.pmf.pAt(0);     // 0.35, a miss
shortsword.pmf.pAt(10);    // 0.0789, 7.50% from hits + 0.39% from crits
