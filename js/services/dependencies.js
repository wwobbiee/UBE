import "../../vendor/jszip.min.js";

export const JSZip = globalThis.JSZip;
if (!JSZip) {
  throw new Error("JSZip is missing. Run npm run vendor.");
}
