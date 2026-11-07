/**
 * @param {string} path   Relative source path
 * @returns {string}      Its directory, or root
 */
function directoryOf(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Describe visual folders without changing package storage or export paths
 * Only directories containing charts or archives get wrappers
 * Each is attached to its nearest existing ancestor, skipping empty intermediate
 *  path components
 * Keys contain package ID and full directory, never just a shared basename
 * 
 * @param {Object} p    Package summary (archives are arrays)
 * @returns {Object}    View-only group with all descendant difficulty IDs
 */
export function packageGroup(p) {
  const folders = new Map();
  const root = {
    key:       JSON.stringify([p.id, "package"]),
    name:      p.path || p.name,
    packageId: p.id,
    charts:    [],
    children:  [],
    errors:    p.errors
  };

  /**
   * @param {string} directory Full relative directory
   * @returns {Object} Visual group
   */
  function folder(directory) {
    if (!directory) {
      return root;
    }

    if (!folders.has(directory)) {
      folders.set(directory, {
        key:      JSON.stringify([p.id, "folder", directory]),
        name:     directory,
        charts:   [],
        children: [],
        errors:   []
      });
    }

    return folders.get(directory);
  }

  for (const chart of p.charts) {
    folder(directoryOf(chart.path)).charts.push(chart);
  }
  for (const archive of p.archives) {
    folder(directoryOf(archive.path || archive.name));
  }
  for (const [directory, group] of folders) {
    let parent = directoryOf(directory);
    while (parent && !folders.has(parent)) {
      parent = directoryOf(parent);
    }

    folder(parent).children.push(group);
  }
  for (const archive of p.archives) {
    folder(directoryOf(archive.path || archive.name)).children.push(packageGroup(archive));
  }

  /**
   * @param {Object} group Visual group
   * @returns {string[]} All descendant IDs
   */
  function collect(group) {
    group.chartIds = [...group.charts.map((chart) => chart.id)];
    for (const child of group.children) {
      group.chartIds.push(...collect(child));
    }

    return group.chartIds;
  }

  collect(root);

  return root;
}
