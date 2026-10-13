import { parse } from "@yipe/dice";

parse("1d8").pAt(5); // 0.125, 1 in 8
parse("2d8").pAt(9); // 0.125, 8 of 64
parse("2d8").pAt(2); // 0.0156, 1 of 64
parse("2d8 + 4").pAt(13); // 0.125, the same 8 of 64, shifted by 4
