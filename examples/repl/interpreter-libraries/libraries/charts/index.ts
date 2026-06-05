const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Render a horizontal ASCII bar chart.
 *
 * @param items - Array of objects to chart.
 * @param labelKey - Property name used as the row label.
 * @param valueKey - Property name used as the numeric value.
 * @param opts - Optional display settings.
 * @returns Multi-line string with one bar per item.
 */
export function barChart(
  items: { [key: string]: unknown }[],
  labelKey: string,
  valueKey: string,
  opts?: {
    width?: number;
    maxValue?: number;
    fillChar?: string;
    emptyChar?: string;
  },
): string {
  const width = opts?.width ?? 20;
  const fillChar = opts?.fillChar ?? "█";
  const emptyChar = opts?.emptyChar ?? "░";

  const maxLabel = Math.max(...items.map((r) => String(r[labelKey]).length));
  const maxVal =
    opts?.maxValue ?? Math.max(...items.map((r) => Number(r[valueKey])));

  return items
    .map((r) => {
      const label = String(r[labelKey]).padEnd(maxLabel);
      const val = Number(r[valueKey]);
      const filled = maxVal > 0 ? Math.round((val / maxVal) * width) : 0;
      const bar = fillChar.repeat(filled) + emptyChar.repeat(width - filled);
      return `${label}  ${bar} ${val}`;
    })
    .join("\n");
}

/**
 * Render a comparison matrix of items across multiple criteria.
 *
 * @param items - Array of objects to compare.
 * @param labelKey - Property name used as the row label.
 * @param criteriaKeys - Property names for the criteria columns.
 * @returns Multi-line string with padded columns.
 */
export function comparisonMatrix(
  items: { [key: string]: unknown }[],
  labelKey: string,
  criteriaKeys: string[],
): string {
  const maxLabel = Math.max(...items.map((r) => String(r[labelKey]).length), 0);
  const colWidths = criteriaKeys.map((key) =>
    Math.max(key.length, ...items.map((r) => String(r[key] ?? "").length)),
  );

  const header =
    "".padEnd(maxLabel) +
    "  " +
    criteriaKeys.map((k, i) => k.padEnd(colWidths[i])).join("  ");

  const rows = items.map((r) => {
    const label = String(r[labelKey]).padEnd(maxLabel);
    const cols = criteriaKeys
      .map((k, i) => String(r[k] ?? "").padEnd(colWidths[i]))
      .join("  ");
    return `${label}  ${cols}`;
  });

  return [header, ...rows].join("\n");
}

/**
 * Render an inline sparkline from numeric values.
 *
 * @param values - Array of numbers to visualize.
 * @returns A single-line string of Unicode block elements.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (BLOCKS.length - 1));
      return BLOCKS[idx];
    })
    .join("");
}
