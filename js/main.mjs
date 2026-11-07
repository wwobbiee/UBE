import { droppedFiles } from "./controllers/uploadController.js";
import { renderBmsMix } from "./services/audioService.js";
import { initWorkspaceTabs } from "./controllers/workspaceController.js";
import { renderConversionResult } from "./views/conversionResult.mjs";
import { renderPackages, updatePackageSelection, expandPackageGroups } from "./views/fileListElement.mjs";


let worker;
let sequence = 0;
let busy = false;
let packages = [];
let urls = [];
let epoch = 0;

const $ = (selector) => document.querySelector(selector);
const pending = new Map();


/**
 * @param {string} message    Status text
 * @param {boolean} error     Whether it describes a failure
 */
function status(message, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}

// Start the processing worker and connect progress, results and failures
function startWorker() {
  worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });

  worker.onmessage = ({ data }) => {
    if (data.progress) {
      status(data.progress);
      return;
    }

    const p = pending.get(data.id);
    if (!p) {
      return;
    }

    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
  };

  worker.onerror = (event) => {
    const error = new Error(event.message || "The processing worker failed. Reload the page to retry.");
    
    for (const p of pending.values()) {
      p.reject(error);
    }

    pending.clear();
    status(error.message, true);
  };
}

/**
 * Send a correlated request to the current processing worker
 * 
 * @param {string} action     Worker command
 * @param {Object} data       Command payload
 * @returns {Promise<*>}      The worker result
 */
function call(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });

    worker.postMessage({ id, action, ...data });
  });
}

/**
 * @param {Object[]} ps     Package tree
 * @returns {Object[]}      All nested difficulties
 */
const allCharts = (ps) => ps.flatMap((p) => [...p.charts, ...allCharts(p.archives)]);

// Keep converter controls consistent with the current busy and selection state
function updateControls() {
  const charts = allCharts(packages);
  const selected = charts.filter((c) => c.selected).length;

  $("#selection-count").textContent = `${selected} / ${charts.length} difficulties selected`;
  for (const control of document.querySelectorAll("#workspace button,#workspace select,#workspace input")) {
    control.disabled = busy || control.dataset.empty === "true";
  }

  $("#convert-btn").disabled  = busy || !selected;
  $("#clear-btn").disabled    = busy || !packages.length;
  $("#expand-all").disabled   = busy || !packages.length;
  $("#collapse-all").disabled = busy || !packages.length;

  // Canceling must remain available while the other converter controls are locked
  $("#cancel-btn").disabled = false;
  $("#cancel-btn").hidden   = !busy;
  $("#workspace").setAttribute("aria-busy", String(busy));

  if (charts.length === 0) {
    $("#upload-controls").classList.add("hidden");
  } else {
    $("#upload-controls").classList.remove("hidden");
  }
}

// Revoke stale blob URLs whenever source data or the export target changes
function invalidateDownload() {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }

  urls = [];
  $("#results").hidden = true;
  $("#download-links").replaceChildren();
}

// Render the imported package tree and bind its edit, remove and inspect actions
function render() {
  renderPackages($(".file-list"), packages, {
    select: selectDifficulties,
    edit: async (chartId, patch) =>
      run(async () => {
        const r = await call("edit", { chartId, patch });
        packages = r.packages;

        invalidateDownload();
        render();
        status("Chart changes saved.");
      }),
    remove: (packageId) =>
      run(async () => {
        packages = (await call("remove", { packageId })).packages;

        invalidateDownload();
        render();
        status("Removed from this session.");
      }),
    inspect: (chartId) =>
      run(async () => {
        const map = await call("inspect", { chartId });
        const view = $("#json-view");

        view.textContent = JSON.stringify(map, null, 2);

        $("#inspector").hidden = false;
        $("#inspector").scrollIntoView({ behavior: "smooth", block: "start" });
      }),

    onError: (message) => status(message, true)
  });

  updateControls();
}

/**
 * Apply a whole group or individual selection through one atomic worker request
 * Only selection fields in the local summary are updated from the worker response
 * 
 * @param {string[]} chartIds   Explicit IDs, including nested difficulties when grouped
 * @param {string} mode         all, none or invert
 */
async function selectDifficulties(chartIds, mode) {
  await run(async () => {
    const result = await call("select", { chartIds, mode });
    const selection = new Map(result.selection.map((chart) => [chart.id, chart.selected]));

    for (const chart of allCharts(packages)) {
      if (selection.has(chart.id)) chart.selected = selection.get(chart.id);
    }

    invalidateDownload();
    status("Difficulty selection updated.");
  });

  // Also restore the native checkbox from the last authoritative summary on rejection
  updatePackageSelection($(".file-list"), packages);
}

/**
 * @param {function(): Promise<void>} fn Work guarded by the current cancellation epoch
 */
async function run(fn) {
  if (busy) {
    return;
  }

  const current = epoch;
  busy = true;

  updateControls();

  try {
    await fn();
  } catch (err) {
    if (current === epoch) status(err.message, true);

  } finally {
    if (current === epoch) {
      busy = false;
      updateControls();
    }
  }
}

/**
 * @param {File[]} files Files supplied by the picker, folder picker or drop controller
 */
async function upload(files) {
  if (!files.length) {
    return;
  }

  await run(async () => {
    $("#upload-controls").classList.remove("hidden");
    invalidateDownload();
    status("Reading files locally...");
    
    const r = await call("import", { files: [...files] });
    packages = r.packages;

    render();

    status(r.errors.length
        ? r.errors.join("\n")
        : `Ready. ${allCharts(packages).length} difficulties loaded.`,
      !!r.errors.length
    );
  });

  $("#file-input").value   = "";
  $("#folder-input").value = "";
}

/**
 * @param {string} name           Filename
 * @param {Blob} blob             Content
 * @param {string} label          Link text
 * @returns {HTMLAnchorElement}   A tracked download link
 */
function downloadLink(name, blob, label = name) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);

  urls.push(url);
  a.href        = url;
  a.download    = name;
  a.textContent = label;
  a.className   = "download-link";

  return a;
}

// Export selected difficulties, render any BMS audio jobs and present downloads
async function convert() {
  await run(async () => {
    const current = epoch;

    invalidateDownload();

    const target = $("#target-format").value;
    status("Preparing conversion...");

    const jobs = await call("mix-jobs", { target });
    const mixes = [];

    for (const job of jobs) {
      status(`Rendering BMS audio: ${job.path}`);
      mixes.push(await renderBmsMix(job));

      if (current !== epoch) {
        return;
      }
    }

    const result = await call("export", { target, mixes });
    renderConversionResult(result, downloadLink);

    if (result.error) {
      status(result.error, true);
      return;
    }

    status(`Complete - ${result.name}`);
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// Clear imported data through the existing worker, keeping the worker reusable
async function clearSession() {
  await run(async () => {
    await call("clear");

    packages = [];
    invalidateDownload();

    $("#inspector").hidden = true;

    render();
    status("Ready for files.");
  });
}

// Cancel pending work and replace the worker so late responses cannot restore state
function cancelSession() {
  epoch++;
  worker.terminate();

  for (const request of pending.values()) {
    request.reject(new Error("Cancelled. The session was cleared; add your files again."));
  }

  pending.clear();
  packages = [];
  startWorker();

  busy = false;
  invalidateDownload();

  $("#inspector").hidden = true;

  render();
  status("Cancelled. Session cleared; add your files again.");
}

// Connect the converter controls once; workspace tabs never reinitialize them
function init() {
  initWorkspaceTabs($('[role="tablist"]'));

  if (location.protocol === "file:") {
    status("Open UBE through a local server (npm run dev or python -m http.server). Browser workers cannot run from file://.", true);

    return;
  }

  startWorker();
  $("#upload-btn").onclick    = () => $("#file-input").click();
  $("#folder-btn").onclick    = () => $("#folder-input").click();
  $("#file-input").onchange   = () => upload([...$("#file-input").files]);
  $("#folder-input").onchange = () => upload([...$("#folder-input").files]);

  const zone = $("#drop-zone");

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!busy) {
      zone.classList.add("dragging");
    }
  });

  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("dragging");

    if (busy) {
      return;
    }

    try {
      await upload(await droppedFiles(e.dataTransfer));
    } catch (error) {
      status(error.message, true);
    }
  });

  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  $("#expand-all").onclick   = () => expandPackageGroups($(".file-list"), true);
  $("#collapse-all").onclick = () => expandPackageGroups($(".file-list"), false);
  $("#convert-btn").onclick  = convert;
  $("#clear-btn").onclick    = clearSession;
  $("#cancel-btn").onclick   = cancelSession;

  $("#close-inspector").onclick = () => {
    $("#inspector").hidden = true;
    $("#json-view").textContent = "";
  };

  $("#download-json").onclick = () => {
    const a = downloadLink("beatmap.ube", new Blob([$("#json-view").textContent], { type: "application/json" }));
    a.click();
  };

  $("#target-format").onchange = invalidateDownload;

  render();
}

init();
