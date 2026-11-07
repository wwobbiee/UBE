import { applyBeatTiming } from "../services/timingService.js";
import { tags, splitFields, unescapeTag, pairs } from "./stepmaniaParser.js";
import { createUBEBeatmap, createHitObject, finish, number, warn } from "../models/ubeBeatmap.mjs";


// Direction indices are left, down, up, right, up-left, up-right
const directions = {
  0: [],
  1: [0, 1],
  2: [1],
  3: [1, 3],
  4: [0],
  5: [],
  6: [3],
  7: [0, 2],
  8: [2],
  9: [2, 3],
  A: [1, 2],
  B: [0, 3],
  C: [4],
  D: [5],
  E: [0, 4],
  F: [4, 1],
  G: [4, 2],
  H: [4, 3],
  I: [0, 5],
  J: [1, 5],
  K: [2, 5],
  L: [5, 3],
  M: [4, 5]
};

// Subdivision markers and the beat increment each one starts; closing markers restore 1/2 beat. 
const SUBDIVISIONS = {
  "(": 1 / 4,
  "[": 1 / 6,
  "{": 1 / 16,
  "`": 1 / 48 
};

// Solo charts map left, down, up, right, up-left, up-right onto six columns in panel order
const SOLO_LANES = [0, 2, 3, 5, 1, 4];

// Lane counts and equivalent StepMania step types for each DWI chart mode
const MODE_KEYS = {
  SINGLE: 4,
  DOUBLE: 8,
  COUPLE: 8,
  SOLO:   6
};
const MODE_STEP_TYPES = {
  SINGLE: "dance-single",
  DOUBLE: "dance-double",
  COUPLE: "dance-couple",
  SOLO:   "dance-solo"
};

// DWI difficulty names and their StepMania equivalents; anything else is Edit
const DIFFICULTY_NAMES = {
  BASIC:   "Easy",
  ANOTHER: "Medium",
  MANIAC:  "Hard",
  SMANIAC: "Challenge"
};


/**
 * Decodes one DWI step string into beat positioned notes on a 1/48 beat grid
 * A step advances the beat by the current subdivision; a "!" after a step marks
 *  the following arrow as a hold start, and the next arrow in that lane ends it
 */
class DWIStepReader {
  #text;
  #solo;
  #pad;
  #events    = new Map();
  #beat      = 0;
  #increment = 0.5;
  #i         = 0;

  /**
   * @param {string} text     DWI step data for one pad
   * @param {boolean} solo    Whether to use the six-panel solo lane mapping
   * @param {number} pad      0 for the first pad, 1 for the second (lanes offset by 4)
   */
  constructor(text, solo, pad) {
    this.#text = text.replace(/\s/g, "").toUpperCase();
    this.#solo = solo;
    this.#pad  = pad;
  }

  // Read one subdivision marker, chord or step, then advance the beat after a step
  #readToken() {
    const c = this.#text[this.#i++];

    if ("([{`".includes(c)) {
      this.#increment = SUBDIVISIONS[c];

      return;
    }

    if (")]}'".includes(c) || c === ">") {
      this.#increment = 0.5;

      return;
    }

    if (c === "<") {
      if (!this.#readChord()) {
        return;
      }
    } else {
      this.#readStep(c);
    }

    this.#beat += this.#increment;
  }

  /**
   * Read a <...> group as simultaneous steps. A group containing "0" is the legacy
   *  1/192 subdivision marker instead: it only changes the increment, and its
   *  contents are then read as ordinary steps
   * 
   * @returns {boolean}   Whether a chord was read (and the beat should advance)
   * @throws {Error}      If the group is never closed
   */
  #readChord() {
    const end = this.#text.indexOf(">", this.#i);
    
    if (end < 0) {
      throw new Error("Unclosed DWI chord.");
    }

    if (this.#text.slice(this.#i, end).includes("0")) {
      this.#increment = 1 / 48;

      return false;
    }

    while (this.#i < end) {
      this.#readStep(this.#text[this.#i++]);
    }

    this.#i = end + 1;

    return true;
  }

  /**
   * @param {string} symbol Step symbol; a following "!" adds the next symbol as a hold start
   */
  #readStep(symbol) {
    this.#addArrows(symbol);

    if (this.#text[this.#i] !== "!") {
      return
    }

    this.#i++;
    this.#addArrows(this.#text[this.#i++], true);
  }

  /**
   * Record the arrows of one symbol at the current beat, merged per lane and 1/48 row
   * 
   * @param {string} symbol     Step symbol
   * @param {boolean} [hold]    Whether these arrows start holds
   * @throws {Error}            For unknown symbols or solo arrows in a non solo chart
   */
  #addArrows(symbol, hold = false) {
    if (!directions[symbol]) {
      throw new Error(`Invalid DWI symbol: ${symbol}.`);
    }

    for (let lane of directions[symbol]) {
      if (this.#solo) {
        lane = SOLO_LANES[lane];
      } else if (lane > 3) {
        throw new Error("Solo direction in non-solo DWI chart.");
      }

      lane += this.#pad * 4;

      const row = Math.round(this.#beat * 48);
      const key = `${row}:${lane}`;
      const old = this.#events.get(key);

      this.#events.set(key, {
        beat: row / 48,
        lane,
        hold: hold || old?.hold || false
      });
    }
  }

  /**
   * Turn recorded arrows into notes in time order
   * The first arrow after a hold start in the same lane becomes that hold's end
   * 
   * @returns {Object[]}  Notes with beat, lane, type and endBeat for holds
   * @throws {Error}      If a hold is never ended
   */
  #pairHolds() {
    const result = [];
    const active = new Map();
    const events = [...this.#events.values()].sort((a, b) => a.beat - b.beat || a.lane - b.lane);

    for (const e of events) {
      if (active.has(e.lane)) {
        active.get(e.lane).endBeat = e.beat;
        active.delete(e.lane);

        continue;
      }

      const n = {
        ...e,
        type: e.hold ? "hold" : "tap"
      };

      result.push(n);

      if (e.hold) {
        active.set(e.lane, n);
      }
    }

    if (active.size) {
      throw new Error("Unclosed DWI hold.");
    }

    return result;
  }

  /**
   * @returns {Object[]}  Notes with beat, lane, type and endBeat for holds
   * @throws {Error}      For invalid symbols, unclosed chords or unclosed holds
   */
  read() {
    while (this.#i < this.#text.length) {
      this.#readToken();
    }

    return this.#pairHolds()
  }
}

// Reads Dance With Intensity (.dwi) files; each mode/difficulty becomes one UBEBeatmap
export default class DWIParser {

  /**
   * @param {string} file Decoded .dwi text
   */
  constructor(file) {
    this.file = file;
  }

  /**
   * @param {string} [text]   Decoded .dwi text
   * @returns {Object[]}      One finished UBEBeatmap per chart
   * @throws {Error}          If no supported chart exists or step data is invalid
   */
  parse(text = this.file) {
    const t = tags(text);
    const { base, clock } = this.#readSong(t);
    const charts = [];

    for (const [mode, value] of t) {
      if (!MODE_KEYS[mode]) {
        continue;
      }

      charts.push(this.#readChart(base, clock, mode, value))
    }

    if (!charts.length) {
      throw new Error("No supported DWI charts found.");
    }

    return charts
  }

  /**
   * Build the shared song record: metadata, assets and the beat clock
   * DWI change and freeze positions are in 1/16 notes; freezes are
   *  already in milliseconds
   * 
   * @param {Array[]} t                         Tags from tags()
   * @returns {{base: Object, clock: Object}}   Song record and beat clock
   * @throws {Error}                            If #BPM is missing or a timing value is invalid
   */
  #readSong(t) {
    const get  = (k) => unescapeTag(t.find(([key]) => key === k)?.[1] || "");
    const base = createUBEBeatmap();

    base.provenance.sourceFormat = "dwi";
    base.metadata.title          = get("TITLE");
    base.metadata.artist         = get("ARTIST");
    base.audio.file              = get("FILE");
    base.audio.previewTime = get("SAMPLESTART")
      ? number(get("SAMPLESTART")) * 1000
      : -1;
    base.ext.dwi = { tags: t };
    base.visual.background = get("BACKGROUND");

    const bpms = [
      {
        beat: 0,
        bpm: number(get("BPM"))
      },
      ...pairs(get("CHANGEBPM") || get("BPMCHANGE"), 4).map((p) => ({
        beat: p.beat,
        bpm: p.value
      }))
    ];

    const stops = pairs(get("FREEZE"), 4).map((p) => ({
      beat: p.beat,
      duration: p.value
    }));

    const clock = applyBeatTiming(base, bpms, stops, number(get("GAP"), 0));

    return {
      base,
      clock
    };
  }

  /**
   * Build one chart from a mode tag such as #SINGLE:BASIC:3:steps; double and
   *  couple charts carry a second pad's steps
   * 
   * @param {Object} base     Shared song record
   * @param {Object} clock    Beat clock
   * @param {string} mode     SINGLE, DOUBLE, COUPLE or SOLO
   * @param {string} value    Escaped tag value
   * @returns {Object}        A finished UBEBeatmap
   * @throws {Error}          If step data is missing or invalid
   */
  #readChart(base, clock, mode, value) {
    const [difficulty, rating, one, two] = splitFields(value);
    const m = structuredClone(base);
    const solo = mode === "SOLO";

    m.metadata.version         = difficulty;
    m.difficulty.keyCount      = MODE_KEYS[mode];
    m.difficulty.rating        = number(rating, 1);
    m.difficulty.ext.stepmania = {
      stepType: MODE_STEP_TYPES[mode],
      difficulty: DIFFICULTY_NAMES[difficulty] || "Edit",
      description: difficulty
    };

    if (!one) {
      throw new Error("DWI chart has no step data.");
    }

    const notes = [
      ...new DWIStepReader(one, solo, 0).read(),
      ...(two ? new DWIStepReader(two, false, 1).read() : [])
    ];

    m.hitObjects = notes.map((n) =>
      createHitObject({
        lane: n.lane,
        beat: n.beat,
        time: clock.at(n.beat),
        type: n.type,
        endBeat: n.endBeat,
        endTime: n.endBeat === undefined ? null : clock.at(n.endBeat)
      }),
    );

    warn(m, "DWI metadata has fewer asset fields than SM; include companion song assets when converting.");

    return finish(m);
  }
}
