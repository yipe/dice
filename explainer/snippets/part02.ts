import { parse } from "@yipe/dice";

const crit = parse("2d8 + 4"); // a PMF: every total and its chance
crit.pAt(13); // 0.125, the top of the triangle
crit.pAt(6);  // 0.015625, an edge
