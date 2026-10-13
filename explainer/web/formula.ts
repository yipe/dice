import katex from "katex";
import { DPR_EXACT } from "../src/stunData";

// The joke near the top: the whole turn (Unarmed Strikes first, then shortswords, then scimitar) as one closed-form
// expectation. It is real: scripts/check-formula.py sums it over all 3^5 miss/hit/crit paths and both save results
// with exact fractions and gets DPR_EXACT, which stunData asserts against the engine.
//   o_i in {m, h, c}: attack i misses, hits or crits (1, 2 Unarmed Strikes; 3, 4 shortswords; 5 scimitar)
//   s in {f, p}: the Stunning Strike save fails or passes
//   k: the first Unarmed Strike that lands (Stunning Strike is tried there, once per turn)
//   alpha_i: attack i rolls with advantage (stunned after k, or the attack right after k on a pass, or Vex)
//   j*: the first weapon attack that lands, where Sneak Attack goes
const TAIL = String.raw`\frac{${DPR_EXACT.num}}{${DPR_EXACT.den}} \;\approx\; ${(DPR_EXACT.num / DPR_EXACT.den).toFixed(4)}`;
const PI = String.raw`\pi_0 \;&=\; \Big(\tfrac{7}{20},\ \tfrac{12}{20},\ \tfrac{1}{20}\Big)`;
const PI1 = String.raw`\pi_1 \;=\; \Big(\big(\tfrac{7}{20}\big)^{2},\ \ 1-\big(\tfrac{7}{20}\big)^{2}-\pi_1(c),\ \ 1-\big(\tfrac{19}{20}\big)^{2}\Big)`;
const ALPHA_STUN = String.raw`\mathbb{1}\big[k<i\big]\Big(\mathbb{1}\big[s=f\big]\lor\mathbb{1}\big[i=k+1\big]\Big)`;
const ALPHA_VEX = String.raw`\mathbb{1}\big[i\in\{4,5\}\big]\,\mathbb{1}\big[o_{i-1}\neq m\big]`;
const SAVE = String.raw`\Pr[s=f] \;=\; \underbrace{\Pr[d20+3<14]}_{\text{fails the save}} \;=\; \tfrac{1}{2}`;
const FIRSTS = String.raw`k(\mathbf{o}) = \min\{\,j\le 2 : o_j\neq m\,\},\qquad j^{\ast}(\mathbf{o}) = \min\{\,j\ge 3 : o_j\neq m\,\}`;

const TEX = String.raw`
\begin{aligned}
\mathrm{DPR} \;&=\; \sum_{\mathbf{o}\,\in\,\{m,\,h,\,c\}^{5}} \sum_{s\,\in\,\{f,\,p\}} \Pr[s]
  \left[\,\prod_{i=1}^{5} \pi_{\alpha_i(\mathbf{o},s)}\!\left(o_i\right)\right]
  \left(\,\sum_{i=1}^{5} \mu_i\!\left(o_i\right) \;+\; \tfrac{7}{2}\Big(1+\mathbb{1}\big[o_{j^{\ast}}=c\big]\Big)\,\mathbb{1}\big[j^{\ast}(\mathbf{o})\le 5\big]\right)
\\[10pt]
${PI},
\qquad
${PI1}
\\[6pt]
\alpha_i(\mathbf{o},s) \;&=\; ${ALPHA_STUN} \;\lor\; ${ALPHA_VEX},
\qquad
${SAVE}
\\[6pt]
\mu_i(h) \;&=\; \mathbb{E}[1d8] + 4\cdot\mathbb{1}[i\neq 5],
\qquad
\mu_i(c) \;=\; \mathbb{E}[2d8] + 4\cdot\mathbb{1}[i\neq 5],
\qquad
\mu_i(m) = 0
\\[6pt]
&\phantom{=}\;\; ${FIRSTS}
\\[10pt]
&=\; ${TAIL}
\end{aligned}`;

export const FORMULA_HTML = katex.renderToString(TEX, { displayMode: true, output: "htmlAndMathml", throwOnError: true });

// The same formula broken onto more lines, for phone widths.
const TEX_NARROW = String.raw`
\begin{aligned}
\mathrm{DPR} \;&=\; \sum_{\mathbf{o}\,\in\,\{m,\,h,\,c\}^{5}} \sum_{s\,\in\,\{f,\,p\}} \Pr[s]
  \Big[\,\prod_{i=1}^{5} \pi_{\alpha_i(\mathbf{o},s)}\!\left(o_i\right)\Big]
\\
&\qquad \cdot \Big(\,\sum_{i=1}^{5} \mu_i\!\left(o_i\right) +\; \tfrac{7}{2}\Big(1+\mathbb{1}\big[o_{j^{\ast}}=c\big]\Big)\,\mathbb{1}\big[j^{\ast}(\mathbf{o})\le 5\big]\Big)
\\[8pt]
${PI}
\\[4pt]
\pi_1 \;&=\; \Big(\big(\tfrac{7}{20}\big)^{2},\ \ 1-\big(\tfrac{7}{20}\big)^{2}-\pi_1(c),\ \ 1-\big(\tfrac{19}{20}\big)^{2}\Big)
\\[6pt]
\alpha_i(\mathbf{o},s) \;&=\; ${ALPHA_STUN}
\\
&\qquad \lor\; ${ALPHA_VEX}
\\[6pt]
\Pr[s=f] \;&=\; \underbrace{\Pr[d20+3<14]}_{\text{fails the save}} \;=\; \tfrac{1}{2}
\\[6pt]
\mu_i(h) \;&=\; \mathbb{E}[1d8] + 4\cdot\mathbb{1}[i\neq 5],
\qquad
\mu_i(m) = 0
\\[4pt]
\mu_i(c) \;&=\; \mathbb{E}[2d8] + 4\cdot\mathbb{1}[i\neq 5]
\\[4pt]
k(\mathbf{o}) \;&=\; \min\{\,j\le 2 : o_j\neq m\,\}
\\[4pt]
j^{\ast}(\mathbf{o}) \;&=\; \min\{\,j\ge 3 : o_j\neq m\,\}
\\[10pt]
&=\; ${TAIL}
\end{aligned}`;

export const FORMULA_NARROW_HTML = katex.renderToString(TEX_NARROW, { displayMode: true, output: "htmlAndMathml", throwOnError: true });
