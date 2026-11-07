import { fileStore } from "./models/fileStoreInstance.mjs";
import { selectCharts } from "./services/selectionService.js";
import { importFiles, packageSummary, exportPackages, makeMixJobs } from "./services/fileService.js";


/**
 * @returns {Object[]} Transferable summaries of every package in the store
 */
const summaries = () => fileStore.getAll().map(packageSummary);

/**
 * Apply a validated metadata, selection, mirror or offset patch to a chart record
 * The worker passes a private clone, so a rejected patch leaves the stored chart intact
 * 
 * @param {Object} c        Chart record ({selected, map}) to modify in place
 * @param {Object} patch    Editor fields; omitted fields remain unchanged
 * @throws {Error}          If a text, numeric or offset field is out of range
 */
function editChart(c, patch) {
  const m = c.map;

  if (typeof patch.selected === "boolean") {
    c.selected = patch.selected;
  }

  for (const key of ["title", "artist", "creator", "version"]) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== "string" || patch[key].length > 1024) {
        throw new Error("Metadata must be text under 1,024 characters.");
      }

      m.metadata[key] = patch[key];
    }
  }

  for (const [key, object, field, min, max] of [
    ["rating",            m.difficulty, "rating",            1, 999],
    ["overallDifficulty", m.difficulty, "overallDifficulty", 0, 10],
    ["previewTime",       m.audio,      "previewTime",      -1, 86400000]
  ]) {
    if (patch[key] !== undefined) {
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`Invalid ${key}.`);
      }

      object[field] = n;
    }
  }

  for (const [key, obj, field] of [["audioFile", m.audio, "file"], ["background", m.visual, "background"]]) {
    if (patch[key] !== undefined) {
      obj[field] = String(patch[key]).slice(0, 1024);
    }
  }
  if (patch.mirror) {
    for (const n of m.hitObjects) {
      n.lane = m.difficulty.keyCount - 1 - n.lane;
    }
  }

  if (patch.offset) {
    const shift = Number(patch.offset);

    if (!Number.isFinite(shift) || Math.abs(shift) > 600000) {
      throw new Error("Timing offset must be within +-600,000 ms.");
    }

    for (const n of m.hitObjects) {
      n.time += shift;
      if (n.endTime !== null) {
        n.endTime += shift;
      }
    }

    for (const p of m.timing.points) {
      p.time += shift;
    }

    for (const p of [...m.timing.modifiers.stops, ...m.timing.modifiers.scrollVelocities]) {
      p.time += shift;
    }

    m.timing.beatZeroTime += shift;
    for (const e of m.audio.events) {
      e.time += shift;
    }
  }
}


/**
 * Add newly imported packages to the store
 * Loose files join the existing loose package unless a
 *  path would collide, in which case they form a separate package
 * 
 * @param {Object[]} packages Packages returned by importFiles
 */
function storeImportedPackages(packages) {
  for (const p of packages) {
    const existing  = !p.archive && fileStore.getAll().find((item) => !item.archive);
    const collision = existing && [...p.entries.keys()].some((path) => existing.entries.has(path));

    if (existing && !collision) {
      for (const [path, entry] of p.entries) {
        existing.entries.set(path, entry);
      }

      existing.charts.push(...p.charts);
      existing.errors.push(...p.errors);
    } else {
      fileStore.add(p.id, p);
    }
  }
}

let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { id, action } = data;
    const progress = (message) => self.postMessage({ id, progress: message });

    try {
      let result;
      if (action === "import") {
        const imported = await importFiles(data.files, progress);

        storeImportedPackages(imported.packages);
        result = { packages: summaries(), errors: imported.errors };
      } else if (action === "select") {
        result = { selection: selectCharts(fileStore.getAll(), data.chartIds, data.mode) };

      } else if (action === "edit") {
        const found = fileStore.findChart(data.chartId);
        if (!found) {
          throw new Error("Chart no longer exists.");
        }

        const copy = structuredClone(found.chart);
        editChart(copy, data.patch);
        Object.assign(found.chart, copy);
        result = { packages: summaries() };

      } else if (action === "remove") {
        fileStore.delete(data.packageId);
        result = { packages: summaries() };

      } else if (action === "clear") {
        fileStore.clear();
        result = { packages: [] };

      } else if (action === "inspect") {
        const found = fileStore.findChart(data.chartId);
        if (!found) {
          throw new Error("Chart no longer exists.");
        }

        result = found.chart.map;

      } else if (action === "mix-jobs") {
        result = await makeMixJobs(fileStore.getAll(), data.target);

      } else if (action === "export")
        result = await exportPackages(fileStore.getAll(), data.target, {
          mixes: data.mixes || [],
          progress
        });

      else {
        throw new Error("Unknown operation.");
      }

      self.postMessage(
        { id, result },
        result?.bytes ? [result.bytes.buffer] : []
      );

    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  });
};
