import { clean, decimal } from "./common.js";


/**
 * Format one osu! section as "Key:value" lines
 * 
 * @param {string} name     Section name
 * @param {Object} data     Key/value pairs in output order
 * @returns {string}        Section text
 */
function section(name, data) {
  return `[${name}]\n${Object.entries(data)
    .map(([k, v]) => `${k}:${clean(v)}`)
    .join("\n")}`;
}

/**
 * Writes an osu!mania v14 chart
 * Original osu! sections, when present in ext.osu, supply fields
 *  UBE does not model; canonical values always take precedence
 */
export class OsuSerializer {
  /**
   * @param {Object} m            Finished UBEBeatmap clone
   * @param {Object[]} notes      Supported notes from supportedNotes
   * @param {string[]} warnings   Receives export limitations
   */
  constructor(m, notes, warnings) {
    this.m        = m;
    this.notes    = notes;
    this.warnings = warnings;
    this.source   = m.ext.osu;
    this.keys     = m.difficulty.keyCount;
  }

  /**
   * @returns {Object} [General] pairs
   */
  #general() {
    const { m, source } = this;
    return {
      ...(source?.pairs.General || {}),
      AudioFilename: m.audio.file,
      AudioLeadIn: 0,
      PreviewTime: Math.round(m.audio.previewTime),
      Mode:      3,
      Countdown: 0
    };
  }

  /**
   * @returns {Object} [Editor] pairs
   */
  #editor() {
    return {
      ...(this.source?.pairs.Editor || {}),
      Bookmarks: this.m.editor.bookmarks.join(",")
    };
  }

  /**
   * @returns {Object} [Metadata] pairs; Unicode fields fall back to their romanized values
   */
  #metadata() {
    const { m, source } = this;
    return {
      ...(source?.pairs.Metadata || {}),
      Title:         m.metadata.title,
      TitleUnicode:  m.metadata.titleUnicode || m.metadata.title,
      Artist:        m.metadata.artist,
      ArtistUnicode: m.metadata.artistUnicode || m.metadata.artist,
      Creator:       m.metadata.creator,
      Version:       m.metadata.version || "Converted",
      Source:        m.metadata.source,
      Tags:          m.metadata.tags.join(" "),
      BeatmapID:    -1,
      BeatmapSetID: -1
    };
  }

  /**
   * @returns {Object} [Difficulty] pairs with defaults for fields mania ignores
   */
  #difficulty() {
    return {
      HPDrainRate:        5,
      ApproachRate:       5,
      SliderMultiplier: 1.4,
      SliderTickRate:     1,
      ...(this.source?.pairs.Difficulty || {}),
      CircleSize:        this.keys,
      OverallDifficulty: this.m.difficulty.overallDifficulty
    };
  }

  /**
   * @returns {string[]} [Events] lines: original non background events after the current background
   */
  #events() {
    const { m, source } = this;
    const events = source
      ? [...(source.sections.Events || [])].filter((s) => !/^0,|^Background,/.test(s))
      : [];

    if (m.visual.background) {
      events.unshift(`0,0,"${clean(m.visual.background).replace(/"/g, "")}",0,0`);
    }

    return events;
  }

  /**
   * Build uninherited BPM lines and inherited scroll velocity lines, sorted by time
   *  with BPM lines first at equal times
   * Scroll velocities that osu! cannot store are omitted or clamped with a warning
   * 
   * @returns {string[]} [TimingPoints] lines
   */
  #timingLines() {
    const { m, source, warnings } = this;
    const timing = [];

    for (const p of m.timing.points) {
      const raw = p.ext?.osu;

      timing.push({
        time:  p.time,
        order: 0,
        line: [
          decimal(p.time),
          decimal(60000 / p.bpm),
          p.meter?.numerator || 4,
          raw?.[3] ?? 1,
          raw?.[4] ?? 0,
          raw?.[5] ?? 100,
          1,
          raw?.[7] ?? 0
        ].join(",")
      });
    }

    for (const sv of m.timing.modifiers.scrollVelocities) {
      if (sv.ext?.redReset) {
        continue;
      }

      if (sv.multiplier <= 0) {
        warnings.push("Zero/negative scroll velocity omitted: osu! inherited timing cannot represent it.");

        continue;
      }

      const multiplier = Math.max(0.1, Math.min(10, sv.multiplier));
      if (multiplier !== sv.multiplier) {
        warnings.push("An osu! scroll multiplier was clamped to the supported 0.1-10 range.");
      }

      const raw = sv.ext?.osu;
      timing.push({
        time: sv.time,
        order: 1,
        line: [
          decimal(sv.time),
          decimal(-100 / multiplier),
          4,
          raw?.[3] ?? 1,
          raw?.[4] ?? 0,
          raw?.[5] ?? 100,
          0,
          raw?.[7] ?? 0
        ].join(",")
      });
    }

    // Non osu! sources express their starting scroll speed as an inherited line at the first BPM
    if (m.difficulty.initialScrollVelocity !== 1 && !source) {
      const v = m.difficulty.initialScrollVelocity;
      if (v > 0) {
        timing.push({
          time: m.timing.points[0].time,
          order: 1,
          line: `${decimal(m.timing.points[0].time)},${decimal(-100 / Math.max(0.1, Math.min(10, v)))},4,1,0,100,0,0`
        });
      }
    }

    return timing
      .sort((a, b) => a.time - b.time || a.order - b.order)
      .map((t) => t.line);
  }

  /**
   * Write one tap or hold, centering x in its lane across the 512-unit playfield
   * 
   * @param {Object} n    Supported note
   * @returns {string}    [HitObjects] line
   * @throws {Error}      If a hold becomes shorter than 1 ms after rounding
   */
  #hitObject(n) {
    const x      = Math.floor(((n.lane + 0.5) * 512) / this.keys);
    const hold   = n.type === "hold";
    const sample = n.ext?.osu?.sample || `0:0:0:${n.volume || 80}:${clean(n.hitsound)}`;

    if (hold && Math.round(n.endTime) <= Math.round(n.time)) {
      throw new Error("An osu! hold becomes shorter than 1 ms after rounding.");
    }

    return [
      x,
      192,
      Math.round(n.time),
      hold ? 128 : 1,
      n.ext?.osu?.hitSound || 0,
      hold ? `${Math.round(n.endTime)}:${sample}` : sample
    ].join(",");
  }

  /**
   * @returns {string}    .osu file text
   * @throws {Error}      If the lane count or hold lengths cannot be represented
   */
  serialize() {
    if (this.keys > 18) {
      throw new Error("osu!mania supports at most 18 lanes.");
    }

    const general    = this.#general();
    const metadata   = this.#metadata();
    const difficulty = this.#difficulty();
    const events     = this.#events();
    const timing     = this.#timingLines();
    const objects    = this.notes.map((n) => this.#hitObject(n));

    return ([
      "osu file format v14",
      section("General", general),
      section("Editor", this.#editor()),
      section("Metadata", metadata),
      section("Difficulty", difficulty),
      `[Events]\n${events.join("\n")}`,
      `[TimingPoints]\n${timing.join("\n")}`,
      `[HitObjects]\n${objects.join("\n")}`
    ].join("\n\n") + "\n");
  }
}

/**
 * Write an osu!mania v14 chart, reusing original osu! sections when available
 * 
 * @param {Object} m            Finished UBEBeatmap clone
 * @param {Object[]} notes      Supported notes from supportedNotes
 * @param {string[]} warnings   Receives export limitations
 * @returns {string}            .osu file text
 * @throws {Error}              If the lane count or hold lengths cannot be represented
 */
export function serializeOsu(m, notes, warnings) {
  return new OsuSerializer(m, notes, warnings).serialize();
}
