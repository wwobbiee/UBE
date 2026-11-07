import { JSZip } from "./dependencies.js";
import { parseBeatmap, serializeBeatmap } from "../ube.js";
import { BEATMAP_EXTS, ARCHIVE_EXTS, OUTPUT_EXTS, getExtension, stem, dirname, basename } from "../models/extensions.mjs";
import { tags, unescapeTag } from "../parsers/stepmaniaParser.js";

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10000;
const MAX_DEPTH = 5;

/**
 * @returns {string} A new random package/chart identity
 */
const uid = () => crypto.randomUUID();

/**
 * Normalize a package relative path, rejecting traversal and empty results
 * 
 * @param {string} path     Input file/directory name
 * @returns {string}        Nonempty normalized relative path
 * @throws {Error}          Unsafe path, including dot only normalized paths
 */
export function safePath(path) {
  const p = String(path).replace(/\\/g, "/");
  if (!p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.split("/").includes("..") || /[\0-\x1f]/.test(p)) {
    throw new Error("Unsafe file path in input.");
  }

  const normalized = p
    .split("/")
    .filter((x) => x && x !== ".")
    .join("/");

  if (!normalized) {
    throw new Error("Unsafe file path in input.");
  }

  return normalized;
}

/**
 * @param {string} name       Display name (archive filename or "Loose files")
 * @param {boolean} archive   Whether the package came from an archive
 * @returns {Object}          An empty package record
 */
function newPackage(name, archive) {
  return {
    id: uid(),
    name,
    archive,
    entries:  new Map(),
    archives: new Map(),
    charts:   [],
    errors:   [],
    warnings: []
  };
}

/**
 * Decode chart bytes as UTF-8, falling back to Shift_JIS for BMS and Windows-1252 otherwise
 * 
 * @param {Uint8Array} bytes    Raw chart file
 * @param {string} extension    Source extension
 * @returns {string}            Decoded text without a byte-order mark
 */
export function decodeText(bytes, extension) {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch {
    if (["bms", "bme", "bml", "pms"].includes(extension)) {
      return new TextDecoder("shift_jis").decode(bytes);
    }

    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Add one file to a package: expand nested archives or parse charts, retaining
 * the original bytes when either fails
 * 
 * @param {Object} p                                  Package receiving the entry
 * @param {string} path                               Package-relative path
 * @param {Uint8Array} bytes                          File contents
 * @param {{bytes: number, files: number}} budget     Shared size and count limits
 * @param {number} depth                              Current archive nesting depth
 * @param {function(string): void} [progress]         Progress callback
 * @throws {Error}                                    For unsafe or duplicate paths, or exceeded limits
 */
async function addEntry(p, path, bytes, budget, depth, progress) {
  path = safePath(path);
  if (p.entries.has(path) || p.archives.has(path)) {
    throw new Error(`Duplicate input path: ${path}`);
  }

  if (++budget.files > MAX_FILES) {
    throw new Error(`Input exceeds ${MAX_FILES.toLocaleString()} entries.`);
  }

  budget.bytes += bytes.byteLength;
  if (budget.bytes > MAX_BYTES) {
    throw new Error("Expanded input exceeds 512 MiB.");
  }

  if (ARCHIVE_EXTS.has(getExtension(path))) {
    try {
      p.archives.set(path, await readArchive(bytes, basename(path), budget, depth + 1, progress));
    } catch (e) {
      p.entries.set(path, { bytes });
      p.errors.push(`${path}: ${e.message} (original archive retained).`);
    }

    return;
  }

  p.entries.set(path, { bytes });
  if (!BEATMAP_EXTS.has(getExtension(path))) {
    return;
  }

  progress?.(`Reading ${path}`);

  try {
    if (bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error("Beatmap text exceeds 32 MiB.");
    }

    const charts = parseBeatmap(decodeText(bytes, getExtension(path)), path);
    charts.forEach((map, index) => p.charts.push({
      id: uid(),
      path,
      index,
      selected: true,
      map
    }));
  } catch (e) {
    p.errors.push(`${path}: ${e.message} (original file retained).`);
  }
}

/**
 * Read a ZIP-based archive into a package, skipping macOS metadata
 * 
 * @param {Uint8Array} bytes                          Archive contents
 * @param {string} name                               Archive filename
 * @param {{bytes: number, files: number}} budget     Shared size and count limits
 * @param {number} depth                              Nesting depth of this archive
 * @param {function(string): void} [progress]         Progress callback
 * @returns {Promise<Object>}                         The archive package
 * @throws {Error}                                    For excessive nesting, unsafe paths or exceeded limits
 */
async function readArchive(bytes, name, budget, depth, progress) {
  if (depth > MAX_DEPTH) {
    throw new Error(`Nested archive limit is ${MAX_DEPTH}.`);
  }

  const zip = await JSZip.loadAsync(bytes);
  const p   = newPackage(name, true);

  for (const entry of Object.values(zip.files)) {
    const raw = entry.unsafeOriginalName || entry.name;
    safePath(raw);

    if (entry.dir) {
      p.entries.set(entry.name, { directory: true });

      continue;
    }

    if (entry.name.startsWith("__MACOSX/") || basename(entry.name) === ".DS_Store") {
      continue;
    }

    // JSZip exposes central directory sizes before inflation; enforce limits first
    const size = entry._data?.uncompressedSize;
    if (Number.isFinite(size) && budget.bytes + size > MAX_BYTES) {
      throw new Error("Expanded archive exceeds 512 MiB.");
    }

    const data = await entry.async("uint8array");
    await addEntry(p, entry.name, data, budget, depth, progress);
  }

  return p;
}

/**
 * Import uploaded files: each archive becomes a package; other files share "Loose files"
 * 
 * @param {File[]} files                                          Picker, folder or drop files
 * @param {function(string): void} [progress]                     Progress callback
 * @returns {Promise<{packages: Object[], errors: string[]}>}     New packages and per-file failures
 */
export async function importFiles(files, progress = () => {}) {
  const packages = [];
  const errors   = [];
  const loose    = newPackage("Loose files", false);
  const budget   = {
    bytes: 0,
    files: 0
  };

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;

    try {
      if (file.size > MAX_BYTES) {
        throw new Error("File exceeds 512 MiB.");
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (ARCHIVE_EXTS.has(getExtension(file.name))) {
        packages.push(await readArchive(bytes, file.name, budget, 1, progress));
      } else {
        await addEntry(loose, path, bytes, budget, 0, progress);
      }

    } catch (err) {
      errors.push(`${path}: ${err.message}`);
    }
  }

  if (loose.entries.size || loose.archives.size) {
    packages.push(loose);
  }

  return {
    packages,
    errors
  };
}

/**
 * @param {Object} p    Worker owned package
 * @returns {Object}    A structured clone safe summary for the frontend, including nested archives
 */
export function packageSummary(p) {
  return {
    id:       p.id,
    name:     p.name,
    archive:  p.archive,
    files:    p.entries.size,
    errors:   p.errors,
    warnings: p.warnings,
    charts:   p.charts.map((c) => ({
      id:       c.id,
      path:     c.path,
      selected: c.selected,
      title:    c.map.metadata.title,
      artist:   c.map.metadata.artist,
      creator:  c.map.metadata.creator,
      version:  c.map.metadata.version,
      keyCount: c.map.difficulty.keyCount,
      rating:   c.map.difficulty.rating,
      overallDifficulty: c.map.difficulty.overallDifficulty,
      previewTime: c.map.audio.previewTime,
      audioFile:   c.map.audio.file,
      background:  c.map.visual.background,
      notes:       c.map.hitObjects.length,
      holds:       c.map.hitObjects.filter((n) => ["hold", "roll"].includes(n.type)).length,
      bpm:         c.map.timing.baseBPM,
      format:      c.map.provenance.sourceFormat,
      warnings:    c.map.warnings
    })),
    archives: [...p.archives].map(([path, child]) => ({
      path,
      ...packageSummary(child)
    }))
  };
}

/**
 * Resolve a chart's asset reference to a package entry, matching case only when unambiguous
 * 
 * @param {Object} p            Package containing the chart
 * @param {string} chartPath    Chart path within the package
 * @param {string} reference    Reference relative to the chart's directory
 * @returns {string|null}       The package entry path, or null if missing or outside the package
 */
export function resolveAsset(p, chartPath, reference) {
  if (!reference) {
    return null;
  }

  // Resolve ../ within the package, while refusing to escape the package root
  const parts = dirname(chartPath).split("/").filter(Boolean);
  const ref   = String(reference).replace(/\\/g, "/");

  if (ref.startsWith("/") || /^[a-z]+:/i.test(ref)) {
    return null;
  }

  for (const part of ref.split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      if (!parts.length) {
        return null;
      }

      parts.pop();
    } else {
      parts.push(part);
    }
  }

  const path = parts.join("/");
  if (p.entries.has(path)) {
    return path;
  }

  const found = [...p.entries.keys()].filter((n) => n.toLowerCase() === path.toLowerCase());

  return found.length === 1 ? found[0] : null;
}

/**
 * @param {string} chartPath    Chart path within the package
 * @param {string} assetPath    Asset path within the package
 * @returns {string}            The asset path relative to the chart's directory
 */
function relativeAsset(chartPath, assetPath) {
  const from = dirname(chartPath).split("/").filter(Boolean);
  const to   = assetPath.split("/");

  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }

  return "../".repeat(from.length) + to.join("/");
}

// const audioExts = new Set(["mp3", "ogg", "wav"]);
// const imageExts = new Set(["png", "jpg", "jpeg"]);
const nativeExtensions = { osu: "osz", quaver: "qp" };
const unsupportedMedia = new Set([
  "webp",
  "gif",
  "flac",
  "m4a",
  "opus",
  "mp4",
  "avi",
  "webm",
  "mov",
  "mkv",
  "wmv",
  "mpeg",
  "mpg",
  "bmp"
]);

/**
 * @param {string} path     Asset path
 * @param {string} target   Destination format
 * @returns {boolean}       Whether the destination can use this media type
 */
function compatibleAsset(path, target) {
  if (target === "ube") {
    return true;
  }

  const ext = getExtension(path);
  if (ext === "bmp") {
    return target === "beatmania" || target === "stepmania";
  }

  return !unsupportedMedia.has(ext);
}

// StepMania song fields that must match for difficulties to share one .sm file
const SM_IDENTITY_FIELDS = ["TITLE", "SUBTITLE", "ARTIST", "MUSIC"];

// Stepmania song fields stored once per file; the first difficulty's value is kept and differences are reported
const SM_SHARED_FIELDS = {
  BACKGROUND: "Background",
  BANNER: "Banner",
  CREDIT: "Credit",
  SAMPLESTART: "Preview start"
}

// Tolerance for compating serialized StepMania beats, BPMs and seconds (written to 9 decimal)s
const SM_EPSILON = 1e-6;


/**
 * Read the song header of serialized SM text - its fields and effective timing
 * Redundant BPM entries (like an unchanged temp, or a same-beat entry overridden
 *  by a later one) and zero-length stops are dropped; same-beat stops add together
 * 
 *  
 * @param {string} text   Serialized SM text with one #NOTES block
 * @returns {{fields: Object<string, string>, offset: number, bpms: number[][], stops: number[][]}}
 */
function smSongHeader(text) {
  const fields = {};
  for (const [key, value] of tags(text.slice(0, text.indexOf("#NOTES:")))) {
    fields[key] = unescapeTag(value);
  }

  const pairs = (value) => (value || "")
    .split(",")
    .map((pair) => pair.split("=").map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
    .sort((a,b) => a[0] - b[0]);

  const changes = [];
  for (const [beat, bpm] of pairs(fields.BPMS)) {
    if (changes.length && Math.abs(changes.at(-1)[0] - beat) < SM_EPSILON) {
      changes.pop();
    }

    changes.push([beat, bpm]);
  }

  const bpms = changes.filter(([, bpm], i) => i === 0 || Math.abs(changes[i - 1][1] - bpm) >= SM_EPSILON);
  const stops = [];

  for (const [beat, seconds] of pairs(fields.STOPS)) {
    if (Math.abs(seconds) < SM_EPSILON) {
      continue;
    }

    if (stops.length && Math.abs(stops.at(-1)[0] - beat) < SM_EPSILON) {
      stops.at(-1)[1] += seconds;
    } else {
      stops.push([beat, seconds]);
    }
  }

  return {
    fields,
    offset: Number(fields.OFFSET) || 0,
    bpms,
    stops
  };
}

/**
 * Decide whether two SM song headers can share one file
 * 
 * @param {Object} a                    Header from smSongHeader
 * @param {Object} b                    Header from smSongHeader
 * @returns {"identity"|"timing"|null}  Why they cannot be combined, or null if they can
 */
function smHeaderMismatch(a, b) {
  if (SM_IDENTITY_FIELDS.some((key) => (a.fields[key] || "") !== (b.fields[key] || ""))) {
    return "identity";
  }

  const same = (x, y) => x.length === y.length && x.every((pair, i) => pair.every((value, j) => Math.abs(value - y[i][j]) < SM_EPSILON));
  if (Math.abs(a.offset - b.offset) >= SM_EPSILON || !same(a.bpms, b.bpms) || !same(a.stops, b.stops)) {
    return "timing";
  }

  return null;
}

/**
 * Add a compatible difficulty to a combined SM song file
 * A missing background or banner is taken from the new difficulty;
 *  other differing song-level values keep the file's existing value
 *  and are reported
 * 
 * @param {Object} group                    Combined file: {path, header, map, head, notes}; map is the first difficulty's export clone, head its header text
 * @param {Object} header                   The joining difficulty's header from smSongHeader
 * @param {string} notes                    Its #NOTES block
 * @param {function(string): void} note     Reports a message for the joining difficulty
 * @returns {string} The combined file text
 */
function joinSmGroup(group, header, notes, note) {
  let adopted = false;

  for (const [key, label] of Object.entries(SM_SHARED_FIELDS)) {
    const kept  = group.header.fields[key] || "";
    const value = header.fields[key] || "";

    if (value === kept) {
      continue;
    }

    if (!kept && (key === "BACKGROUND" || key === "BANNER")) {
      group.map.visual[key.toLowerCase()] = value;
      adopted = true;
      note(`${label} "${value}" from this difficulty is used for the combined song file.`);
    } else {
      note(`${label} "${value}" differs from the combined song file's "${kept}". Legacy SM stores one value per song, so "${kept}" is used${key === "BACKGROUND" || key === "BANNER" ? "; the other image file is still included" : ""}`);
    }
  }

  // Re-serializing the first difficulty keeps the header identical to what later remapping produces
  if (adopted) {
    const text     = serializeBeatmap(group.map, "stepmania").text;
    group.header   = smSongHeader(text);
    group.notes[0] = text.slice(text.indexOf("#NOTES:"));
    group.head     = text.slice(0, text.indexOf("#NOTES:"));
  }

  group.notes.push(notes);

  return group.head + group.notes[0] + group.notes.slice(1).map((block) => "\n" + block).join("");
}


/**
 * Allocate a case-insensitively unique path by appending " (2)", " (3)"...
 * 
 * @param {string} path         Requested path
 * @param {Set<string>} used    Lowercase reserved paths; the result is added
 * @returns {string}            The allocated path
 */
function uniquePath(path, used) {
  let i      = 2;
  let result = path;

  while (used.has(result.toLowerCase())) {
    result = `${stem(path)} (${i++}).${getExtension(path)}`;
  }

  used.add(result.toLowerCase());

  return result;
}

/**
 * @returns {Uint8Array} A minimal valid 16-bit mono 44.1 kHz WAV containing one silent sample
 */
function silentWav() {
  const bytes = new Uint8Array(46);
  const v     = new DataView(bytes.buffer);
  const str   = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));

  str(0, "RIFF");
  v.setUint32(4, 38, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16,    true);
  v.setUint16(20, 1,     true);
  v.setUint16(22, 1,     true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 88200, true);
  v.setUint16(32, 2,     true);
  v.setUint16(34, 16,    true);
  str(36, "data");
  v.setUint32(40, 2, true);

  return bytes;
}

/**
 * List selected keysound-only BMS charts that need a host-rendered music mix
 * 
 * @param {Object[]} packages     Worker-owned packages
 * @param {string} target         Destination format; BMS and UBE keep their samples
 * @returns {Promise<Object[]>}   Mix jobs with events, resolved sample bytes and missing samples
 */
export async function makeMixJobs(packages, target) {
  const jobs = [];
  if (["beatmania", "ube"].includes(target)) {
    return jobs;
  }

  const visit = (p) => {
    for (const c of p.charts) {
      if (!c.selected || c.map.provenance.sourceFormat !== "beatmania" || c.map.audio.file) {
        continue;
      }

      const events = [
        ...c.map.audio.events.map((e) => ({
          time: e.time,
          file: e.file
        })),
        ...c.map.hitObjects
          .filter((n) => n.hitsound)
          .map((n) => ({
            time: n.time,
            file: n.hitsound
          }))
      ];

      if (!events.length) {
        continue;
      }

      const assets  = {};
      const missing = [];

      for (const file of new Set(events.map((e) => e.file))) {
        const path = resolveAsset(p, c.path, file);

        if (path) {
          assets[file] = p.entries.get(path).bytes;
        } else {
          missing.push(file || "(undefined BMS sample)");
        }
      }

      jobs.push({
        id: c.id,
        events,
        assets,
        missing,
        path: dirname(c.path) + stem(basename(c.path)) + `-ube-mix-${c.index + 1}.wav`
      });
    }

    for (const child of p.archives.values()) {
      visit(child);
    }
  };

  for (const p of packages) {
    visit(p);
  }

  return jobs;
}

/**
 * @typedef {Object} ExportChart
 * @property {string} chartId                   Source difficulty identity used for mix associations
 * @property {Object} package                   Original source package; read-only during export
 * @property {string} sourcePath                Original chart path within that package
 * @property {Object} map                       Prepared export clone, separate from the worker's map
 * @property {string|undefined} generatedMix    Package-local generated music path
 * @property {string|undefined} silentPath      Package-local generated BMS silence path
 * 
 * Build one package using existing conversion, failure and SM-combination rules
 *  Retain successful clones for native mapset planning or loose roots needing
 *  outer name allocation
 * Other targets keep the existing clone lifetime
 * 
 * @param {Object} p                          Read-only canonical source package
 * @param {string} target                     Destination format
 * @param {Object[]} report                   Shared conversion diagnostics
 * @param {Object[]} mixes                    Host-rendered audio results
 * @param {function(string): void} progress   Existing progress callback
 * @param {boolean} retainCharts              Keep private records for mapping/mapset planning
 * @returns {Promise<{entries: Map<string, Object>, count: number, exportCharts: Map<string, ExportChart[]>}>}
 * @throws {Error}                            If package preparation or nested archive assembly fails
 */
async function buildPackage(p, target, report, mixes, progress, retainCharts = false) {
  let count           = 0;
  const out           = new Map();
  const exportCharts  = new Map();
  const converted     = new Set();
  const allChartPaths = new Set(p.charts.map((c) => c.path));
  const failed        = new Set();
  const used          = new Set();
  const smGroups      = new Map();

  // Reserve every original asset name; generated charts must never overwrite assets
  for (const [path, entry] of p.entries)
    if (!allChartPaths.has(path)) {
      out.set(path, entry);
      used.add(path.toLowerCase());
    }

  const localReport = (path, message) => report.push({ file: `${p.name}/${path}`, message });

  for (const error of p.errors) {
    localReport("", error);
  }

  for (const c of p.charts) {
    if (!c.selected) {
      continue;
    }

    progress?.(`Converting ${c.path}`);

    let generatedMix;
    const m   = structuredClone(c.map);
    const mix = mixes.find((x) => x.id === c.id);

    if (mix) {
      for (const msg of mix.warnings || []) {
        localReport(c.path, msg);
      }

      if (mix.bytes) {
        generatedMix = uniquePath(mix.path, used);
        m.audio.file = relativeAsset(c.path, generatedMix);
        m.audio.events = [];

        for (const n of m.hitObjects) {
          n.hitsound = "";
        }
      }
    }

    for (const [object, key, kind] of [[m.audio, "file", "Audio"], [m.visual, "background", "Background"], [m.visual, "banner", "Banner"]]) {
      const reference = object[key];
      if (!reference) {
        continue;
      }

      if (generatedMix && key === "file") {
        continue;
      }

      const resolved = resolveAsset(p, c.path, reference);

      if (!compatibleAsset(reference, target)) {
        localReport(c.path, `${kind} "${reference}" omitted: unsupported media extension for ${target}; no transcoding performed.`);
        object[key] = "";

      } else if (!resolved) {
        localReport(c.path, `${kind} asset not supplied: ${reference}. The reference is retained.`);
      } else {
        object[key] = relativeAsset(c.path, resolved);
      }
    }

    if (!m.audio.file && target !== "beatmania" && target !== "ube") {
      localReport(c.path, "No main music file is available; this export contains chart data but needs audio before play.");
    }

    if (target === "beatmania" || target === "ube") {
      const samples = new Set([
        ...m.audio.events.map((e) => e.file),
        ...m.hitObjects.map((n) => n.hitsound)
      ].filter(Boolean));

      const missing = [...samples].filter((file) => !resolveAsset(p, c.path, file));
      if (missing.length) {
        localReport(c.path, `${missing.length} referenced sample(s) not supplied: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " ..." : ""}`);
      }
    }

    try {
      const result = serializeBeatmap(m, target);
      const siblings = p.charts.filter((x) => x.path === c.path).length;
      const suffix =
        siblings > 1
          ? ` [${c.index + 1} ${m.metadata.version || "Chart"}]`.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          : "";

      let path;
      const marker = result.text.indexOf("#NOTES:");
      const header = target === "stepmania" ? smSongHeader(result.text) : null;
      const groups = header ? smGroups.get(dirname(c.path)) || [] : [];
      const group  = groups.find((g) => !smHeaderMismatch(g.header, header));

      if (group) {
        path = group.path;
        out.get(path).text = joinSmGroup(group, header, result.text.slice(marker), (message) => localReport(c.path, message));
      } else {
        path = uniquePath(`${stem(c.path)}${suffix}.${OUTPUT_EXTS[target]}`, used);
        out.set(path, {
          text: result.text,
          chart: true
        });

        if (header) {
          if (groups.some((g) => smHeaderMismatch(g.header, header) === "timing")) {
            localReport(c.path, "This difficulty has the same song and music as another SM file but different timing (offset, BPM changes or stops). Legacy SM stores one timing map per song, so it remains a seperate file.");
          }

          groups.push({
            path,
            header,
            map: m,
            head: result.text.slice(0, marker),
            notes: [result.text.slice(marker)]
          });

          smGroups.set(dirname(c.path), groups);
        }
      }

      if (generatedMix) {
        out.set(generatedMix, {
          bytes: mix.bytes
        });
      }

      let silentPath;
      if (target === "beatmania" && result.text.includes("#WAVZZ __ube_silence.wav")) {
        silentPath = dirname(c.path) + "__ube_silence.wav";

        if (used.has(silentPath.toLowerCase())) {
          const alternative = uniquePath(dirname(c.path) + "__ube_silence-generated.wav", used);

          out.get(path).text = result.text.replace("#WAVZZ __ube_silence.wav", `#WAVZZ ${basename(alternative)}`);
          out.set(alternative, {
            bytes: silentWav()
          });

          silentPath = alternative;
        } else {
          out.set(silentPath, {
            bytes: silentWav()
          });

          used.add(silentPath.toLowerCase());
        }
      }

      if (retainCharts) {
        if (!exportCharts.has(path)) {
          exportCharts.set(path, []);
        }

        exportCharts.get(path).push({
          chartId:    c.id,
          package:    p,
          sourcePath: c.path,
          map:        m,
          generatedMix,
          silentPath,
        });
      }

      for (const message of [...m.warnings, ...result.warnings]) {
        localReport(c.path, message);
      }

      converted.add(c.path);
      count++;

    } catch (err) {
      localReport(c.path, `Conversion failed: ${err.message} Original file retained.`);

      failed.add(c.path);
    }
  }

  for (const [folder, groups] of smGroups) {
    if (groups.length > 1) {
      localReport(folder, "These SM charts have different song metadata/timing and remain separate files. StepMania normally loads one SM per song directory; place these files in separate song folders with their assets.");
    }
  }

  for (const path of failed) {
    const original = uniquePath(path, used);
    out.set(original, p.entries.get(path));
  }

  for (const [path, entry] of [...out]) {
    if (!entry.chart && !entry.directory && !compatibleAsset(path, target)) {
      out.delete(path);
      localReport(path, `Media file omitted for ${target}; no transcoding performed.`);
    }
  }

  for (const [path, child] of p.archives) {
    const built = await buildPackage(child, target, report, mixes, progress, !!nativeExtensions[target]);
    count += built.count;

    if (built.count && nativeExtensions[target]) {
      // A source archive is a namespace, not another mandatory ZIP layer
      // Keep multi-song hierarchy as directories; unwrap a single native deliverable
      let suffix       = 2;
      let prefix       = onlyMapset ? dirname(path) : stem(path) + "/";
      const files      = [...built.entries].filter(([, entry]) => !entry.directory);
      const onlyMapset = files.length === 1 && files[0][1].native;

      if (!onlyMapset) {
        while (used.has(prefix.slice(0, -1).toLowerCase()) || files.some(([name]) => used.has((prefix + name).toLowerCase()))) {
          prefix = stem(path) + ` (${suffix++})/`;
        }
      }

      const paths = new Map();
      for (const [name, entry] of files) {
        const outputPath = uniquePath(prefix + (onlyMapset ? basename(name) : name), used);

        paths.set(name, outputPath);
        out.set(outputPath, entry);
      }

      remapExportCharts({ p: child, ...built }, target, paths, out, used, report);
    } else if (built.count) {
      const name = uniquePath(stem(path) + ".zip", used);
      out.set(name, {
        bytes: await zipEntries(built.entries)
      });

    } else if (child.errors.length) {
      // Retain invalid nested inputs when another chart succeeds
      out.set(uniquePath(path, used), {
        bytes: await zipEntries(built.entries)
      });
    }
  }

  if (nativeExtensions[target]) {
    await packageMapsets(p, { entries: out, exportCharts }, target, report, used);
  }

  return {
    entries: out,
    count,
    exportCharts
  };
}

/**
 * Enumerate filenames actually used by the supported target writers
 * Unknown event/sample payloads are checked separately before native delivery
 * 
 * @param {Object} map      Parsed emitted chart
 * @param {string} target   Native target format
 * @returns {string[]}      Nonempty music/image/custom-sample references
 */
function mapsetReferences(map, target) {
  const references = [map.audio.file, map.visual.background];

  if (target === "quaver") {
    references.push(map.visual.banner, map.ext.quaver?.VideoFile);
  }
  if (target === "osu") {
    references.push(...map.hitObjects.map((note) => note.hitsound));
  }

  return [...new Set(references.filter(Boolean))];
}

/**
 * Recognize the supported music container signatures without decoding media
 * This excludes absent/truncated placeholder assets; it does not certify codecs,
 *  duration or game playback
 * Browser mixing/decoding remains in the existing host
 * 
 * @param {Uint8Array} bytes    Supplied music bytes
 * @param {string} extension    Supported filename extension
 * @returns {boolean}           Recognized basic container/header
 */
function musicContainer(bytes, extension) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    return false;
  }

  const signature = new TextDecoder().decode(bytes.slice(0, 12));
  if (extension === "wav") {
    return bytes.length >= 44 && signature.startsWith("RIFF") && signature.slice(8) === "WAVE";
  }
  if (extension === "ogg") {
    return signature.startsWith("OggS");
  }
  if (extension === "mp3") {
    return signature.startsWith("ID3") || (bytes[0] === 255 && (bytes[1] & 224) === 224);
  }

  return false;
}

/**
 * Turn unambiguous complete song groups into standalone native mapset archives
 * Boundaries use source-package identity, chart directories and resolved music;
 *  metadata corroborates a group but never joins separate paths/packages by title
 * Rebase root-level charts using the existing allocator/reference rewriter
 * Build each candidate on separate clones and validate its emitted references before
 *  removing anything from generic output. Originals/fallbacks and UBE reports stay
 *  outside native archives
 * No claim of destination-game execution is made here
 * 
 * @param {Object} p            Read-only source package
 * @param {Object} built        Mutable private entries/export-chart plan
 * @param {string} target       osu or quaver
 * @param {Object[]} report     Shared user-visible report
 * @param {Set<string>} used    Existing package-local case-insensitive reservations
 * @returns {Promise<void>}
 */
async function packageMapsets(p, built, target, report, used) {
  const groups  = new Map();
  const folders = new Map();
  const sources = new Map(p.charts.map((chart) => [chart.id, chart.map]));

  for (const [path, charts] of built.exportCharts) {
    for (const chart of charts) {
      const folder = dirname(chart.sourcePath);
      const audio  = chart.generatedMix || resolveAsset({ entries: built.entries }, path, chart.map.audio.file);

      // Host mixes can differ between difficulties. Only shared, resolved source
      // sample associations identify them as one song; otherwise keep them apart
      const source      = sources.get(chart.chartId);
      const samples     = chart.generatedMix ? [...source.hitObjects.map((note) => note.hitsound), ...source.audio.events.map((event) => event.file)].filter(Boolean) : [];
      const samplePaths = [...new Set(samples.map((reference) => resolveAsset(p, chart.sourcePath, reference)).filter(Boolean))].sort();
      const association = chart.generatedMix && samplePaths.length ? samplePaths : [audio || chart.sourcePath];
      const key = JSON.stringify([folder, !!chart.generatedMix, association]);

      if (!groups.has(key)) {
        const group = {
          folder,
          charts: [],
          assets: new Set(),
          reason: ""
        };

        groups.set(key, group);

        if (!folders.has(folder)) {
          folders.set(folder, []);
        }

        folders.get(folder).push(group);
      }
      groups.get(key).charts.push({ path, chart, audio });
    }
  }

  const plans = [];
  for (const group of groups.values()) {
    const first    = group.charts[0];
    const identity = JSON.stringify([first.chart.map.metadata.title, first.chart.map.metadata.artist]);
    const peers    = folders.get(group.folder);

    if (group.charts.some(({ chart }) => JSON.stringify([chart.map.metadata.title, chart.map.metadata.artist]) !== identity)) {
      group.reason = "charts sharing music have conflicting song metadata";
    } else if (peers.some((other) => other !== group && JSON.stringify([other.charts[0].chart.map.metadata.title, other.charts[0].chart.map.metadata.artist]) === identity)) {
      group.reason = "matching song metadata has different music associations in the same folder";
    }

    try {
      for (const { path, audio } of group.charts) {
        if (group.reason) {
          break;
        }

        if (!audio || !musicContainer(built.entries.get(audio)?.bytes, getExtension(audio))) {
          group.reason = "main music is missing or has an unrecognized/truncated container";

          break;
        }

        const map            = parseBeatmap(built.entries.get(path).text, path)[0];
        const opaqueEvents   = map.ext.osu?.sections.Events?.some((line) => line.trim() && !/^\/\/|^0,|^Background,/.test(line));
        const storyboardFile = target === "osu" && [...built.entries.keys()].some((path) => dirname(path) === group.folder && getExtension(path) === "osb");
        const opaqueSamples  = map.ext.quaver?.SoundEffects?.length || map.hitObjects.some((note) => note.ext?.quaver?.KeySounds?.length);

        if (!map.hitObjects.length || opaqueEvents || storyboardFile || opaqueSamples) {
          group.reason = "empty chart or opaque storyboard/sample dependencies need manual review";

          break;
        }

        for (const reference of mapsetReferences(map, target)) {
          const resolved = resolveAsset({ entries: built.entries }, path, reference);
          const entry    = built.entries.get(resolved);

          if (!resolved || entry.directory || !entry.bytes || !compatibleAsset(resolved, target)) {
            group.reason = `a referenced asset is unavailable: ${reference}`;

            break;
          }

          if (/^(Thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(basename(resolved))) {
            group.reason = `a referenced file is OS metadata: ${reference}`;

            break;
          }

          group.assets.add(resolved);
        }
      }

    } catch (err) {
      group.reason = `emitted chart validation failed: ${err.message}`;
    }

    if (group.reason) {
      report.push({
        file: `${p.name}/${group.folder}`,
        message: `Native packaging skipped: ${group.reason}. Retaining chart/generic ZIP delivery.`
      });

      continue;
    }

    const paths = [...group.charts.map((c) => c.path), ...group.assets];
    const rootParts = dirname(paths[0]).split("/").filter(Boolean);

    for (const path of paths) {
      const parts = dirname(path).split("/").filter(Boolean);
      
      while (rootParts.some((part, i) => parts[i] !== part)) {
        rootParts.pop();
      }
    }

    const root     = rootParts.length ? rootParts.join("/") + "/" : "";
    const selected = new Map();

    for (const { path } of group.charts) {
      selected.set(path, built.entries.get(path));
    }
    for (const path of group.assets) {
      selected.set(path, built.entries.get(path));
    }

    // Only a uniquely identified song folder owns optional supporting files
    // Failed/opaque chart originals and report sidecars remain in generic delivery
    if (peers.length === 1) {
      for (const [path, entry] of built.entries) {
        if (dirname(path) !== group.folder || entry.directory || entry.chart || entry.native || BEATMAP_EXTS.has(getExtension(path)) || ARCHIVE_EXTS.has(getExtension(path)) || /^UBE-conversion-report(?: \(\d+\))?\.txt$/i.test(basename(path))) {
          continue;
        }

        // Desktop caches/configuration are not song assets
        // Retain their bytes in generic delivery instead of installing them with a native mapset
        if (/^(Thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(basename(path))) {
          report.push({ file: `${p.name}/${path}`, message: "OS metadata retained outside native mapsets." });

          continue;
        }

        selected.set(path, entry);
      }
    }

    const entries      = new Map();
    const allocated    = new Set();
    const mapping      = new Map();
    const exportCharts = new Map();

    // Charts must be at native archive root (also required by osu!stable). Asset
    // subdirectories are retained where possible, with actual references rebased
    const ordered = [...selected].sort(([, a], [, b]) => Number(!!a.chart) - Number(!!b.chart));

    for (const [path, entry] of ordered) {
      if (entry.chart) {
        continue;
      }
      for (let folder = dirname(path.slice(root.length)); folder; folder = dirname(folder.slice(0, -1))) {
        allocated.add(folder.slice(0, -1).toLowerCase());
      }
    }

    for (const [path, entry] of ordered) {
      const name = uniquePath(entry.chart ? basename(path) : path.slice(root.length), allocated);

      mapping.set(path, name);
      entries.set(name, { ...entry });
    }

    for (const { path, chart } of group.charts) {
      exportCharts.set(path, [{ ...chart, map: structuredClone(chart.map) }]);
    }

    const localReport = [];
    try {
      remapExportCharts({ p, exportCharts }, target, mapping, entries, allocated, localReport);

      for (const [path, entry] of entries) {
        if (!entry.chart) {
          continue;
        }

        const map = parseBeatmap(entry.text, path)[0];
        for (const reference of mapsetReferences(map, target)) {
          const resolved = resolveAsset({ entries }, path, reference);
          if (!resolved || !entries.get(resolved)?.bytes) {
            throw new Error(`unresolved packaged reference: ${reference}`);
          }
        }
      }

      const songFolder = root && /^(charts|maps|beatmaps)$/i.test(basename(group.folder.slice(0, -1))) ? root : group.folder;
      let name         = peers.length === 1 && songFolder ? basename(songFolder.slice(0, -1)) : first.chart.map.metadata.title || stem(basename(first.path));
      name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "Mapset";

      const path = uniquePath(dirname(songFolder.slice(0, -1)) + name + "." + nativeExtensions[target], used);
      plans.push({ path, bytes: await zipEntries(entries), selected, group });

      report.push(...localReport);
      report.push({
        file: `${p.name}/${group.folder}`,
        message: `Created ${basename(path)} with ${group.charts.length} difficulty/difficulties and their supplied assets.`
      });

    } catch (err) {
      report.push({
        file: `${p.name}/${group.folder}`,
        message: `Native packaging skipped: ${err.message}. Retaining generic ZIP delivery.`
      });
    }
  }

  const packaged          = new Set(plans.flatMap((plan) => plan.group.charts.map((c) => c.path)));
  const residualCharts    = [...built.exportCharts.keys()].some((path) => !packaged.has(path));
  const retainedOriginals = [...built.entries].some(([path, entry]) => !entry.chart && BEATMAP_EXTS.has(getExtension(path)));

  for (const plan of plans) {
    for (const [path, entry] of plan.selected) {
      // Shared assets remain accessible to any generic fallback charts/originals
      if (entry.chart || (!residualCharts && !retainedOriginals && !p.errors.length)) {
        built.entries.delete(path);
      }
    }
    for (const { path } of plan.group.charts) {
      built.exportCharts.delete(path);
    }

    built.entries.set(plan.path, { bytes: plan.bytes, native: true });
  }
  if (plans.length) {
    for (const [path, entry] of built.entries) {
      if (entry.directory && ![...built.entries.keys()].some((name) => name !== path && name.startsWith(path))) {
        built.entries.delete(path);
      }
    }
  }
}

/**
 * Rewrite supported references after final names for all loose roots are reserved
 * The first serialization established successful outputs and SM combinations; only
 *  affected text is serialized again
 * Records here own export clones, never store maps
 * 
 * @param {Object} built                  One source package's entries and successful chart records
 * @param {string} target                 Existing destination format
 * @param {Map<string, string>} paths     Package-local emitted path to final emitted path
 * @param {Map<string, Object>} entries   Complete outer output namespace
 * @param {Set<string>} used              Case-insensitive reservations, including missing references
 * @param {Object[]} report               Existing conversion report, with collision limitations added
 * @returns {void}
 * @throws {Error}                        If final chart serialization fails
 */
function remapExportCharts(built, target, paths, entries, used, report) {
  const missingPaths = new Map();

  for (const [localPath, charts] of built.exportCharts) {
    let changed      = false;
    const outputPath = paths.get(localPath);

    for (const chart of charts) {
      const map = chart.map;
      const references = new Map();

      /**
       * Resolve in the original package before consulting its own output mapping
       * Keep missing references missing when another root happens to supply that name
       * 
       * @param {string} reference    Canonical source-relative asset reference
       * @returns {string}            Reference relative to the final chart, or unchanged if opaque
       */
      function mapReference(reference) {
        if (!reference) {
          return reference;
        }

        if (references.has(reference)) {
          return references.get(reference);
        }

        const sourcePath = resolveAsset(chart.package, chart.sourcePath, reference);
        let result = reference;

        if (sourcePath && paths.has(sourcePath)) {
          const assetPath = paths.get(sourcePath);

          if (assetPath !== sourcePath || dirname(outputPath) !== dirname(chart.sourcePath)) {
            result = relativeAsset(outputPath, assetPath);
          }
        } else if (!sourcePath) {
          const collision = resolveAsset({ entries }, outputPath, reference);

          if (collision) {
            if (!missingPaths.has(collision)) {
              const missingPath = uniquePath(collision, used);
              missingPaths.set(collision, missingPath);

              report.push({
                file: `${chart.package.name}/${chart.sourcePath}`,
                message: `Missing asset reference "${reference}" changed to "${relativeAsset(outputPath, missingPath)}" to avoid another package's output; no asset was supplied.`
              });
            }

            result = relativeAsset(outputPath, missingPaths.get(collision));
          }
        }

        references.set(reference, result);
        if (result !== reference) {
          changed = true;
        }

        return result;
      }

      if (chart.generatedMix && paths.has(chart.generatedMix)) {
        const reference = relativeAsset(outputPath, paths.get(chart.generatedMix));
        if (reference !== map.audio.file) {
          changed = true;
        }

        map.audio.file = reference;
      } else if (!chart.generatedMix) {
        map.audio.file = mapReference(map.audio.file);
      }

      map.visual.background = mapReference(map.visual.background);
      map.visual.banner = mapReference(map.visual.banner);
      if (["ube", "beatmania"].includes(target)) {
        for (const event of map.audio.events) {
          event.file = mapReference(event.file);
        }
      }

      if (["ube", "beatmania", "osu"].includes(target)) {
        for (const note of map.hitObjects) {
          const reference = mapReference(note.hitsound);

          if (reference !== note.hitsound && note.ext?.osu?.sample) {
            // The osu writer prefers this understood sample field over hitsound
            const fields = note.ext.osu.sample.split(":");
            note.ext.osu.sample = fields.slice(0, 4).join(":") + ":" + reference;
          }

          note.hitsound = reference;
        }
      }

      if (chart.silentPath && paths.get(chart.silentPath) !== chart.silentPath) {
        changed = true;
      }
    }

    if (!changed) {
      continue;
    }

    // Every difficulty in an existing SM combination uses the same final song header
    const texts = charts.map((chart) => {
      let text = serializeBeatmap(chart.map, target).text;
      if (chart.silentPath) {
        text = text.replace("#WAVZZ __ube_silence.wav", `#WAVZZ ${relativeAsset(outputPath, paths.get(chart.silentPath))}`);
      }

      return text;
    });

    entries.get(outputPath).text = texts[0] + texts.slice(1).map((text) => "\n" + text.slice(text.indexOf("#NOTES:"))).join("");
  }

  const renamed = [...paths].filter(([source, output]) => source !== output);
  if (renamed.length) {
    const names = renamed.slice(0, 8).map(([source, output]) => `"${source}" -> "${output}"`).join(", ");

    report.push({
      file: built.p.name,
      message: `Output names changed to avoid collisions: ${names}${renamed.length > 8 ? ` (and ${renamed.length - 8} more)` : ""}. Only supported exported chart references are remapped; embedded references in retained originals and opaque format-specific fields were not rewritten.`
    });
  }
}

/**
 * @param {Map<string, Object>} entries     Output paths mapped to {directory}, {text} or {bytes}
 * @returns {Promise<Uint8Array>}           DEFLATE-compressed ZIP bytes
 */
export async function zipEntries(entries) {
  const zip = new JSZip();

  for (const [path, entry] of entries) {
    if (entry.directory) {
      zip.folder(path);
    } else {
      zip.file(path, entry.text ?? entry.bytes);
    }
  }

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: {
      level: 4
    }
  });
}

/**
 * Convert every selected chart and assemble the download: a single chart file,
 *  a native OSZ/QP mapset, or a ZIP with a conversion report
 * 
 * @param {Object[]} packages                                                 Worker-owned packages; never mutated
 * @param {string} target                                                     Destination format
 * @param {{mixes?: Object[], progress?: function(string): void}} [options]   Rendered BMS mixes and progress callback
 * @returns {Promise<{name: string, bytes: Uint8Array, mime: string, report: Object[], count: number}|{error: string, report: Object[], count: 0}>}
 * @throws {Error}                                                            If no output format is chosen or package assembly fails
 */
export async function exportPackages(
  packages,
  target,
  { mixes = [], progress = () => {} } = {}
) {
  if (!OUTPUT_EXTS[target]) {
    throw new Error("Choose an output format.");
  }

  let count    = 0;
  const report = [];
  const built  = [];

  for (const p of packages) {
    const b = await buildPackage(p, target, report, mixes, progress, !!nativeExtensions[target] || (packages.length > 1 && !p.archive));
    built.push({
      p,
      ...b
    });

    count += b.count;
  }

  if (!count) {
    return {
      error: "No charts were converted. Check the messages or select a compatible difficulty.",
      report,
      count: 0
    };
  }

  const entries = new Map();
  const used    = new Set();
  const looseOutputs = [];

  for (const b of built) {
    if (packages.length === 1) {
      for (const [path, data] of b.entries) {
        entries.set(path, data);
      }

    } else if (b.p.archive && (!nativeExtensions[target] || [...b.entries.values()].some((entry) => entry.chart))) {
      const name = uniquePath(stem(b.p.name) + ".zip", used);
      entries.set(name, {
        bytes: await zipEntries(b.entries)
      });

    } else {
      const paths = new Map();

      for (const [path, data] of b.entries) {
        const outputPath = uniquePath(path, used);
        paths.set(path, outputPath);
        entries.set(outputPath, data);
      }

      looseOutputs.push({
        built: b,
        paths
      });
    }
  }

  for (const { built, paths } of looseOutputs) {
    remapExportCharts(built, target, paths, entries, used, report);
  }

  const deliverables = [...entries].filter(([, entry]) => !entry.directory);
  if (deliverables.length === 1 && deliverables[0][1].native) {
    const [path, entry] = deliverables[0];
    return {
      name: basename(path),
      bytes: entry.bytes,
      report,
      count,
      mime: "application/zip"
    };
  }

  const single = packages.length === 1
    && !packages[0].archive
    && packages[0].entries.size === 1
    && entries.size === 1
    && ![...entries.keys()][0].includes("/")
    && [...entries.values()][0].chart;

  if (single) {
    const [name, entry] = [...entries][0];

    return {
      name,
      bytes: new TextEncoder().encode(entry.text),
      report,
      count,
      mime: "text/plain;charset=utf-8"
    };
  }

  const reportText = [
    "UBE conversion report",
    `Destination: ${target}`,
    `Charts exported: ${count}`,
    "",
    ...report.map((r) => `${r.file}\n  ${r.message}`)
  ].join("\n");

  const reportName = uniquePath(
    "UBE-conversion-report.txt",
    new Set([...entries.keys()].map((x) => x.toLowerCase()))
  );

  entries.set(reportName, {
    text: reportText
  });

  const name =
    packages.length === 1 && packages[0].archive
      ? stem(packages[0].name) + "-converted.zip"
      : "UBE-converted.zip";

  return {
    name,
    bytes: await zipEntries(entries),
    report,
    count,
    mime: "application/zip"
  };
}
