import { load, JSON_SCHEMA } from "../../vendor/js-yaml.mjs";
import { createUBEBeatmap, createHitObject, createTimingPoint, createScrollVelocity, finish, number, warn } from "../models/ubeBeatmap.mjs";

// Numeric Quaver game modes mapped to their base key counts
const NUMERIC_MODES = {
  1:   4,
  2:   7,
  3:   1,
  4:   2,
  5:   3,
  6:   5,
  7:   6,
  8:   8,
  9:   9,
  10: 10
};

// UBE metadata fields and their Quaver keys
const METADATA_KEYS = {
  title:        "Title",
  artist:       "Artist",
  creator:      "Creator",
  version:      "DifficultyName",
  source:       "Source",
  description:  "Description",
  beatmapId:    "MapId",
  beatmapSetId: "MapSetId"
};

// Reads Quaver (.qua) YAML charts into UBEBeatmap records
export default class QuaverParser {
  /**
   * @param {string} file Decoded .qua text
   */
  constructor(file) {
    this.file = file;
  }

  /**
   * Load the YAML with the JSON schema and require a map with a HitObjects list
   * 
   * @param {string} text     Decoded .qua text
   * @returns {Object}        Parsed Quaver fields
   * @throws {Error}          If the YAML is not a Quaver chart map or contains recursive aliases
   */
  #readSource(text) {
    const parsed = load(text, { schema: JSON_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.HitObjects)) {
      throw new Error("Invalid Quaver file: expected a YAML map with HitObjects.");
    }

    // Reject recursive YAML aliases before keeping the original fields
    JSON.stringify(parsed);

    return parsed;
  }

  /**
   * @param {Object} m    Map being built
   * @param {Object} p    Parsed Quaver fields
   */
  #readMetadata(m, p) {
    for (const [dest, src] of Object.entries(METADATA_KEYS)) {
      m.metadata[dest] = p[src] ?? "";
    }

    m.metadata.tags = String(p.Tags || "")
      .split(/[ ,]+/)
      .filter(Boolean);
  }

  /**
   * Resolve the key count from a numeric or "Keys<n>" mode, adding the optional
   *  scratch lane, and record the initial scroll velocity
   * 
   * @param {Object} m    Map being built
   * @param {Object} p    Parsed Quaver fields
   */
  #readKeys(m, p) {
    const baseKeys =
      typeof p.Mode === "number"
        ? NUMERIC_MODES[p.Mode]
        : Number(String(p.Mode || "Keys4").replace("Keys", ""));

    m.difficulty.keyCount              = baseKeys + (p.HasScratchKey ? 1 : 0);
    m.difficulty.initialScrollVelocity = number(p.InitialScrollVelocity, 1);
    m.difficulty.ext.quaver = {
      bpmIndependent: !!p.BPMDoesNotAffectScrollVelocity,
      baseKeys,
      scratch: !!p.HasScratchKey
    };
  }

  /**
   * @param {Object} m    Map being built
   * @param {Object} p    Parsed Quaver fields
   */
  #readAssets(m, p) {
    m.audio.file        = p.AudioFile || "";
    m.audio.previewTime = number(p.SongPreviewTime, -1);
    m.visual.background = p.BackgroundFile || "";
    m.visual.banner     = p.BannerFile || "";
  }

  /**
   * Read BPM points and default group scroll velocities. Scroll speed factors are
   *  kept as is; each record keeps its source fields in ext.quaver
   * 
   * @param {Object} m    Map being built
   * @param {Object} p    Parsed Quaver fields
   */
  #readTiming(m, p) {
    m.timing.points = (p.TimingPoints || []).map((t) =>
      createTimingPoint({
        time: number(t.StartTime, 0),
        bpm:  number(t.Bpm),
        meter: {
          numerator: number(t.Signature, 4),
          denominator: 4
        },
        ext: {
          quaver: t
        }
      })
    );

    m.timing.modifiers.scrollVelocities = (p.SliderVelocities || []).map((t) =>
      createScrollVelocity({
        time:       number(t.StartTime, 0),
        multiplier: number(t.Multiplier, 1),
        ext: {
          quaver: t
        }
      })
    );

    m.timing.modifiers.speedChanges = p.ScrollSpeedFactors || [];
  }

  /**
   * Quaver lanes are one-based; a positive EndTime makes a hold, and mines are
   *  identified by name or by their numeric type
   * 
   * @param {Object} m                Map being built
   * @param {Object[]} hitObjects     Parsed HitObjects
   */
  #readHitObjects(m, hitObjects) {
    for (const ho of hitObjects) {
      const time = number(ho.StartTime, 0);
      const end  = number(ho.EndTime, 0);
      const mine = ho.Type === "Mine" || ho.Type === 1;

      m.hitObjects.push(
        createHitObject({
          time,
          lane: number(ho.Lane) - 1,
          type: mine ? "mine" : end > 0 ? "hold" : "tap",
          endTime: end > 0 ? end : null,
          ext: {
            quaver: ho
          }
        })
      );
    }
  }

  /**
   * @param {Object} m    Map being built
   * @param {Object} p    Parsed Quaver fields
   */
  #warnUnsupported(m, p) {
    if (p.TimingGroups && Object.keys(p.TimingGroups).length) {
      warn(m, "Quaver timing groups are only preserved on Quaver -> Quaver export.");
    }

    if ((p.CustomAudioSamples || []).length || (p.SoundEffects || []).length) {
      warn(m, "Quaver custom samples/effects are only preserved on Quaver -> Quaver export.");
    }
  }

  /**
   * Convert parsed Quaver fields into a finished UBEBeatmap
   * 
   * @param {Object} p    Parsed Quaver fields; kept unchanged in ext.quaver
   * @returns {Object}    A finished UBEBeatmap
   */
  toUBE(p) {
    const m = createUBEBeatmap();
    m.provenance.sourceFormat = "quaver";
    m.ext.quaver = p;

    this.#readMetadata(m, p);
    this.#readKeys(m, p);
    this.#readAssets(m, p);
    this.#readTiming(m, p);
    this.#readHitObjects(m, p.HitObjects || []);
    this.#warnUnsupported(m, p);

    finish(m);
    m.timing.beatZeroTime = m.timing.points[0].time;

    return m;
  }

  /**
   * @param {string} [text]     Decoded .qua text
   * @returns {Object}          A finished UBEBeatmap
   * @throws {Error}            If the YAML is not a Quaver chart map
   */
  parse(text = this.file) {
    return this.toUBE(this.#readSource(text));
  }
}
