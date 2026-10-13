# How Dice Become DPR

A scroll-driven explainer for `@yipe/dice`: how one D&D 5e turn (a Monk 5 / Rogue 1 with Vex, Nick, Sneak Attack and
Stunning Strike) becomes an exact damage per round. It is published to GitHub Pages at
**https://yipe.github.io/dice/** by [`.github/workflows/explainer.yml`](../.github/workflows/explainer.yml).

This folder is its own small project. It is not part of the published npm package (which ships only `dist/`), and the
library's build, tests and lint never look in here.

## Every number is checked

The page shows the published `@yipe/dice` (pinned in `package.json`) doing the math, and the build fails if anything
drawn on screen disagrees with it:

- **Data asserts** (`npm run check:data`): the data modules in `src/` rebuild charts by hand (bucket by bucket,
  convolution by convolution, branch by branch) and throw if they differ from the engine.
- **Code snippets** (`npm run check:snippets`): every `expression; // value` line in `snippets/` is run, and the value in
  the comment must match. The snippets are the code boxes on the page.
- **The joke formula** (`npm run check:formula`): `scripts/check-formula.py` sums the LaTeX formula over every path with
  exact fractions and compares it with `DPR_EXACT`.
- **Smoke test** (`npm run smoke`): loads the built page in Chromium at desktop and phone sizes and scrolls through every
  part. The episodes assert their own drawn numbers, so a wrong number is a page error, and the test fails on any page
  error, missing asset or sideways scrolling.

## Working on it

```bash
cd explainer
npm ci
npm run build      # writes site/app.js
npm run preview    # serves site/ at http://localhost:4173
npm run check      # typecheck + data + snippets + formula
npm run smoke      # after a build; needs a Playwright Chromium (npx playwright install chromium)
```

- `site/index.html` is the page itself (hand-written HTML and CSS, including the formula and spreadsheet jokes and the
  "Your turn" section). `site/fonts` and `site/katex` are its fonts. `site/app.js` is the build output.
- `web/main.tsx` lists the parts (title, intro, captions, code) and drives each one from scroll position.
- `src/episodes/` has one Remotion composition per part, played frame by frame by `@remotion/player` as you scroll.
- `src/*Data.ts` hold the numbers, all computed with `@yipe/dice` and cross-checked by hand.

Copy rule: no em dashes, en dashes or `--` in anything a reader sees.

## Licenses

Fonts in `site/fonts`: Inter and Gelasio (SIL Open Font License), DejaVu Sans Mono (Bitstream Vera license). KaTeX
fonts in `site/katex`: SIL Open Font License. The animations use [Remotion](https://www.remotion.dev/license), which is
free for individuals and small teams; larger companies need a company license.
