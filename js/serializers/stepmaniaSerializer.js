import { decimal, smText } from "./common.js";
import { SM_TYPES } from "../parsers/stepmaniaParser.js";
import { chartBeats } from "../services/timingService.js";


const defaultTypes = {
  4:  "dance-single",
  5:  "pump-single",
  6:  "dance-solo",
  7:  "kb7-single",
  8:  "dance-double",
  9:  "popn-nine",
  10: "pump-double",
  12: "beat-double5",
  16: "beat-double7"
};

/**
 * @param {number} a    Integer
 * @param {number} b    Integer
 * @returns {number}    Greatest common divisor
 */
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// UBE note types and their SM note symbols; "3" ends holds and rolls
const NOTE_SYMBOLS = {
  tap: "1",
  hold: "2",
  roll: "4",
  mine: "M",
  lift: "L",
  fake: "F"
};

// Difficulty names SM accepts; anything else is written as Edit
const DIFFICULTIES = ["Beginner", "Easy", "Medium", "Hard", "Challenge", "Edit"];

// Rows per 4/4 measure on SM's 1/48 beat grid
const ROWS_PER_MEASURE = 192;

/**
 * Writes a legacy SM chart with one #NOTES block on a 1/48 beat grid
 * Notes before beat 0 add whole leading measures, and #OFFSET keeps
 *  the music aligned
 */
export class SMSerializer {
  /**
   * @param {Object} m            Finished UBEBeatmap clone
   * @param {Object[]} notes      Supported notes from supportedNotes
   * @param {string[]} warnings   Receives quantization and layout warnings
   */
  constructor(m, notes, warnings) {
    this.m        = m;
    this.notes    = notes;
    this.warnings = warnings;
    this.keys     = m.difficulty.keyCount;
    this.ext      = m.difficulty.ext.stepmania || {};
  }

  /**
   * Keep the source step type when its lane count still matches; otherwise use the
   *  default for this lane count and warn that the layout meaning may change
   * 
   * @returns {string}    SM step type
   * @throws {Error}      If no supported step type has this many lanes
   */
  #stepType() {
    const { keys, ext } = this;
    const type = SM_TYPES[ext.stepType] === keys ? ext.stepType : defaultTypes[keys];
    if (!type) {
      throw new Error(`Legacy SM has no supported ${keys}-lane step type. Choose osu!, Quaver or UBE instead.`);
    }

    if (!ext.stepType) {
      this.warnings.push(`${keys} lanes exported as ${type}; the destination game's lane meaning/layout may differ.`);
    }

    return type;
  }

  /**
   * Place every note start and hold/roll end on the shifted 1/48 beat grid
   * 
   * @param {Object[]} notes            Notes with beat positions from chartBeats
   * @param {number} shift              Leading beats added before the source's beat 0
   * @returns {Map<number, string[]>}   Absolute row index to its column symbols
   * @throws {Error}                    If the chart is too long or two notes share a grid cell
   */
  #noteRows(notes, shift) {
    const rows    = new Map();
    let quantized = 0;

    const add = (beat, lane, symbol) => {
      const row = Math.round((beat + shift) * 48);

      if (Math.abs(beat + shift - row / 48) > 1e-6) {
        quantized++;
      }

      if (row < 0 || row > ROWS_PER_MEASURE * 10000) {
        throw new Error("SM chart exceeds the supported 10,000-measure range.");
      }

      if (!rows.has(row)) {
        rows.set(row, Array(this.keys).fill("0"));
      }

      if (rows.get(row)[lane] !== "0") {
        throw new Error(`SM grid collision at beat ${decimal(row / 48)}, lane ${lane + 1}; use a millisecond format to preserve these notes.`);
      }

      rows.get(row)[lane] = symbol;
    };

    for (const n of notes) {
      add(n.beat, n.lane, NOTE_SYMBOLS[n.type]);

      if (["hold", "roll"].includes(n.type)) {
        add(n.endBeat, n.lane, "3");
      }
    }

    if (quantized) {
      this.warnings.push(`${quantized} note endpoints quantized to StepMania's 1/48-beat grid.`);
    }

    return rows;
  }

  /**
   * Group rows into measures, writing each measure at the coarsest row spacing
   *  that still contains all of its notes (at least quarter notes)
   * 
   * @param {Map<number, string[]>} rows    Absolute row index to column symbols
   * @returns {string[]}                    Measure text blocks from measure 0 to the last note
   */
  #measures(rows) {
    const last      = [...rows.keys()].reduce((max, r) => Math.max(max, r), 0);
    const byMeasure = new Map();

    for (const row of rows.keys()) {
      const mi = Math.floor(row / ROWS_PER_MEASURE);
      if (!byMeasure.has(mi)) {
        byMeasure.set(mi, []);
      }

      byMeasure.get(mi).push(row % ROWS_PER_MEASURE);
    }

    const measures = [];
    for (let measure = 0; measure <= Math.floor(last / ROWS_PER_MEASURE); measure++) {
      const lines = [];
      const local = byMeasure.get(measure) || [];
      const step  = local.reduce((v, r) => gcd(v, r), 48);

      for (let r = 0; r < ROWS_PER_MEASURE; r += step)
        lines.push(
          (rows.get(measure * ROWS_PER_MEASURE + r) || Array(this.keys).fill("0")).join(""),
        );
      measures.push(lines.join("\n"));
    }

    return measures;
  }

  /**
   * @param {Object[]} points     BPM points with beat positions from chartBeats
   * @param {number} shift        Leading beats; a shifted chart repeats the first BPM at beat 0
   * @returns {string[]}          #BPMS beat=bpm pairs
   */
  #bpmPairs(points, shift) {
    const pairs = points.map((t) => `${decimal(t.beat + shift)}=${decimal(t.bpm)}`);
    if (shift) {
      pairs.unshift(`0=${decimal(this.m.timing.points[0].bpm)}`);
    }

    return pairs;
  }

  /**
   * @param {number} zero     Milliseconds of beat 0 relative to the music start
   * @returns {string}        Song header tags
   */
  #header(zero) {
    const { m } = this;
    const fields = {
      TITLE:        m.metadata.title,
      SUBTITLE:     m.metadata.source,
      ARTIST:       m.metadata.artist,
      CREDIT:       m.metadata.creator,
      BANNER:       m.visual.banner,
      BACKGROUND:   m.visual.background,
      MUSIC:        m.audio.file,
      OFFSET:       decimal(-zero / 1000),
      SAMPLESTART:  decimal(m.audio.previewTime / 1000),
      SAMPLELENGTH:   15,
      SELECTABLE:   "YES"
    };

    return Object.entries(fields)
      .map(([k, v]) => `#${k}:${smText(v)};`)
      .join("\n");
  }

  /**
   * @param {string} type           SM step type
   * @param {string[]} measures     Measure text blocks
   * @returns {string}              The #NOTES block with zeroed groove radar values
   */
  #notesBlock(type, measures) {
    const { m, ext }  = this;
    const difficulty  = DIFFICULTIES.includes(ext.difficulty) ? ext.difficulty : "Edit";
    const description = smText(m.metadata.version || ext.description || "Converted");
    const meter       = Math.max(1, Math.round(m.difficulty.rating || 1));

    return `#NOTES:\n${type}:\n${description}:\n${difficulty}:\n${meter}:\n0,0,0,0,0:\n${measures.join("\n,\n")}\n;\n`;
  }

  /**
   * @returns {string}    .sm file text with one #NOTES block
   * @throws {Error}      If no step type fits the lane count or notes collide on the grid
   */
  serialize() {
    const { m }    = this;
    const type     = this.#stepType();
    const beats    = chartBeats({ ...m, hitObjects: this.notes });
    const min      = beats.notes.reduce((min, n) => Math.min(min, n.beat), 0);
    const shift    = Math.ceil(-min / 4) * 4;
    const zero     = m.timing.points[0].time - ((beats.points[0].beat + shift) * 60000) / m.timing.points[0].bpm;
    const measures = this.#measures(this.#noteRows(beats.notes, shift));
    const bpms     = this.#bpmPairs(beats.points, shift);

    return `${this.#header(zero)}\n#BPMS:${bpms.join(",")};\n#STOPS:${beats.stops.map((s) => `${decimal(s.beat + shift)}=${decimal(s.duration / 1000)}`).join(",")};\n\n${this.#notesBlock(type, measures)}`;
  }
}

/**
 * Write a legacy SM chart on a 1/48 beat grid, adding leading measures for early notes
 * 
 * @param {Object} m              Finished UBEBeatmap clone
 * @param {Object[]} notes        Supported notes from supportedNotes
 * @param {string[]} warnings     Receives quantization and layout warnings
 * @returns {string}              .sm file text with one #NOTES block
 * @throws {Error}                If no step type fits the lane count or notes collide on the grid
 */
export function serializeSM(m, notes, warnings) {
  return new SMSerializer(m, notes, warnings).serialize();
}
