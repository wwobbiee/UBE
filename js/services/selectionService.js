/**
 * Change canonical difficulty selection in one validated, atomic operation
 * Resolve every requested ID before writing so stale groups cannot partly apply
 * 
 * @param {Object[]} packages     Worker-owned packages (archives are Maps)
 * @param {string[]} chartIds     Explicit difficulty IDs, not source file paths
 * @param {string} mode           "all", "none" or "invert"
 * @returns {Object[]}            Authoritative selection for the targeted difficulties only
 * @throws {Error}                If the mode, IDs or any target is invalid
 */
export function selectCharts(packages, chartIds, mode) {
  if (!["all", "none", "invert"].includes(mode)) {
    throw new Error("Invalid selection mode.");
  }

  if (!Array.isArray(chartIds) || chartIds.some((id) => typeof id !== "string")) {
    throw new Error("Selection requires difficulty IDs.");
  }

  const wanted = new Set(chartIds);
  const found  = new Map();

  /**
   * @param {Object} p Package in the canonical tree
   */
  function visit(p) {
    for (const chart of p.charts) {
      if (wanted.has(chart.id)) {
        found.set(chart.id, chart);
      }
    }

    for (const child of p.archives.values()) {
      visit(child);
    }
  }

  for (const p of packages) {
    visit(p);
  }

  if (found.size !== wanted.size) {
    throw new Error("A selected difficulty no longer exists.");
  }

  const selection = [];
  for (const chart of found.values()) {
    chart.selected = mode === "invert" ? !chart.selected : mode === "all";
    selection.push({ id: chart.id, selected: chart.selected });
  }

  return selection;
}
