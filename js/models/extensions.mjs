export const FILE_FORMATS = {
  osu:       ["osu"],
  quaver:    ["qua"],
  stepmania: ["sm"],
  dwi:       ["dwi"],
  beatmania: ["bms", "bme", "bml", "pms"],
  ube:       ["ube"],
};

export const ARCHIVE_EXTS    = new Set(["zip", "osz", "qp", "olz"]);
export const BEATMAP_EXTS    = new Set(Object.values(FILE_FORMATS).flat());
export const FILE_FORMAT_MAP = Object.fromEntries(
  Object.entries(FILE_FORMATS).flatMap(([f, es]) => es.map((e) => [e, f])),
);

export const OUTPUT_EXTS = {
  osu: "osu",
  quaver: "qua",
  stepmania: "sm",
  beatmania: "bms",
  ube: "ube",
};

/**
 * @param {string} path   File path
 * @returns {string}      Lowercase final extension, or ""
 */
export const getExtension = (path) => String(path).split(/[\\/]/).pop().split(".").slice(1).pop()?.toLowerCase() || "";

/**
 * @param {string} path   File path
 * @returns {string}      The path without its final extension
 */
export const stem = (path) => path.replace(/\.[^./\\]+$/, "");

/**
 * @param {string} path   Slash separated path
 * @returns {string}      Directory with a trailing slash, or ""
 */
export const dirname = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

/**
 * @param {string} path   Slash separated path
 * @returns {string}      The final path segment
 */
export const basename = (path) => path.split("/").pop();
