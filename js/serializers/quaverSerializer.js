import { dump } from "../../vendor/js-yaml.mjs";

/**
 * Writes a Quaver .qua YAML chart
 * Original Quaver fields, when present in ext.quaver, are kept;
 *  canonical values always take precedence
 */
export class QuaverSerializer {
  /**
   * @param {Object} m            Finished UBEBeatmap clone
   * @param {Object[]} notes      Supported notes from supportedNotes
   * @param {string[]} warnings   Receives export limitations
   */
  constructor(m, notes, warnings) {
    this.m        = m;
    this.notes    = notes;
    this.warnings = warnings;
    this.original = m.ext.quaver;
    this.scratch  = m.difficulty.ext.quaver?.scratch || false;
    this.keys     = m.difficulty.keyCount - (this.scratch ? 1 : 0);
  }

  /**
   * @returns {Object} Asset, mode, metadata and scroll fields in Quaver's key order
   */
  #songFields() {
    const { m, original } = this;
    return {
      AudioFile:       m.audio.file,
      SongPreviewTime: Math.round(m.audio.previewTime),
      BackgroundFile:  m.visual.background,
      BannerFile:      m.visual.banner,
      MapId:          -1,
      MapSetId:       -1,
      Mode:            `Keys${this.keys}`,
      HasScratchKey:   this.scratch,
      Title:           m.metadata.title,
      Artist:          m.metadata.artist,
      Source:          m.metadata.source,
      Tags:            m.metadata.tags.join(" "),
      Creator:         m.metadata.creator,
      DifficultyName:  m.metadata.version || "Converted",
      Description:     m.metadata.description,
      BPMDoesNotAffectScrollVelocity: original?.BPMDoesNotAffectScrollVelocity ?? false,
      InitialScrollVelocity:          m.difficulty.initialScrollVelocity
    };
  }

  /**
   * @returns {Object[]} TimingPoints, keeping each point's original Quaver fields
   */
  #timingPoints() {
    return this.m.timing.points.map((t) => ({
      ...t.ext?.quaver,
      StartTime: t.time,
      Bpm:       t.bpm,
      Signature: t.meter?.numerator || 4
    }));
  }

  /**
   * @returns {Object[]} SliderVelocities, excluding osu! BPM-line reset markers
   */
  #sliderVelocities() {
    return this.m.timing.modifiers.scrollVelocities
      .filter((s) => !s.ext?.redReset)
      .map((s) => ({
        ...s.ext?.quaver,
        StartTime:  s.time,
        Multiplier: s.multiplier
      }));
  }

  /**
   * @param {Object} n    Supported note
   * @returns {Object}    HitObject with a one-based lane; EndTime 0 marks a tap
   * @throws {Error}      If a hold becomes shorter than 1 ms after rounding
   */
  #hitObject(n) {
    if (n.endTime !== null && Math.round(n.endTime) <= Math.round(n.time)) {
      throw new Error("A Quaver hold becomes shorter than 1 ms after rounding.");
    }

    return {
      ...n.ext?.quaver,
      StartTime: Math.round(n.time),
      Lane:      n.lane + 1,
      EndTime:   n.endTime === null ? 0 : Math.round(n.endTime),
      Type:      n.type === "mine" ? "Mine" : "Normal"
    };
  }

  /**
   * @returns {string}    .qua file text
   * @throws {Error}      If the key count or hold lengths cannot be represented
   */
  serialize() {
    if (this.keys < 1 || this.keys > 10) {
      throw new Error("Quaver output requires 1-10 keys (plus an optional scratch lane).");
    }

    const fields = {
      ...(this.original || {}),
      ...this.#songFields(),
      TimingPoints:     this.#timingPoints(),
      SliderVelocities: this.#sliderVelocities(),
      HitObjects:       this.notes.map((n) => this.#hitObject(n))
    };

    if (!this.original && this.notes.some((n) => n.hitsound)) {
      this.warnings.push("Custom note samples are not mapped to Quaver sample indices.");
    }

    return dump(fields, {
      lineWidth: -1,
      noRefs: true
    });
  }
}

/**
 * Write a Quaver .qua YAML chart, keeping original Quaver fields when available
 * 
 * @param {Object} m            Finished UBEBeatmap clone
 * @param {Object[]} notes      Supported notes from supportedNotes
 * @param {string[]} warnings   Receives export limitations
 * @returns {string}            .qua file text
 * @throws {Error}              If the key count or hold lengths cannot be represented
 */
export function serializeQuaver(m, notes, warnings) {
  return new QuaverSerializer(m, notes, warnings).serialize();
}
