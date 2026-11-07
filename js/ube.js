import OsuMap from "./parsers/osuParser.js";
import BMSParser from "./parsers/bmsParser.js";
import DWIParser from "./parsers/dwiParser.js";
import QuaverParser from "./parsers/quaverParser.js";
import StepmaniaParser from "./parsers/stepmaniaParser.js";

import { finish } from "./models/ubeBeatmap.mjs";
import { serializeSM } from "./serializers/stepmaniaSerializer.js";
import { serializeBMS } from "./serializers/bmsSerializer.js";
import { serializeOsu } from "./serializers/osuSerializer.js";
import { readUBEDocument } from "./models/ubeDocument.mjs";
import { serializeQuaver } from "./serializers/quaverSerializer.js";
import { FILE_FORMAT_MAP, getExtension } from "./models/extensions.mjs";
import { supportedNotes, crossWarnings } from "./serializers/common.js";


/**
 * Parse a supported source; imported UBE JSON is validated/defaulted before finish
 * 
 * @param {string} text         Decoded chart text
 * @param {string} filename     Source path including its format extension
 * @returns {Object[]}          New normalized maps with sourcePath provenance
 * @throws {Error}              If parsing, format support, validation or normalization fails
 */
export function parseBeatmap(text, filename) {
  if (text.length > 32 * 1024 * 1024) {
    throw new Error("Beatmap text exceeds 32 MiB.");
  }

  let result;
  const ext    = getExtension(filename);
  const format = FILE_FORMAT_MAP[ext];

  if (format === "osu") {
    result = new OsuMap(text).parse();
  } else if (format === "quaver") {
    result = new QuaverParser(text).parse();
  } else if (format === "stepmania") {
    result = new StepmaniaParser(text).parse();
  } else if (format === "dwi") {
    result = new DWIParser(text).parse();
  } else if (format === "beatmania") {
    result = new BMSParser(text, ext).parse();
  } else if (format === "ube") {
    result = readUBEDocument(JSON.parse(text));
  } else {
    throw new Error(`Unsupported beatmap extension: ${ext}.`);
  }

  return (Array.isArray(result) ? result : [result]).map((m) => {
    m.provenance.sourcePath = filename;

    return m;
  });
}

/**
 * Serialize a private, finished clone of a normalized map for one destination
 * The caller's map is never mutated; unsupported note types are filtered first
 * 
 * @param {Object} map                              Normalized UBEBeatmap
 * @param {string} target                           osu, quaver, stepmania, beatmania or ube
 * @returns {{text: string, warnings: string[]}}    Chart text and unique export warnings
 * @throws {Error}                                  If the destination is unsupported or the map cannot be represented
 */
export function serializeBeatmap(map, target) {
  const m = structuredClone(map);

  finish(m);

  const warnings = [];
  if (target === "ube") {
    return {
      text: JSON.stringify(m, null, 2) + "\n",
      warnings
    };
  }

  const serializers = {
    osu: serializeOsu,
    quaver: serializeQuaver,
    stepmania: serializeSM,
    beatmania: serializeBMS,
  };

  if (!serializers[target]) {
    throw new Error(`Unsupported destination: ${target}.`);
  }

  crossWarnings(m, target, warnings);
  const notes = supportedNotes(m, target, warnings);
  const text  = serializers[target](m, notes, warnings);

  return {
    text,
    warnings: [...new Set(warnings)]
  };
}
