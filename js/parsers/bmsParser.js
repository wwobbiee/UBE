import { applyBeatTiming } from "../services/timingService.js";
import { createUBEBeatmap, createHitObject, finish, number, warn } from "../models/ubeBeatmap.mjs";


// Object channels that drive timing rather than notes; they never warn as unsupported
const TIMING_CHANNELS = ["02", "03", "08", "09"];

// PMS nine button layout
const PMS_CHANNELS = ["11", "12", "13", "14", "15", "22", "23", "24", "25"];

// Player 1/2 key channels in lane order; channel x6 is the scratch
const P1_FIVE_KEY  = ["11", "12", "13", "14", "15", "16"];
const P1_SEVEN_KEY = ["11", "12", "13", "14", "15", "18", "19", "16"];
const P2_FIVE_KEY  = ["21", "22", "23", "24", "25", "26"];
const P2_SEVEN_KEY = ["21", "22", "23", "24", "25", "28", "29", "26"];


/**
 * @typedef {Object} BMSSource
 * 
 * @property {Object<string, string>} header                                Uppercase header keys and values
 * @property {{measure: number, channel: string, data: string}[]} records   Object channel lines
 * @property {Map<number, number>} lengths                                  Measure length ratios (channel 02)
 * @property {Object<string, string>} waves                                 #WAVxx sample paths by ID
 * @property {Object<string, number>} bpmDefs                               #BPMxx values by ID
 * @property {Object<string, number>} stopDefs                              #STOPxx values (1/192 notes) by ID
 */
// Reads fixed (non RANDOM) BMS/BME/BML/PMS charts into UBEBeatmap records
export default class BMSParser {

  /**
   * @param {string} file           Decoded chart text
   * @param {string} [extension]    Source extension; selects PMS or BME/BML lane layouts
   */
  constructor(file, extension = "bms") {
    this.file = file;
    this.extension = extension;
  }

  /**
   * Split command lines into header fields, #WAV/#BPM/#STOP definitions, measure
   *  lengths and object channel records
   * Non command lines are ignored
   * 
   * @param {string} text     Decoded chart text
   * @returns {BMSSource}     The chart's records and definitions
   * @throws {Error}          For RANDOM/conditional blocks, invalid lengths or invalid object data
   */
  #readSource(text) {
    const source = {
      header:   {},
      records:  [],
      lengths:  new Map(),
      waves:    {},
      bpmDefs:  {},
      stopDefs: {}
    };

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();

      if (!line.startsWith("#")) {
        continue;
      }
      if (/^#(?:RANDOM|SETRANDOM|IF|ELSE|ELSEIF|SWITCH|SETSWITCH)\b/i.test(line)) {
        throw new Error("BMS RANDOM/conditional branches are not supported; export a fixed chart first.");
      }

      const record = line.match(/^#(\d{3})([\dA-Z]{2}):(.+)$/i);
      if (record) {
        this.#readRecord(source, record);
      } else {
        this.#readDefinition(source, line);
      }
    }

    return source;
  }

  /**
   * @param {BMSSource} source    Source being read
   * @param {string[]} match      Measure, channel and data from a #mmmcc:data line
   * @throws {Error}              For a non positive measure length or malformed object data
   */
  #readRecord(source, match) {
    const measure = Number(match[1]);
    const channel = match[2].toUpperCase();
    const data    = match[3].trim().toUpperCase();

    if (channel === "02") {
      const ratio = number(data);
      
      if (ratio <= 0) {
        throw new Error("Invalid BMS measure length.");
      }

      source.lengths.set(measure, ratio);

      return;
    }

    if (!/^(?:[0-9A-Z]{2})+$/.test(data)) {
      throw new Error(`Invalid BMS data in measure ${measure}.`);
    }

    source.records.push({
      measure,
      channel,
      data
    });
  }

  /**
   * @param {BMSSource} source    Source being read
   * @param {string} line         A "#KEY value" header line
   */
  #readDefinition(source, line) {
    const match = line.match(/^#(\S+)\s*(.*)$/);
    if (!match) return;

    const key = match[1].toUpperCase();
    const value = match[2].trim();

    if (/^WAV[\dA-Z]{2}$/.test(key)) {
      source.waves[key.slice(3)] = value;

    } else if (/^BPM[\dA-Z]{2}$/.test(key)) {
      source.bpmDefs[key.slice(3)] = number(value);

    } else if (/^STOP[\dA-Z]{2}$/.test(key)) {
      source.stopDefs[key.slice(4)] = number(value);

    } else {
      source.header[key] = value;
    }
  }

  /**
   * @param {Object<string, string>} header   Header fields
   * @throws {Error}                          For LNTYPE 2 or non base-36 object IDs
   */
  #checkHeader(header) {
    if (number(header.LNTYPE, 1) !== 1) {
      throw new Error("BMS LNTYPE 2 is not supported.");
    }

    if (header.BASE && header.BASE !== "36") {
      throw new Error("Only base-36 BMS object IDs are supported.");
    }
  }

  /**
   * @param {Object} m            Map being built
   * @param {BMSSource} source    Chart source
   */
  #readMetadata(m, { header, waves }) {
    m.provenance.sourceFormat = "beatmania";
    m.ext.bms = {
      header,
      waves,
      extension: this.extension
    };

    m.metadata.title    = header.TITLE      || "";
    m.metadata.artist   = header.ARTIST     || "";
    m.metadata.creator  = header.SUBARTIST  || "";
    m.metadata.version  = header.DIFFICULTY || header.PLAYLEVEL || "BMS";
    m.metadata.tags     = header.GENRE ? [header.GENRE] : [];
    m.difficulty.rating = number(header.PLAYLEVEL, 1);
    m.visual.background = header.STAGEFILE || header.BACKBMP || "";
    m.visual.banner     = header.BANNER || "";
  }

  /**
   * Expand object records into beat positioned events
   * A measure is four beats scaled by its length ratio;
   *  each two character ID divides it evenly, and 00 is empty
   * 
   * @param {BMSSource} source                                  Chart source
   * @returns {{beat: number, channel: string, id: string}[]}   Events sorted by beat
   */
  #readEvents({ records, lengths }) {
    const starts     = [0];
    const maxMeasure = Math.max(0, ...records.map((r) => r.measure), ...lengths.keys());

    for (let i = 0; i <= maxMeasure; i++) {
      starts.push(starts.at(-1) + 4 * (lengths.get(i) || 1));
    }

    const events = [];
    for (const r of records) {
      const count = r.data.length / 2;

      for (let i = 0; i < count; i++) {
        const id = r.data.slice(i * 2, i * 2 + 2);

        if (id !== "00") {
          events.push({
            beat: starts[r.measure] + (i / count) * 4 * (lengths.get(r.measure) || 1),
            channel: r.channel,
            id,
          });
        }
      }
    }

    events.sort((a, b) => a.beat - b.beat);

    return events;
  }

  /**
   * Collect BPM changes (hexadecimal channel 03, defined channel 08) and
   *  stops (channel 09)
   * A stop's 1/192 note duration uses the BPM in effect at its beat
   * 
   * @param {Object} m            Map receiving timing points
   * @param {BMSSource} source    Chart source
   * @param {Object[]} events     Sorted events
   * @returns {Object}            Beat clock
   * @throws {Error}              For a missing #BPM, invalid hexadecimal BPMs or undefined definitions
   */
  #readTiming(m, { header, bpmDefs, stopDefs }, events) {
    const bpms = [{
      beat: 0,
      bpm:  number(header.BPM)
    }];
    const rawStops = [];

    for (const e of events) {
      if (e.channel === "03") {
        if (!/^[0-9A-F]{2}$/.test(e.id)) {
          throw new Error("Invalid hexadecimal BMS BPM.");
        }

        bpms.push({ beat: e.beat, bpm: parseInt(e.id, 16) });
      }

      if (e.channel === "08") {
        if (!bpmDefs[e.id]) {
          throw new Error(`Missing #BPM${e.id}.`);
        }

        bpms.push({ beat: e.beat, bpm: bpmDefs[e.id] });
      }

      if (e.channel === "09") {
        if (stopDefs[e.id] === undefined) {
          throw new Error(`Missing #STOP${e.id}.`);
        }

        rawStops.push(e);
      }
    }

    bpms.sort((a, b) => a.beat - b.beat);
    const stops = rawStops.map((e) => {
      const bpm = bpms.filter((p) => p.beat <= e.beat).at(-1).bpm;

      return {
        beat: e.beat,
        duration: ((stopDefs[e.id] / 48) * 60000) / bpm
      };
    });

    return applyBeatTiming(m, bpms, stops, 0);
  }

  /**
   * Choose the lane layout: PMS uses nine buttons; BMS uses five or seven keys
   *  plus scratch, doubled when player 2 channels appear
   * BME/BML or any x8/x9 channel selects seven keys
   * 
   * @param {Object} m          Map receiving the key count and lane records
   * @param {Object[]} events   Sorted events
   * @returns {string[]}        Key channels in lane order
   */
  #readLanes(m, events) {
    const double = events.some((e) => /^[26][1-9A-Z]$/.test(e.channel));
    const seven  = ["bme", "bml"].includes(this.extension) || events.some((e) => /^[1256][89]$/.test(e.channel));

    const player1  = seven ? P1_SEVEN_KEY : P1_FIVE_KEY;
    const player2  = seven ? P2_SEVEN_KEY : P2_FIVE_KEY;
    const channels = this.extension === "pms"
      ? [...PMS_CHANNELS]
      : [...player1, ...(double ? player2 : [])];

    m.difficulty.keyCount = channels.length;
    m.lanes = channels.map((channel, index) => ({
      index,
      name: channel.endsWith("6") ? "Scratch" : String(index + 1),
      ext: {
        bmsChannel: channel
      }
    }));

    m.ext.bms.channels = channels;

    return channels;
  }

  /**
   * Convert events into BGM triggers and notes
   * Channels 5x/6x are long note pairs on the matching 1x/2x lane;
   *  with #LNOBJ, that ID ends the previous note in its lane instead
   * Unsupported channels are dropped with a warning
   * 
   * @param {Object} m            Map receiving notes and audio events
   * @param {BMSSource} source    Chart source
   * @param {Object[]} events     Sorted events
   * @param {Object} clock        Beat clock
   * @param {string[]} channels   Key channels in lane order
   * @throws {Error}              For an orphan LNOBJ tail or an unclosed long note
   */
  #readObjects(m, { header, waves }, events, clock, channels) {
    const long     = new Map();
    const previous = new Map();

    for (const e of events) {
      const time = clock.at(e.beat);

      if (e.channel === "01") {
        m.audio.events.push({
          time,
          beat: e.beat,
          file: waves[e.id] || "",
          ext: {
            bmsId: e.id
          }
        });

        if (!waves[e.id]) {
          warn(m, `BMS sample #WAV${e.id} is undefined.`);
        }

        continue;
      }

      let channel  = e.channel;
      const isLong = /^[56]/.test(channel);

      if (isLong) {
        channel = String(Number(channel[0]) - 4) + channel[1];
      }

      const lane = channels.indexOf(channel);
      if (lane < 0) {
        if (!TIMING_CHANNELS.includes(e.channel)) {
          warn(m, "BMS BGA, invisible notes, mines and unsupported channels are omitted on export.");
        }

        continue;
      }

      if (isLong && long.has(lane)) {
        this.#endHold(long, lane, time, e.beat);

        continue;
      }

      if (!isLong && header.LNOBJ?.toUpperCase() === e.id) {
        if (!previous.has(lane)) {
          throw new Error("Orphan BMS LNOBJ tail.");
        }

        previous.get(lane).type = "hold";
        this.#endHold(previous, lane, time, e.beat);

        continue;
      }

      const n = createHitObject({
        lane,
        time,
        beat: e.beat,
        type: isLong ? "hold" : "tap",
        hitsound: waves[e.id] || "",
        ext: {
          bms: {
            id: e.id
          }
        }
      });

      m.hitObjects.push(n);

      if (!waves[e.id]) {
        warn(m, `BMS sample #WAV${e.id} is undefined.`);
      }

      if (isLong) {
        long.set(lane, n);
      } else {
        previous.set(lane, n);
      }
    }

    if (long.size) {
      throw new Error("Unclosed BMS long note.");
    }
  }

  /**
   * End the note open in a lane and stop tracking it
   * 
   * @param {Map<number, Object>} open    Open notes by lane
   * @param {number} lane                 Lane index
   * @param {number} time                 End time in milliseconds
   * @param {number} beat                 End beat
   */
  #endHold(open, lane, time, beat) {
    const n = open.get(lane);

    n.endTime = time;
    n.endBeat = beat;

    open.delete(lane);
  }

  /**
   * @param {string} [text]     Decoded chart text
   * @returns {Object}          A finished UBEBeatmap; BGM triggers are kept in audio.events
   * @throws {Error}            For RANDOM/conditional blocks, invalid lengths or unclosed long notes
   */
  parse(text = this.file) {
    const m = createUBEBeatmap();
    const source = this.#readSource(text);

    this.#checkHeader(source.header);
    this.#readMetadata(m, source);

    const events = this.#readEvents(source);
    const clock = this.#readTiming(m, source, events);
    const channels = this.#readLanes(m, events);

    this.#readObjects(m, source, events, clock, channels);
    if (m.audio.events.length || m.hitObjects.some((n) => n.hitsound)) {
      warn(m, "BMS uses scheduled samples/keysounds, not a single music file. Cross-format export needs an audio mix.");
    }

    return finish(m);
  }
}
