// One instance owns uploaded packages; all chart selection lives on chart records
export class FileStore {
  #packages = new Map();

  /**
   * @param {string} id     Package identity
   * @param {Object} data   Package record
   * @returns {Object}      The stored record
   */
  add(id, data) {
    this.#packages.set(id, data);
    return data;
  }

  /**
   * @param {string} id       Package identity
   * @returns {Object|null}   The record, if present
   */
  get(id) {
    return this.#packages.get(id) || null;
  }

  /**
   * @param {string} id   Package identity
   * @returns {boolean}   Whether a record was removed
   */
  delete(id) {
    return this.#packages.delete(id);
  }

  /**
   * @returns {Object[]} Top level packages in upload order
   */
  getAll() {
    return [...this.#packages.values()];
  }

  // Remove every uploaded package from the session
  clear() {
    this.#packages.clear();
  }

  /**
   * Find a difficulty anywhere in the package tree, including nested archives
   * 
   * @param {string} id                                 Chart identity
   * @returns {{chart: Object, package: Object}|null}   The chart and its owning package
   */
  findChart(id) {
    const visit = (p) => {
      for (const c of p.charts) {
        if (c.id === id) return { chart: c, package: p };
      }
      
      for (const child of p.archives.values()) {
        const found = visit(child);
        if (found) return found;
      }

      return null;
    };

    for (const p of this.#packages.values()) {
      const found = visit(p);
      if (found) return found;
    }

    return null;
  }
}
