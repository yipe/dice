import { DiceQuery, OutcomeType, PMF, Snapshot } from "../src/index";

/* ────────────────────────────── Constants ────────────────────────────── */

const FULL = "█";
const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]; // 1/8 … 7/8

const B = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  tm: "┬",
  mm: "┼",
  bm: "┴",
  ml: "├",
  mr: "┤",
  h: "─",
  v: "│",
} as const;

const termWidth = () => process.stdout.columns ?? 80;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Canonical outcome set keeps types honest. */
const OUTCOME_KEYS = [
  "hit",
  "crit",
  "missNone",
  "missDamage",
  "saveFail",
  "saveHalf",
  "pc",
] as const satisfies readonly OutcomeType[];

const OUTCOME_LABEL: Record<OutcomeType, string> = {
  hit: "Hit",
  crit: "Crit",
  missNone: "Miss",
  missDamage: "Miss Damage",
  saveFail: "Save Fail",
  saveHalf: "Save Half",
  pc: "Potent Cantrip",
};

const OUTCOME_ORDER: Record<OutcomeType, number> = {
  crit: 1,
  hit: 2,
  missDamage: 3,
  saveHalf: 4,
  saveFail: 5,
  pc: 6,
  missNone: 7,
};

const isOutcomeType = (s: string): s is OutcomeType =>
  (OUTCOME_KEYS as readonly string[]).includes(s);

/* ───────────────────────────── Print Helpers ───────────────────────────── */

export function sep(title: string) {
  console.log(`\n===== ${title} =====\n`);
}

export function pct(x: number) {
  return `${(x * 100).toFixed(2)}%`;
}

export function fxd(x: number) {
  return x.toFixed(3);
}

/* ───────────────────────────── Box & Tables ───────────────────────────── */

/** Generic N-column divider: e.g. ├──┼──┼──┤ */
function dividerN(
  widths: number[],
  left: string = B.ml,
  mid: string = B.mm,
  right: string = B.mr
): string {
  const seg = (w: number) => B.h.repeat(w + 2); // +2 for cell padding
  return left + widths.map(seg).join(mid) + right;
}

/** Pad a cell with one space padding, with alignment. */
function padCell(text: string, width: number, align: "left" | "right") {
  return (
    " " +
    (align === "right"
      ? String(text).padStart(width)
      : String(text).padEnd(width)) +
    " "
  );
}

/** Render a single table row with N cells/widths/aligns. */
function rowN(cells: string[], widths: number[], aligns: ("left" | "right")[]) {
  const body = cells
    .map((c, i) => padCell(c, widths[i], aligns[i] ?? "left"))
    .join(B.v);
  return `${B.v}${body}${B.v}`;
}

/** Creates a table with an integrated tab header instead of a box around the table */
function buildTableWithTab(
  title: string,
  headers: string[],
  widths: number[],
  dataRows: string[][],
  aligns: ("left" | "right")[]
): string[] {
  const lines: string[] = [];

  // Tab setup
  const tabText = ` ${title} `;
  const tabWidth = Math.max(12, tabText.length);

  // if any of the widths are 0, calculate the max strength length of the entire data set
  // And use that (don't do it per row).
  // Each column should have it's own width.

  widths = widths.map((w, i) => {
    if (w !== 0) return w;
    const headerLen = headers[i] ? String(headers[i]).length : 0;
    const colMax = Math.max(
      headerLen,
      ...dataRows.map((row) => String(row[i] ?? "").length),
      0
    );
    return colMax;
  });

  // Tab top and content
  lines.push(B.tl + B.h.repeat(tabWidth) + B.tr);
  lines.push(B.v + tabText.padEnd(tabWidth, " ") + B.v);

  // Build the connector line that joins tab to table
  // Calculate total table width
  const totalTableWidth =
    widths.reduce((sum, w) => sum + w + 2, 0) + widths.length + 1; // +2 padding, +1 borders

  // Build connector: ├[tabWidth]┴[continuous line]┐
  let connector = B.ml; // Start with ├
  connector += B.h.repeat(tabWidth); // Tab width horizontal line
  connector += B.bm; // Add ┴ where tab ends

  // Fill remaining width with horizontal line (no column separators)
  const remainingWidth = totalTableWidth - tabWidth - 3; // -3 for ├, ┴, ┐
  if (remainingWidth > 0) {
    connector += B.h.repeat(remainingWidth);
  }

  connector += B.tr; // End with ┐
  lines.push(connector);

  // Header row (only if headers have meaningful content)
  if (headers.some((h) => h.trim().length > 0)) {
    lines.push(rowN(headers, widths, aligns));
    lines.push(dividerN(widths));
  }

  // Data rows
  for (const row of dataRows) {
    lines.push(rowN(row, widths, aligns));
  }

  // Bottom border
  lines.push(dividerN(widths, B.bl, B.bm, B.br));

  return lines;
}

/** Print a table with integrated tab instead of box-around-table */
export function printTableWithTab(
  title: string,
  headers: string[],
  widths: number[],
  dataRows: string[][],
  aligns: ("left" | "right")[]
): void {
  const lines = buildTableWithTab(title, headers, widths, dataRows, aligns);
  lines.forEach((line) => console.log(line));
  console.log("");
}

/* ───────────────────────────── Bar Charts ───────────────────────────── */

function renderBar(fraction: number, width: number): string {
  const total = clamp01(fraction) * width;
  const full = Math.floor(total);
  const rem = total - full;
  // show a tiny sliver when nonzero remainder exists
  const partialIndex =
    rem === 0 ? 0 : Math.max(1, Math.min(7, Math.floor(rem * 8)));
  const partial = PARTIAL[partialIndex];
  return (FULL.repeat(full) + partial).padEnd(width, " ");
}

type ChartRow = { damage: number; p: number; pct: string };

/** Shared horizontal bar chart builder (used by PMF & CDF). */
function buildBarChartLines(rows: ChartRow[], maxWidth?: number): string[] {
  if (rows.length === 0) return ["<no data>"];

  const maxDamageWidth = Math.max(
    ...rows.map((r) => r.damage.toString().length)
  );
  const maxPctWidth = Math.max(...rows.map((r) => r.pct.length));
  const width = maxWidth || termWidth();
  const sepWidth = maxDamageWidth + maxPctWidth + 5; // label + colon + spaces
  const barWidth = Math.max(1, width - sepWidth - 1);
  const maxP = Math.max(...rows.map((r) => r.p)) || 1;

  return rows.map(({ damage, p, pct }) => {
    const label = String(damage).padStart(maxDamageWidth);
    const bar = renderBar(p / maxP, barWidth);
    const pctStr = pct.padStart(maxPctWidth);
    return ` ${label}: ${bar} ${pctStr} `;
  });
}

/* ───────────────────────────── PMF / CDF ───────────────────────────── */

function makePMFLines(query: DiceQuery): string[] {
  const rows: ChartRow[] = query.toChartSeries().map(({ x, y }) => ({
    damage: x,
    p: y,
    pct: `${(y * 100).toFixed(2)}%`,
  }));
  return buildBarChartLines(rows, termWidth() - 3); // -6 for table borders and padding
}

function makeCDFLines(query: DiceQuery): string[] {
  const { support, data } = query.toCDFSeries(false);
  const rows: ChartRow[] = support.map((x, i) => ({
    damage: x,
    p: data[i],
    pct: `${(data[i] * 100).toFixed(2)}%`,
  }));
  return buildBarChartLines(rows, termWidth() - 3); // -6 for table borders and padding
}

export function printPMFChart(query: DiceQuery, label?: string): void {
  const lines = makePMFLines(query);
  const maxWidth = Math.max(...lines.map((l) => l.length), 20);
  printTableWithTab(
    `PMF ${label ? `(${label})` : ""}`,
    [""],
    [maxWidth],
    lines.map((l) => [l]),
    ["left"]
  );
}

export function printCDFChart(query: DiceQuery, label?: string): void {
  const lines = makeCDFLines(query);
  const maxWidth = Math.max(...lines.map((l) => l.length), 20);
  printTableWithTab(
    `CDF ${label ? `(${label})` : ""}: P(X ≤ x)`,
    [""],
    [maxWidth],
    lines.map((l) => [l]),
    ["left"]
  );
}

/* ───────────────────────────── Outcome Table ───────────────────────────── */

const pct3 = (n: number) => `${n.toFixed(3)}%`;
const outcomeLabel = (k: OutcomeType) => OUTCOME_LABEL[k] ?? k.toUpperCase();

/** Find which outcomes actually appear in the PMF, with stable ordering. */
function collectOutcomes(pmf: PMF): OutcomeType[] {
  const found = new Set<string>();

  for (const [, bin] of pmf.map) {
    for (const k in bin.count) {
      if (bin.count[k] && (bin.count[k] as number) > 0) found.add(k);
    }
  }

  if (found.size === 0)
    ["hit", "crit", "missNone"].forEach((k) => found.add(k));

  const typed = Array.from(found).filter(isOutcomeType) as OutcomeType[];
  typed.sort((a, b) => (OUTCOME_ORDER[a] ?? 999) - (OUTCOME_ORDER[b] ?? 999));
  return typed;
}

export function printOutcomeTable(pmf: PMF, label?: string): void {
  const title = `Outcome Table ${label ? `(${label})` : ""}`;
  if (pmf.support().length === 0) {
    printTableWithTab(title, ["NO DATA"], [10], [["<no data>"]], ["left"]);
    return;
  }

  const outcomes = collectOutcomes(pmf);
  const query = new DiceQuery([], pmf);
  const labeled = query.toLabeledTable(outcomes);

  const headers = [
    "DAMAGE",
    "PERCENT",
    ...outcomes.map((o) => `${outcomeLabel(o)} %`),
  ];
  const aligns: ("left" | "right")[] = [
    "left",
    "right",
    ...outcomes.map(() => "right" as const),
  ];

  // Build data columns
  const cols: string[][] = [];
  cols[0] = labeled.map((r) => String(r.damage));
  cols[1] = labeled.map((r) => pct3(r.total * 100));
  outcomes.forEach((o, i) => {
    cols[i + 2] = labeled.map((r) => pct3(((r[o] as number) || 0) * 100));
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cols[i].map((s) => s.length))
  );

  // Build data rows
  const dataRows: string[][] = [];
  for (let r = 0; r < labeled.length; r++) {
    dataRows.push(headers.map((_, c) => cols[c][r]));
  }

  printTableWithTab(title, headers, widths, dataRows, aligns);
}

/* ───────────────────────────── Summary / Distribution ───────────────────────────── */

function buildSummaryLines(expression: string, query: DiceQuery): string[] {
  const labelW = 15;
  const rows: Array<[string, string]> = [
    ["Expression:", expression],
    ["Success Chance:", query.probAtLeastOne(["hit", "crit"]).toFixed(2)],
    ["Expected DPR:", query.mean().toFixed(2)],
  ];
  return rows.map(([k, v]) => k.padEnd(labelW) + " " + v);
}

export function printSummary(expression: string, query: DiceQuery) {
  const lines = buildSummaryLines(expression, query);
  const maxWidth = Math.max(...lines.map((l) => l.length), 20);
  printTableWithTab(
    "Summary",
    [""],
    [maxWidth],
    lines.map((l) => [l]),
    ["left"]
  );
}

/** Optional: tiny min/mean/max block. */
function buildDistributionLines(query: DiceQuery): string[] {
  const kv = (label: string, n: number) => `${label.padEnd(7)} ${n.toFixed(2)}`;
  return [
    kv("Min:", query.min()),
    kv("Mean:", query.mean()),
    kv("Max:", query.max()),
  ];
}

/* ───────────────────────────── Statistics (sections + render) ───────────────────────────── */

export type StatRow = {
  label: string;
  col1?: string | number;
  col2?: string | number;
  col3?: string | number;
  __header?: boolean;
};

export type Section = {
  id: string;
  header: string;
  columns: [string, string, string];
  rows: StatRow[];
};

function formatUpTo2Decimals(n: number, locale = "en-US") {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(n);
}

function formatValue(
  value: number | undefined,
  format: "number" | "percentage" | "integer" = "number"
) {
  if (value === undefined || value === null) return "—";
  switch (format) {
    case "percentage":
      return `${formatUpTo2Decimals(value * 100)}%`;
    case "integer":
      return String(value);
    default:
      return formatUpTo2Decimals(value);
  }
}

const outcomeDisplayOrder: Record<string, number> = {
  crit: 1,
  hit: 2,
  missDamage: 3,
  saveHalf: 4,
  saveFail: 5,
  pc: 6,
  missNone: 7,
};

function getSortedOutcomes(normalMap: Map<string, any>): Array<[string, any]> {
  return Array.from(normalMap.entries()).sort(
    (a, b) =>
      (outcomeDisplayOrder[a[0]] || 999) - (outcomeDisplayOrder[b[0]] || 999)
  );
}

function formatAccuracyLabel(key: string): string {
  const m: Record<string, string> = {
    crit: "Crit",
    hit: "Hit",
    missNone: "Miss",
    missDamage: "Damage on Miss",
    saveFail: "Save failure",
    saveHalf: "Save success",
    pc: "Potent Cantrip",
  };
  return m[key] || key;
}
function formatAllLabel(key: string): string {
  const m: Record<string, string> = {
    crit: "All crits",
    hit: "All hits",
    missNone: "All misses",
    missDamage: "All miss damage",
    saveFail: "All failed saves",
    saveHalf: "All successful saves",
    pc: "All potent cantrips",
  };
  return m[key] || `All ${key}`;
}

/** Builds rows for sections that show probabilities for each band. */
function generateDynamicProbabilityRows(
  outcomesData: {
    disadvantage: Map<string, any>;
    normal: Map<string, any>;
    advantage: Map<string, any>;
  },
  probabilityType: "atLeastOneProbability" | "allProbability",
  labelFormatter: (ot: string) => string
): StatRow[] {
  const all = new Set<string>();
  [
    outcomesData.disadvantage,
    outcomesData.normal,
    outcomesData.advantage,
  ].forEach((m) => m.forEach((_, k) => all.add(k)));
  const sorted = Array.from(all).sort(
    (a, b) => (outcomeDisplayOrder[a] || 999) - (outcomeDisplayOrder[b] || 999)
  );

  return sorted.map((ot) => ({
    label: labelFormatter(ot),
    col1: formatValue(
      outcomesData.disadvantage.get(ot)?.[probabilityType] ?? 0,
      "percentage"
    ),
    col2: formatValue(
      outcomesData.normal.get(ot)?.[probabilityType] ?? 0,
      "percentage"
    ),
    col3: formatValue(
      outcomesData.advantage.get(ot)?.[probabilityType] ?? 0,
      "percentage"
    ),
  }));
}

/** Build the sections that feed both the ASCII panel and Chakra table. */
export function buildSectionsFromStats(
  statistics: DynamicExpressionStatistics
): Section[] {
  const inPercentiles = {
    normal: statistics.normal.percentiles,
    advantage: statistics.advantage.percentiles,
    disadvantage: statistics.disadvantage.percentiles,
  };

  const inOutcomes = {
    normal: statistics.normal.outcomes,
    advantage: statistics.advantage.outcomes,
    disadvantage: statistics.disadvantage.outcomes,
  };

  const inDPR = {
    normal: statistics.normal.averageDPR,
    advantage: statistics.advantage.averageDPR,
    disadvantage: statistics.disadvantage.averageDPR,
  };

  const damageOutput: Section = {
    id: "damage-output",
    header: "Damage Output",
    columns: ["DIS", "Normal", "ADV"],
    rows: [
      {
        label: "Average DPR",
        col1: formatValue(inDPR.disadvantage),
        col2: formatValue(inDPR.normal),
        col3: formatValue(inDPR.advantage),
      },
      {
        label: "P25",
        col1: formatValue(inPercentiles.disadvantage.p25, "integer"),
        col2: formatValue(inPercentiles.normal.p25, "integer"),
        col3: formatValue(inPercentiles.advantage.p25, "integer"),
      },
      {
        label: "P50",
        col1: formatValue(inPercentiles.disadvantage.p50, "integer"),
        col2: formatValue(inPercentiles.normal.p50, "integer"),
        col3: formatValue(inPercentiles.advantage.p50, "integer"),
      },
      {
        label: "P75",
        col1: formatValue(inPercentiles.disadvantage.p75, "integer"),
        col2: formatValue(inPercentiles.normal.p75, "integer"),
        col3: formatValue(inPercentiles.advantage.p75, "integer"),
      },
    ],
  };

  const damageBreakdown: Section = {
    id: "damage-breakdown",
    header: "Damage Breakdown",
    columns: ["MIN", "AVG", "MAX"],
    rows: getSortedOutcomes(inOutcomes.normal).map(([ot, s]) => ({
      label: (OUTCOME_LABEL as Record<string, string>)[ot] || ot.toUpperCase(),
      col1: formatValue(s?.damageRange?.min, "number"),
      col2: formatValue(s?.damageRange?.avg, "number"),
      col3: formatValue(s?.damageRange?.max, "number"),
    })),
  };

  const consistency: Section = {
    id: "consistency",
    header: "Consistency",
    columns: ["", "", ""],
    rows: [
      {
        label: "Std. Deviation",
        col3: formatValue(statistics.standardDeviation),
      },
    ],
  };

  const accuracy: Section = {
    id: "accuracy",
    header: "At least 1",
    columns: ["DIS", "Normal", "ADV"],
    rows: [
      {
        label: "Damage",
        col1: formatValue(statistics.disadvantage.damageChance, "percentage"),
        col2: formatValue(statistics.normal.damageChance, "percentage"),
        col3: formatValue(statistics.advantage.damageChance, "percentage"),
      },
      ...generateDynamicProbabilityRows(
        {
          disadvantage: statistics.disadvantage.outcomes,
          normal: statistics.normal.outcomes,
          advantage: statistics.advantage.outcomes,
        },
        "atLeastOneProbability",
        formatAccuracyLabel
      ),
    ],
  };

  const outcomes: Section = {
    id: "outcomes",
    header: "Outcomes",
    columns: ["DIS", "Normal", "ADV"],
    rows: generateDynamicProbabilityRows(
      {
        disadvantage: statistics.disadvantage.outcomes,
        normal: statistics.normal.outcomes,
        advantage: statistics.advantage.outcomes,
      },
      "allProbability",
      formatAllLabel
    ),
  };

  return [damageOutput, accuracy, outcomes, damageBreakdown, consistency];
}

/* 4-column helpers for the stats table (label + 3 value columns) */

type TableWidths = [number, number, number, number];

function measureColWidthsFromSections(sections: Section[]): TableWidths {
  const labelW = Math.max(
    "LABEL".length,
    ...sections.flatMap((s) => [
      s.header.length,
      ...s.rows.map((r) => String(r.label ?? "").length),
    ])
  );

  const colW = (idx: 0 | 1 | 2) =>
    Math.max(
      ...sections.map((s) =>
        Math.max(
          s.columns[idx]?.length ?? 0,
          ...s.rows.map(
            (r) =>
              String((idx === 0 ? r.col1 : idx === 1 ? r.col2 : r.col3) ?? "")
                .length
          )
        )
      ),
      3
    );

  return [labelW, colW(0), colW(1), colW(2)];
}

function divider4(
  widths: TableWidths,
  left: string = B.ml,
  mid: string = B.mm,
  right: string = B.mr
) {
  const [w0, w1, w2, w3] = widths;
  return dividerN([w0, w1, w2, w3], left, mid, right);
}

function row4(
  [c0, c1, c2, c3]: [string, string, string, string],
  widths: TableWidths
) {
  return rowN([c0, c1, c2, c3], widths, ["left", "right", "right", "right"]);
}

/** Render the full statistics panel as ASCII lines, using 4-column layout. */
function renderSectionsToLines(sections: Section[]): string[] {
  if (!sections.length) return ["<no statistics>"];
  const widths = measureColWidthsFromSections(sections);
  const out: string[] = [];

  sections.forEach((sec, i) => {
    out.push(
      divider4(widths, i === 0 ? B.tl : B.ml, B.tm, i === 0 ? B.tr : B.mr)
    );
    out.push(
      row4(
        [
          sec.header.toUpperCase(),
          sec.columns[0] || "",
          sec.columns[1] || "",
          sec.columns[2] || "",
        ],
        widths
      )
    );
    out.push(divider4(widths));
    for (const r of sec.rows) {
      out.push(
        row4(
          [
            String(r.label ?? ""),
            String(r.col1 ?? ""),
            String(r.col2 ?? ""),
            String(r.col3 ?? ""),
          ],
          widths
        )
      );
    }
  });

  out.push(divider4(widths, B.bl, B.bm, B.br));
  return out;
}

export function printStatisticsPanelASCII(
  statistics?: DynamicExpressionStatistics
) {
  if (!statistics) {
    printTableWithTab(
      "Statistics",
      [""],
      [20],
      [["<no statistics>"]],
      ["left"]
    );
    return;
  }

  const sections = buildSectionsFromStats(statistics);
  const widths = measureColWidthsFromSections(sections);

  // Build table with proper section dividers
  const lines: string[] = [];
  const aligns: ("left" | "right")[] = ["left", "right", "right", "right"];

  // Start with the tab header
  const tabText = " Statistics ";
  const tabWidth = Math.max(12, tabText.length);

  // Tab top and content
  lines.push(B.tl + B.h.repeat(tabWidth) + B.tr);
  lines.push(B.v + tabText.padEnd(tabWidth, " ") + B.v);

  // Tab-to-table connector (continuous line)
  const totalTableWidth =
    widths.reduce((sum, w) => sum + w + 2, 0) + widths.length + 1; // +2 padding, +1 borders

  // Build connector: ├[tabWidth]┴[continuous line]┐
  let connector = B.ml; // Start with ├
  connector += B.h.repeat(tabWidth); // Tab width horizontal line
  connector += B.bm; // Add ┴ where tab ends

  // Fill remaining width with horizontal line (no column separators)
  const remainingWidth = totalTableWidth - tabWidth - 3; // -3 for ├, ┴, ┐
  if (remainingWidth > 0) {
    connector += B.h.repeat(remainingWidth);
  }

  connector += B.tr; // End with ┐
  lines.push(connector);

  // Add sections with proper dividers
  sections.forEach((sec, i) => {
    // Add section separator before header (except first section) - uses ┴ to connect data above but disconnect header below
    if (i > 0) {
      lines.push(dividerN(widths, B.ml, B.bm, B.mr));
    }

    // Section header row (always use normal column structure)
    lines.push(
      rowN(
        [
          sec.header.toUpperCase(),
          sec.columns[0] || "",
          sec.columns[1] || "",
          sec.columns[2] || "",
        ],
        widths,
        aligns
      )
    );
    // Add divider below header (normal column structure - connects downward)
    lines.push(dividerN(widths, B.ml, B.mm, B.mr));

    // Section data rows
    for (const r of sec.rows) {
      lines.push(
        rowN(
          [
            " " + String(r.label ?? ""), // Indent data rows by 1 space
            String(r.col1 ?? ""),
            String(r.col2 ?? ""),
            String(r.col3 ?? ""),
          ],
          widths,
          aligns
        )
      );
    }
  });

  // Bottom border
  lines.push(dividerN(widths, B.bl, B.bm, B.br));

  // Print the lines
  lines.forEach((line) => console.log(line));
  console.log("");
}

/* ───────────────────────────── Stats Builder (from queries) ───────────────────────────── */

export type DynamicExpressionStatistics = {
  disadvantage: Snapshot;
  normal: Snapshot;
  advantage: Snapshot;
  standardDeviation: number;
};

/** Thin adapter around per-band `query.snapshot()`. */
// buildDynamicExpressionStatistics
export function buildDynamicExpressionStatistics(args: {
  normal: DiceQuery;
  advantage?: DiceQuery;
  disadvantage?: DiceQuery;
}) {
  const normal = args.normal.snapshot();
  const advantage = (args.advantage ?? args.normal).snapshot();
  const disadvantage = (args.disadvantage ?? args.normal).snapshot();

  return {
    normal,
    advantage,
    disadvantage,
    standardDeviation: args.normal.stddev(),
  };
}

/* ───────────────────────────── Orchestrator ───────────────────────────── */
