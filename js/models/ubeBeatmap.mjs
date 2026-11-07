/** 
 * UBE 1.0
 * 
 * Times/durations in milliseconds; zero based lanes; beats in quarter notes
 *  Taps have endTime=null
 * Holds/rolls have endTime>time
 * Asset paths are relative to the source chart
 * Format specific data lives in ext
 */
export function createUBEBeatmap() {
  return {
    format: "UBEBeatmap",
    version: "1.0",
    metadata: {
      title:         "",
      titleUnicode:  "",
      artist:        "",
      artistUnicode: "",
      creator:       "",
      version:       "",
      source:        "",
      description:   "",
      beatmapId:     "",
      beatmapSetId:  "",
      tags:          [],
      ext: {}
    },
    difficulty: {
      keyCount:              4,
      overallDifficulty:     5,
      initialScrollVelocity: 1,
      rating:                1,
      ext: {}
    },
    audio: {
      file:        "",
      previewTime: -1,
      events:      [],
      ext: {}
    },
    visual: {
      background: "",
      banner:     "",
      ext: {}
    },
    editor: {
      bookmarks: [],
      ext: {}
    },
    timing: {
      baseBPM:      120,
      beatZeroTime:   0,
      points:        [],
      modifiers: {
        scrollVelocities: [],
        stops:            [],
        speedChanges:     []
      },
      ext: {}
    },
    lanes:      [],
    hitObjects: [],
    provenance: {
      sourceFormat:  "",
      sourceVersion: ""
    },
    warnings: [],
    ext: {}
  };
}

/**
 * @param {Object} [fields]   Timing point fields
 * @returns {Object}          A BPM timing point
 */
export const createTimingPoint = ({
  time = 0,
  bpm = 120,
  beat,
  scrollSpeed = 1,
  meter = { numerator: 4, denominator: 4 },
  ext = {},
} = {}) => ({ time, bpm, beat, scrollSpeed, meter, ext });

/**
 * @param {Object} [fields]   Scroll velocity fields
 * @returns {Object}          A scroll velocity change
 */
export const createScrollVelocity = ({
  time = 0,
  multiplier = 1,
  ext = {},
} = {}) => ({ time, multiplier, ext });

/**
 * @param {Object} [fields]   Stop fields
 * @returns {Object}          A timed stop
 */
export const createStop = ({
  time = 0,
  duration = 0,
  beat,
  ext = {},
} = {}) => ({ time, duration, beat, ext });

/**
 * @param {Object} [fields]   Lane fields
 * @returns {Object}          Lane display information
 */
export const createLaneInfo = ({
  index = 0,
  name = "",
  visible = true,
  keysound = "",
  ext = {},
} = {}) => ({ index, name, visible, keysound, ext });

/**
 * @param {Object} [fields]   Note fields
 * @returns {Object}          A tap, hold or other note
 */
export const createHitObject = ({
  id = 0,
  lane = 0,
  time = 0,
  type = "tap",
  endTime = null,
  beat,
  endBeat,
  sound = "",
  hitsound = "",
  volume = 100,
  ext = {},
} = {}) => ({ id, lane, time, type, endTime, beat, endBeat, sound, hitsound, volume, ext });

/**
 * Record an import limitation once per map
 * 
 * @param {Object} map        UBEBeatmap receiving the warning
 * @param {string} message    Warning text
 */
export function warn(map, message) {
  if (!map.warnings.includes(message)) {
    map.warnings.push(message);
  }
}

/**
 * Read a finite number, using a fallback only when the source value is absent
 * 
 * @param {*} value               Source field
 * @param {number} [fallback]     Value for a missing field; omitted means required
 * @param {string} [label]        Field name used in error messages
 * @returns {number}              The finite numeric value
 * @throws {Error}                If the value is missing without a fallback, or not finite
 */
export function number(value, fallback, label = "number") {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error(`Missing ${label}.`);
  }

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${label}: ${String(value).slice(0, 60)}`);
  }

  return n;
}

/**
 * Validate and normalize a parsed map in place: sort timing and notes, renumber
 *  note IDs, set the base BPM and create default lanes
 * 
 * @param {Object} map    UBEBeatmap produced by a parser or UBE import
 * @returns {Object}      The same map
 * @throws {Error}        If key count, timing, stops or notes are invalid
 */
export function finish(map) {
  const keys = map.difficulty.keyCount;

  if (!Number.isInteger(keys) || keys < 1 || keys > 18) {
    throw new Error(`Unsupported key count: ${keys}.`);
  }
  if (!map.timing.points.length) {
    throw new Error("The chart has no BPM timing points.");
  }
  if (map.hitObjects.length > 500000) {
    throw new Error("Chart exceeds the 500,000-note limit.");
  }

  map.timing.points.sort((a,b) => a.time - b.time);

  for (const p of map.timing.points) {
    if (!Number.isFinite(p.time) || !Number.isFinite(p.bpm) || p.bpm <= 0) {
      throw new Error("BPMs must be positive and timing offsets finite.");
    }
  }

  map.timing.baseBPM = map.timing.points[0].bpm;
  map.timing.modifiers.scrollVelocities.sort((a, b) => a.time - b.time);

  for (const sv of map.timing.modifiers.scrollVelocities) {
    if (!Number.isFinite(sv.time) || !Number.isFinite(sv.multiplier)) {
      throw new Error("Invalid scroll velocity.");
    }
  }

  for (const s of map.timing.modifiers.stops) {
    if (!Number.isFinite(s.time) || !Number.isFinite(s.duration) || s.duration < 0) {
      throw new Error("Invalid stop.");
    }
  }
  
  map.hitObjects.sort((a,b) => a.time - b.time || a.lane - b.lane);
  
  for (const [i, n] of map.hitObjects.entries()) {
    if (!Number.isFinite(n.time) || !Number.isInteger(n.lane) || n.lane < 0 || n.lane >= keys) {
      throw new Error(`Invalid time/lane at note ${i + 1}.`);
    }
    if (!["tap", "hold", "roll", "mine", "lift", "fake"].includes(n.type)) {
      throw new Error(`Unsupported note type: ${n.type}.`);
    }
    if (["hold", "roll"].includes(n.type) && (!Number.isFinite(n.endTime) || n.endTime <= n.time)) {
      throw new Error(`Invalid hold ending at note ${i + 1}.`);
    }

    n.id = i;
  }

  if (!map.lanes.length) {
    map.lanes = Array.from({ length: keys }, (_, index) => createLaneInfo({ index, name: String(index + 1) }));
  }
  if (!map.hitObjects.length) {
    warn(map, "This chart contains no notes.");
  }

  return map;
}
