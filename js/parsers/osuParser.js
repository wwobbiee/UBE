import { createUBEBeatmap, createHitObject, createTimingPoint, createScrollVelocity, finish, number, warn } from "../models/ubeBeatmap.mjs";

// UBE metadata fields and their osu! [Metadata] keys
const METADATA_KEYS = {
  title:         "Title",
  titleUnicode:  "TitleUnicode",
  artist:        "Artist",
  artistUnicode: "ArtistUnicode",
  creator:       "Creator",
  version:       "Version",
  source:        "Source",
  beatmapId:     "BeatmapID",
  beatmapSetId:  "BeatmapSetID"
};

/**
 * @param {string} line   osu! comma separated line
 * @returns {string[]}    Trimmed fields; quotes removed
 */
export function csv(line) {
  return (line.match(/(?:"[^"]*"|[^,])*(?:,|$)/g) || [])
    .filter((s, i, a) => s !== "" || i < a.length - 1)
    .map((s) => s.replace(/,$/, "").trim().replace(/^"|"$/g, ""));
}

// Reads osu!mania (.osu, Mode 3) beatmaps into UBEBeatmap records
export class OsuMap {
  /**
   * @param {string} file Decoded .osu text
   */
  constructor(file) {
    this.file = file;
  }

  /**
   * Split the file into raw section lines and key/value pairs
   *  Comments and lines before the first [Section] header are ignored
   * 
   * @param {string} text   Decoded .osu text
   * @returns {{sections: Object<string, string[]>, pairs: Object<string, Object<string, string>>}}
   */
  #readSections(text) {
    const sections = {};
    const pairs    = {};
    let section    = "";

    for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const line = raw.trim();

      if (!line || line.startsWith("//")) {
        continue;
      }

      if (/^\[.+\]$/.test(line)) {
        section             = line.slice(1, -1);
        sections[section] ??= [];
        pairs[section]    ??= {};

        continue;
      }

      if (!section) {
        continue;
      }

      sections[section].push(line);

      const colon = line.indexOf(":");
      if (colon >= 0) {
        pairs[section][line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
    }

    return {
      sections,
      pairs
    };
  }

  /**
   * @param {Object} m                          Map being built
   * @param {Object<string, string>} metadata   [Metadata] pairs
   */
  #readMetadata(m, metadata) {
    for (const [dest, src] of Object.entries(METADATA_KEYS)) {
      m.metadata[dest] = metadata[src] ?? "";
    }

    m.metadata.tags = (metadata.Tags || "").split(/\s+/).filter(Boolean);
  }

  /**
   * @param {Object} m                        Map being built
   * @param {Object<string, string>} general  [General] pairs
   */
  #readGeneral(m, general) {
    m.audio.file        = general.AudioFilename || "";
    m.audio.previewTime = number(general.PreviewTime, -1);
  }

  /**
   * @param {Object} m                            Map being built
   * @param {Object<string, string>} difficulty   [Difficulty] pairs
   */
  #readDifficulty(m, difficulty) {
    m.difficulty.keyCount          = number(difficulty.CircleSize, 4);
    m.difficulty.overallDifficulty = number(difficulty.OverallDifficulty, 5);
  }

  /**
   * @param {Object} m                          Map being built
   * @param {Object<string, string>} [editor]   [Editor] pairs
   */
  #readEditor(m, editor) {
    m.editor.bookmarks = (editor?.Bookmarks || "")
      .split(",")
      .filter(Boolean)
      .map((v) => number(v));
  }

  /**
   * Keep the background image; breaks are ignored and other events only warn,
   *  because they survive solely through the raw sections on osu! -> osu! export
   * 
   * @param {Object} m          Map being built
   * @param {string[]} lines    [Events] lines
   */
  #readEvents(m, lines) {
    for (const line of lines) {
      const e = csv(line);

      if (["0", "Background"].includes(e[0])) {
        m.visual.background = e[2] || "";

      } else if (!["2", "Break"].includes(e[0])) {
        warn(m, "Storyboard, video and event effects are only preserved on osu! -> osu! export.");
      }
    }
  }

  /**
   * Uninherited lines become BPM points plus a scroll reset marker; inherited lines
   *  become scroll velocities, clamped to osu!'s 0.1-10 range
   * 
   * @param {Object} m          Map being built
   * @param {string[]} lines    [TimingPoints] lines
   * @throws {Error}            If a beat length has the wrong sign for its line type
   */
  #readTimingPoints(m, lines) {
    for (const line of lines) {
      const p         = csv(line);
      const time      = number(p[0]);
      const length    = number(p[1]);
      const inherited = number(p[6], 1) === 0;

      if (!inherited) {
        if (length <= 0) {
          throw new Error("An osu! BPM timing line must have a positive beat length.");
        }

        m.timing.points.push(
          createTimingPoint({
            time,
            bpm: 60000 / length,
            meter: {
              numerator: number(p[2], 4),
              denominator: 4
            },
            ext: {
              osu: p
            }
          })
        );

        m.timing.modifiers.scrollVelocities.push(
          createScrollVelocity({
            time,
            multiplier: 1,
            ext: {
              redReset: true
            }
          })
        );

      } else {
        if (length >= 0) {
          throw new Error("An inherited osu! timing line must have a negative beat length.");
        }

        m.timing.modifiers.scrollVelocities.push(
          createScrollVelocity({
            time,
            multiplier: Math.max(0.1, Math.min(10, -100 / length)),
            ext: {
              osu: p
            }
          })
        );
      }
    }
  }

  /**
   * Read taps and holds
   * The column comes from x across the 512 unit playfield;
   *  a hold's end time precedes its hit sample in the extras field
   * 
   * @param {Object} m          Map being built; its key count must already be set
   * @param {string[]} lines    [HitObjects] lines
   * @throws {Error}            For sliders, spinners or invalid numbers
   */
  #readHitObjects(m, lines) {
    for (const line of lines) {
      const p     = csv(line);
      const flags = number(p[3]);
      const time  = number(p[2]);
      const hold  = !!(flags & 128);

      if (!hold && !(flags & 1)) {
        throw new Error("Unsupported osu!mania object (slider/spinner).");
      }

      const sample = hold
        ? (p[5] || "").split(":").slice(1).join(":")
        : p[5] || "";

      const lane = Math.min(
        m.difficulty.keyCount - 1,
        Math.floor((number(p[0]) * m.difficulty.keyCount) / 512),
      );

      m.hitObjects.push(
        createHitObject({
          lane,
          time,
          type: hold ? "hold" : "tap",
          endTime: hold ? number((p[5] || "").split(":")[0]) : null,
          hitsound: sample.split(":").slice(4).join(":"),
          ext: {
            osu: {
              flags,
              hitSound: number(p[4], 0), sample
            }
          },
        }),
      );
    }
  }

  /**
   * @param {string} [text]   Decoded .osu text
   * @returns {Object}        A finished UBEBeatmap; original sections are kept in ext.osu
   * @throws {Error}          If the file is not osu!mania or contains invalid timing/objects
   */
  parse(text = this.file) {
    if (!/^\uFEFF?osu file format v\d+/i.test(text.trimStart())) {
      throw new Error("Not an osu! beatmap.");
    }

    const m                   = createUBEBeatmap();
    const { sections, pairs } = this.#readSections(text);
    const general             = pairs.General || {};

    if (number(general.Mode, 0) !== 3) {
      throw new Error("Only osu!mania (Mode:3) is supported. Standard/taiko/catch need a gameplay conversion algorithm.");
    }

    m.provenance = {
      sourceFormat: "osu",
      sourceVersion: text.match(/format v(\d+)/)?.[1] || ""
    };

    this.#readMetadata(m, pairs.Metadata || {});
    this.#readGeneral(m, general);
    this.#readDifficulty(m, pairs.Difficulty || {});
    this.#readEditor(m, pairs.Editor);

    m.ext.osu = {
      sections,
      pairs
    };

    this.#readEvents(m, sections.Events || []);
    this.#readTimingPoints(m, sections.TimingPoints || []);
    this.#readHitObjects(m, sections.HitObjects || []);

    finish(m);
    m.timing.beatZeroTime = m.timing.points[0].time;
    
    return m;
  }
}

export default OsuMap;
