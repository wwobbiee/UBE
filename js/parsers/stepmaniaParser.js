import { applyBeatTiming } from "../services/timingService.js";
import { createUBEBeatmap, createHitObject, finish, number, warn } from "../models/ubeBeatmap.mjs";


export const SM_TYPES = {
  "dance-single":    4,
  "dance-double":    8,
  "dance-couple":    8,
  "dance-solo":      6,

  "pump-single":     5,
  "pump-double":    10,
  "pump-halfdouble": 6,

  "kb7-single":      7,

  "beat-single5":    6,
  "beat-single7":    8,
  "beat-double5":   12,
  "beat-double7":   16,

  "popn-five":       5,
  "popn-nine":       9,

  "lights-cabinet":  8
};


/**
 * Read SM/DWI tags while consuming escaped character pairs before delimiters
 * 
 * @param {string} text     Source text using the existing line comment grammar
 * @returns {Array[]}       Uppercase tag names and still escaped values
 */
export function tags(text) {
  // SM/DWI escape colon, semicolon and backslash with a backslash
  let match;
  const clean  = text.replace(/\/\/[^\r\n]*/g, "");
  const result = [];
  const re     = /#([A-Z0-9]+):((?:\\[\s\S]|[^\\;])*);/gi;

  while ((match = re.exec(clean))) {
    result.push([match[1].toUpperCase(), match[2]]);
  }

  return result;
}

/**
 * @param {string} s    Escaped tag value
 * @returns {string}    Trimmed value with escaped colons, semicolons and backslashes restored
 */
export const unescapeTag = (s) => s.replace(/\\([:;\\])/g, "$1").trim();

/**
 * Split unescaped colons, accounting for even/odd runs of backslashes
 * Unescape each field once, retaining unknown escapes and empty fields
 * 
 * @param {string} s      Escaped SM NOTES or DWI difficulty value
 * @returns {string[]}    Trimmed, unescaped fields
 */
export function splitFields(s) {
  let start    = 0;
  const fields = [];

  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i++;

    } else if (s[i] === ":") {
      fields.push(unescapeTag(s.slice(start, i)));
      start = i + 1;
    }
  }

  fields.push(unescapeTag(s.slice(start)));

  return fields;
}

/**
 * @param {string} value                        Comma separated beat=value list (#BPMS, #STOPS, ...)
 * @param {number} [scale]                      Divisor converting source beat units to quarter notes
 * @returns {{beat: number, value: number}[]}   Parsed pairs
 */
export function pairs(value, scale = 1) {
  return (value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [b, v] = x.split("=");

      return {
        beat: number(b) / scale,
        value: number(v)
      };
    })
}

/**
 * Build the shared song record and beat clock used by every SM difficulty
 * 
 * @param {Array[]} t                                                     Tags from tags()
 * @returns {{m: Object, clock: Object, get: function(string): string}}   Base map, clock and tag reader
 * @throws {Error}                                                        If unsupported timing extensions (#WARPS, #DELAYS, #FAKES) are present
 */
export function baseSM(t) {
  const get = (name) => unescapeTag(t.find(([k]) => k === name)?.[1] || "");
  const m   = createUBEBeatmap();

  m.provenance.sourceFormat = "stepmania";

  m.metadata.title         = get("TITLE");
  m.metadata.artist        = get("ARTIST");
  m.metadata.creator       = get("CREDIT");
  m.metadata.titleUnicode  = get("TITLETRANSLIT");
  m.metadata.artistUnicode = get("ARTISTTRANSLIT");
  m.metadata.source        = get("SUBTITLE");
  
  m.audio.file        = get("MUSIC");
  m.audio.previewTime = get("SAMPLESTART")
    ? number(get("SAMPLESTART")) * 1000
    : -1;

  m.visual.background = get("BACKGROUND");
  m.visual.banner     = get("BANNER");
  m.ext.stepmania     = { tags: t };

  for (const tag of ["WARPS", "DELAYS", "FAKES"]) {
    if (get(tag)) {
      throw new Error(`#${tag} is not supported in legacy SM input; use a chart without these timing extensions.`);
    }
  }

  const bpms  = pairs(get("BPMS")).map((p) => ({ beat: p.beat, bpm: p.value }));
  const stops = pairs(get("STOPS") || get("FREEZES")).map((p) => ({
    beat: p.beat,
    duration: p.value * 1000
  }));

  const clock = applyBeatTiming(
    m,
    bpms,
    stops,
    -number(get("OFFSET"), 0) * 1000
  );

  if (get("BGCHANGES") || get("FGCHANGES") || get("ANIMATIONS")) {
    warn(m, "StepMania background animations/video are omitted on export.");
  }

  if (get("KEYSOUNDS")) {
    warn(m, "StepMania keysound playback is not exported.");
  }

  if (get("SPEEDS") || get("SCROLLS")) {
    warn(m, "StepMania speed/scroll extensions are not exported.");
  }

  return {
    m,
    clock,
    get
  };
}

// SM note symbols and the UBE note types they start.
//  "3" (hold/roll tail) is handled separately
const NOTE_TYPES = {
  1: "tap",
  2: "hold",
  4: "roll",
  M: "mine",
  L: "lift",
  F: "fake"
};

// Reads legacy StepMania (.sm) files; each #NOTES block becomes one UBEBeatmap
export default class StepmaniaParser {
  /**
   * @param {string} file Decoded .sm text
   */
  constructor(file) {
    this.file = file;
  }

  /**
   * Build one difficulty from a #NOTES value on a copy of the shared song record
   * 
   * @param {Object} base     Song record from baseSM
   * @param {Object} clock    Beat clock from baseSM
   * @param {string} value    Escaped #NOTES value
   * @returns {Object}        A finished UBEBeatmap
   * @throws {Error}          For short blocks, unsupported step types or invalid note data
   */
  #readChart(base, clock, value) {
    const fields = splitFields(value);
    if (fields.length < 6) {
      throw new Error("Invalid #NOTES block.");
    }

    const [stepType, description, difficulty, rating, radar, ...rest] = fields;
    if (!SM_TYPES[stepType]) {
      throw new Error(`Unsupported StepMania step type: ${stepType}.`);
    }

    const m = structuredClone(base);
    m.difficulty.keyCount      = SM_TYPES[stepType];
    m.difficulty.rating        = number(rating, 1);
    m.metadata.version         = this.#versionName(description, difficulty);
    m.difficulty.ext.stepmania = {
      stepType,
      description,
      difficulty,
      radar
    };

    this.#readNotes(m, clock, stepType, rest.join(":"));

    return finish(m);
  }

  /**
   * Combine the difficulty and description into a version name, without repeating
   *  a description that already names the difficulty
   * 
   * @param {string} description    #NOTES description field
   * @param {string} difficulty     #NOTES difficulty field
   * @returns {string}              Version name
   */
  #versionName(description, difficulty) {
    if (!description) {
      return difficulty;
    }

    if (description === difficulty || description.startsWith(difficulty + " - ")) {
      return description;
    }

    return `${difficulty} - ${description}`;
  }

  /**
   * Read comma-separated measures
   * Each measure's rows divide its four beats evenly; per-note keysound/attack
   *  annotations are stripped with a warning
   * 
   * @param {Object} m            Map receiving notes; its key count must be set
   * @param {Object} clock        Beat clock converting beats to milliseconds
   * @param {string} stepType     Step type, used in error messages
   * @param {string} data         Note data after the radar field
   * @throws {Error}              For rows of the wrong width, invalid symbols or unbalanced holds
   */
  #readNotes(m, clock, stepType, data) {
    const active = new Map();

    data.split(",").forEach((measure, mi) => {
      const rows = measure
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter(Boolean);

      rows.forEach((raw, ri) => {
        const row = raw.replace(/\[[^\]]*\]|\{[^}]*\}/g, "");
        if (row.length !== m.difficulty.keyCount) {
          throw new Error(`Invalid ${stepType} row in measure ${mi + 1}: expected ${m.difficulty.keyCount} columns.`);
        }

        if (raw !== row) {
          warn(m, "Per-note StepMania keysound/attack annotations are omitted on export.");
        }

        const beat = mi * 4 + (ri * 4) / rows.length;
        const time = clock.at(beat);

        [...row].forEach((symbol, lane) => this.#readNote(m, active, { symbol, lane, beat, time, mi }));
      });
    });

    if (active.size) {
      throw new Error("Unclosed StepMania hold/roll.");
    }
  }

  /**
   * Apply one column symbol: start a note, or end the hold/roll open in that lane
   * 
   * @param {Object} m                                                                      Map receiving notes
   * @param {Map<number, Object>} active                                                    Open holds/rolls by lane
   * @param {{symbol: string, lane: number, beat: number, time: number, mi: number}} cell   Symbol and its position; mi is the zero-based measure
   * @throws {Error}                                                                        For orphan tails, overlapping holds or unknown symbols
   */
  #readNote(m, active, { symbol, lane, beat, time, mi }) {
    if (symbol === "0") {
      return;
    }

    if (symbol === "3") {
      const n = active.get(lane);
      if (!n) {
        throw new Error(`Orphan hold tail in measure ${mi + 1}, lane ${lane + 1}.`);
      }

      n.endTime = time;
      n.endBeat = beat;
      active.delete(lane);

      return;
    }

    const type = NOTE_TYPES[symbol];
    if (!type) {
      throw new Error(`Unsupported SM note symbol: ${symbol}.`);
    }

    if (active.has(lane)) {
      throw new Error(`Overlapping hold in measure ${mi + 1}, lane ${lane + 1}.`);
    }

    const n = createHitObject({ time, beat, lane, type });
    m.hitObjects.push(n);

    if (symbol === "2" || symbol === "4") {
      active.set(lane, n);
    }
  }

  /**
   * @param {string} [text]     Decoded .sm text
   * @returns {Object[]}        One finished UBEBeatmap per #NOTES block
   * @throws {Error}            For unsupported step types, malformed rows or unclosed holds
   */
  parse(text = this.file) {
    const t = tags(text);
    const { m: base, clock } = baseSM(t);
    const charts = [];

    for (const [key, value] of t) {
      if (!["NOTES", "NOTES2"].includes(key)) {
        continue;
      }

      charts.push(this.#readChart(base, clock, value));
    }

    if (!charts.length) {
      throw new Error("No #NOTES charts found in the SM file.");
    }

    return charts;
  }
}
