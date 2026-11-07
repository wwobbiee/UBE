import { clean, decimal } from "./common.js";
import { chartBeats, timeToBeat } from "../services/timingService.js";


/**
 * @param {number} n    Definition index
 * @returns {string}    Two character base-36 BMS identifier
 */
const id = (n) => n.toString(36).toUpperCase().padStart(2, "0");

// Player 1/2 key channels in lane order; channel x6 is the scratch
const P1_FIVE_KEY  = ["11", "12", "13", "14", "15", "16"];
const P1_SEVEN_KEY = ["11", "12", "13", "14", "15", "18", "19", "16"];
const P2_FIVE_KEY  = ["21", "22", "23", "24", "25", "26"];
const P2_SEVEN_KEY = ["21", "22", "23", "24", "25", "28", "29", "26"];

// Rows per 4/4 measure on the output's 1/48 beat grid
const ROWS_PER_MEASURE = 192;


/**
 * Writes a BMS chart on a 1/48 beat grid with BPM/stop definitions and sample triggers
 * BMS has no audio offset, so whole leading measures keep early notes and the main
 *  audio trigger at non-negative beats
 * Notes without a keysound use the reserved #WAVZZ silence emitted by the package service
 */
export class BMSSerializer {
  #shift     = 0;
  #rows      = new Map();
  #wav       = new Map();
  #bpms      = [];
  #stops     = [];
  #quantized = 0;

  /**
   * @param {Object} m            Finished UBEBeatmap clone
   * @param {Object[]} notes      Supported notes from supportedNotes
   * @param {string[]} warnings   Receives quantization, lane and offset warnings
   */
  constructor(m, notes, warnings) {
    this.m           = m;
    this.notes       = notes;
    this.warnings    = warnings;
    this.keys        = m.difficulty.keyCount;
    this.original    = m.ext.bms;
    this.audioEvents = m.audio.events || [];
  }

  /**
   * Reuse the source's BMS channels, or pick the standard five/seven key layout
   *  (doubled above eight lanes), warning when unused lanes are added
   * 
   * @param {boolean} double    Whether the chart needs player 2 channels
   * @returns {string[]}        Key channels in lane order
   */
  #channels(double) {
    const { keys } = this;
    const seven    = keys === 7 || keys === 8 || keys > 12;
    const player1  = seven ? P1_SEVEN_KEY : P1_FIVE_KEY;
    const player2  = seven ? P2_SEVEN_KEY : P2_FIVE_KEY;
    const channels = this.original?.channels || [...player1, ...(double ? player2 : [])];

    if (channels.length !== keys) {
      this.warnings.push(`BMS output uses ${channels.length} lanes with ${channels.length - keys} unused lanes to retain note columns.`);
    }

    return channels;
  }

  /**
   * @param {Object[]} notes  Notes with beat positions from chartBeats
   * @returns {number}        Whole measures (in beats) needed to move the earliest note,
   *                            audio event or main audio start to beat 0 or later
   */
  #leadingShift(notes) {
    const { m } = this;
    const allBeats = [
      0,
      ...notes.map((n) => n.beat),
      ...this.audioEvents.map((e) =>
        Number.isFinite(e.beat) ? e.beat : timeToBeat(m, e.time),
      )
    ];

    if (m.audio.file) {
      allBeats.push(timeToBeat(m, 0));
    }

    return Math.ceil(-allBeats.reduce((min, b) => Math.min(min, b), 0) / 4) * 4;
  }

  /**
   * @param {Object[]} points BPM points with beat positions from chartBeats
   */
  #warnOffset(points) {
    const { m } = this;
    const zero = m.timing.points[0].time - (points[0].beat * 60000) / m.timing.points[0].bpm;

    if (zero !== 0) {
      this.warnings.push("BMS has no general audio offset; leading measures shift song playback and notes together.");
    }
  }

  /**
   * Define and place BPM changes (channel 08) after the initial #BPM, and stops
   * (channel 09) converted to 1/192 notes at the BPM in effect
   * 
   * @param {Object} beats    Beat positions from chartBeats
   * @throws {Error}          If there are more than 1,295 BPM or stop definitions
   */
  #writeTiming(beats) {
    for (const p of beats.points) {
      if (p.beat === 0 && p.bpm === this.m.timing.points[0].bpm) {
        continue;
      }

      const value = id(this.#bpms.length + 1);
      if (this.#bpms.length >= 1295) {
        throw new Error("Too many BMS BPM definitions.");
      }

      this.#bpms.push({ id: value, bpm: p.bpm });
      this.#put(p.beat, "08", value);
    }

    for (const s of beats.stops) {
      const bpm   = beats.points.filter((p) => p.beat <= s.beat).at(-1).bpm;
      const value = id(this.#stops.length + 1);

      if (this.#stops.length >= 1295) {
        throw new Error("Too many BMS stop definitions.");
      }

      this.#stops.push({ id: value, value: ((s.duration * bpm) / 60000) * 48 });
      this.#put(s.beat, "09", value);
    }
  }

  /**
   * Place notes on their lane channels; holds use the matching 5x/6x long-note
   *  channel with the same sample at both ends
   * 
   * @param {Object[]} notes        Notes with beat positions from chartBeats
   * @param {string[]} channels     Key channels in lane order
   * @throws {Error}                If a lane has no channel
   */
  #writeNotes(notes, channels) {
    for (const n of notes) {
      const channel = channels[n.lane];
      if (!channel) {
        throw new Error("BMS lane mapping is unavailable.");
      }

      const code = n.type === "hold" ? String(Number(channel[0]) + 4) + channel[1] : channel;
      this.#put(n.beat, code, this.#sample(n.hitsound));

      if (n.type === "hold") {
        this.#put(n.endBeat, code, this.#sample(n.hitsound));
      }
    }
  }

  // Trigger the main audio at time 0 and every scheduled BGM event on layered channel 01
  #writeAudio() {
    const { m } = this;
    if (m.audio.file) {
      this.#put(timeToBeat(m, 0), "01", this.#sample(m.audio.file), true);
    }

    for (const e of this.audioEvents) {
      this.#put(
        Number.isFinite(e.beat) ? e.beat : timeToBeat(m, e.time),
        "01",
        this.#sample(e.file),
        true
      );
    }
  }

  /**
   * @param {string} file     Sample path
   * @returns {string}        Its #WAV identifier, or ZZ for silence
   */
  #sample(file) {
    if (!file) {
      return "ZZ";
    }

    if (!this.#wav.has(file)) {
      if (this.#wav.size >= 1294) {
        throw new Error("BMS sample limit exceeded.");
      }

      this.#wav.set(file, id(this.#wav.size + 1));
    }

    return this.#wav.get(file);
  }

  /**
   * Place one value in a measure channel row. Layered channels (BGM) open a new
   *  row instead of colliding; other collisions are errors
   * 
   * @param {number} beat       Source beat, before the leading shift
   * @param {string} channel    Two character channel
   * @param {string} value      Two character object ID
   * @param {boolean} [layer]   Whether collisions open an extra row
   * @throws {Error}            Outside measures 000-999, or on a non-layered collision
   */
  #put(beat, channel, value, layer = false) {
    const row = Math.round((beat + this.#shift) * 48);
    if (Math.abs(beat + this.#shift - row / 48) > 1e-6) {
      this.#quantized++;
    }

    const slot    = row % ROWS_PER_MEASURE;
    const measure = Math.floor(row / ROWS_PER_MEASURE);
    if (measure < 0 || measure > 999) {
      throw new Error("BMS export exceeds the 000-999 measure range.");
    }

    let key = `${measure}:${channel}`;
    if (layer) {
      let i = 0;

      while (this.#rows.get(key)?.has(slot)) {
        key = `${measure}:${channel}:${++i}`;
      }
    }

    if (!this.#rows.has(key)) {
      this.#rows.set(key, new Map());
    }

    if (this.#rows.get(key).has(slot)) {
      throw new Error("BMS timing/note grid collision; use a millisecond format.");
    }

    this.#rows.get(key).set(slot, value);
  }

  /**
   * @param {boolean} double    Whether the chart uses player 2 channels
   * @returns {string[]}        Header, definition and measure lines in output order
   */
  #lines(double) {
    const { m } = this;
    const header = {
      PLAYER:    double ? 3 : 1,
      GENRE:     m.metadata.tags.join(" "),
      TITLE:     m.metadata.title,
      ARTIST:    m.metadata.artist,
      SUBARTIST: m.metadata.creator,
      BPM:       decimal(m.timing.points[0].bpm),
      PLAYLEVEL: Math.max(1, Math.round(m.difficulty.rating)),
      RANK:      2,
      TOTAL:     300,
      STAGEFILE: m.visual.background,
      BANNER:    m.visual.banner,
      LNTYPE:    1
    };
    const lines = Object.entries(header).map(([k, v]) => `#${k} ${clean(v)}`);

    // ZZ is reserved for a generated, valid silent WAV, emitted by the package service
    if (this.notes.some((n) => !n.hitsound)) {
      lines.push("#WAVZZ __ube_silence.wav");
    }

    for (const [file, key] of this.#wav) {
      lines.push(`#WAV${key} ${clean(file)}`);
    }
    for (const p of this.#bpms) {
      lines.push(`#BPM${p.id} ${decimal(p.bpm)}`);
    }
    for (const s of this.#stops) {
      lines.push(`#STOP${s.id} ${decimal(s.value)}`);
    }

    // Sort by measure only; rows within a measure keep their placement order
    const rows = [...this.#rows].sort((a,b) => Number(a[0].split(":")[0]) - Number(b[0].split(":")[0]));
    for (const [key, values] of rows) {
      const [measure, channel] = key.split(":");
      const data = Array(ROWS_PER_MEASURE).fill("00");

      for (const [slot, value] of values) {
        data[slot] = value;
      }

      lines.push(`#${String(measure).padStart(3, "0")}${channel}:${data.join("")}`);
    }

    return lines;
  }

  /**
   * @returns {string}    .bms file text
   * @throws {Error}      For PMS output, too many lanes/definitions or grid collisions
   */
  serialize() {
    const { m, keys } = this;
    if (keys > 16) {
      throw new Error("BMS export supports up to 16 lanes.");
    }

    if (this.original?.extension === "pms") {
      throw new Error("PMS export is not implemented; choose UBE, SM, osu! or Quaver.");
    }

    const double   = keys > 8;
    const channels = this.#channels(double);
    const beats    = chartBeats({
      ...m,
      hitObjects: this.notes
    });

    this.#shift = this.#leadingShift(beats.notes);
    this.#warnOffset(beats.points);
    this.#writeTiming(beats);
    this.#writeNotes(beats.notes, channels);
    this.#writeAudio();

    if (this.#quantized) {
      this.warnings.push(`${this.#quantized} BMS events quantized to a 1/48-beat grid.`);
    }

    return this.#lines(double).join("\n") + "\n";
  }
}

/**
 * Write a BMS chart on a 1/48-beat grid with BPM/stop definitions and sample triggers
 * Notes without a keysound use the reserved #WAVZZ silence emitted by the package service
 * 
 * @param {Object} m              Finished UBEBeatmap clone
 * @param {Object[]} notes        Supported notes from supportedNotes
 * @param {string[]} warnings     Receives quantization, lane and offset warnings
 * @returns {string}              .bms file text
 * @throws {Error}                For PMS output, too many lanes/definitions or grid collisions
 */
export function serializeBMS(m, notes, warnings) {
  return new BMSSerializer(m, notes, warnings).serialize();
}
