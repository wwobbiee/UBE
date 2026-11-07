import { createUBEBeatmap, createHitObject, createLaneInfo, createTimingPoint, createScrollVelocity, createStop, finish } from "./ubeBeatmap.mjs";

/**
 * Default an omitted record without accepting an explicit null or scalar
 * Unknown own fields survive; spread does not invoke the __proto__ setter
 * 
 * @param {Object|undefined} value Input from the private document clone
 * @param {Object} defaults        Fresh factory defaults for known optional fields
 * @param {string} path            Field path for diagnostics
 * @returns {Object}               New record with supplied fields taking precedence
 * @throws {Error}                 If a supplied value is not a record
 */
function readRecord(value, defaults, path) {
  if (value === undefined) {
    return defaults;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }

  return {
    ...defaults,
    ...value
  };
}

/**
 * @param {*[]|undefined} value   Optional array in a known UBE field
 * @param {string} path           Field path for diagnostics
 * @returns {*[]}                 Supplied private array, or a fresh empty array when omitted
 * @throws {Error}                If a supplied value is not an array
 */
function readArray(value, path) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  };

  return value;
}

/**
 * @param {*} value       Known UBE numeric value, with no string coercion
 * @param {string} path   Field path for diagnostics
 * @returns {void}
 * @throws {Error}        If the value is not a finite number
 */
function checkNumber(value, path) {
  if (!Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
}

/**
 * @param {*} value       Known UBE text value
 * @param {string} path   Field path for diagnostics
 * @returns {void}
 * @throws {Error}        If the value is not a string
 */
function checkString(value, path) {
  if (typeof value !== "string") {
    throw new Error(`${path} must be text.`);
  }
}

/**
 * Validate supplied timing events without inventing a BPM or event coordinate
 * 
 * @param {Object|undefined} input    Private timing record, if supplied
 * @param {Object} defaults           Fresh factory timing defaults
 * @returns {Object}                  Defaulted timing record ready for the existing finish operation
 * @throws {Error}                    If timing shapes or known numeric fields are invalid
 */
function readTiming(input, defaults) {
  const timing = readRecord(input, defaults, "timing");
  checkNumber(timing.baseBPM, "timing.baseBPM");

  if (timing.baseBPM <= 0) {
    throw new Error("timing.baseBPM must be positive.");
  }

  checkNumber(timing.beatZeroTime, "timing.beatZeroTime");

  timing.ext = readRecord(timing.ext, {}, "timing.ext");
  timing.points = readArray(timing.points, "timing.points");

  if (!timing.points.length) {
    throw new Error("timing.points must contain at least one BPM timing point.");
  }

  timing.points = timing.points.map((inputPoint, index) => {
    const path = `timing.points[${index}]`;

    // Time and BPM are required, even though the construction helper has defaults
    const point = readRecord(inputPoint, {}, path);
    checkNumber(point.time, path + ".time");
    checkNumber(point.bpm,  path + ".bpm");

    if (point.bpm <= 0) {
      throw new Error(`${path}.bpm must be positive.`);
    }

    const result = {
      ...createTimingPoint(),
      ...point
    };

    if (result.beat !== undefined) {
      checkNumber(result.beat, path + ".beat");
    }

    checkNumber(result.scrollSpeed, path + ".scrollSpeed");
    result.meter = readRecord(result.meter, { numerator: 4, denominator: 4 }, path + ".meter");

    for (const field of ["numerator", "denominator"]) {
      if (!Number.isInteger(result.meter[field]) || result.meter[field] <= 0) {
        throw new Error(`${path}.meter.${field} must be a positive integer.`);
      }
    }

    result.ext = readRecord(result.ext, {}, path + ".ext");

    return result;
  });

  const modifiers = readRecord(timing.modifiers, defaults.modifiers, "timing.modifiers");
  modifiers.scrollVelocities = readArray(modifiers.scrollVelocities, "timing.modifiers.scrollVelocities").map((inputVelocity, index) => {
    const path     = `timing.modifiers.scrollVelocities[${index}]`;
    const velocity = readRecord(inputVelocity, {}, path);

    checkNumber(velocity.time, path + ".time");
    checkNumber(velocity.multiplier, path + ".multiplier");

    const result = {
      ...createScrollVelocity(),
      ...velocity
    };

    result.ext = readRecord(result.ext, {}, path + ".ext");

    return result;
  });

  modifiers.stops = readArray(modifiers.stops, "timing.modifiers.stops").map((inputStop, index) => {
    const path = `timing.modifiers.stops[${index}]`;
    const stop = readRecord(inputStop, {}, path);

    checkNumber(stop.time, path + ".time");
    checkNumber(stop.duration, path + ".duration");

    if (stop.duration < 0) {
      throw new Error(`${path}.duration must not be negative.`);
    }

    const result = {
      ...createStop(),
      ...stop
    };
    if (result.beat !== undefined) {
      checkNumber(result.beat, path + ".beat");
    }

    result.ext = readRecord(result.ext, {}, path + ".ext");

    return result;
  });

  // The current model preserves these opaque source values and only consumes length
  modifiers.speedChanges = readArray(modifiers.speedChanges, "timing.modifiers.speedChanges");
  timing.modifiers = modifiers;

  return timing;
}

/**
 * Default note attributes without guessing playable positions or note types
 * 
 * @param {*[]|undefined} input     Private hitObjects value
 * @param {number} keys             Validated key count
 * @returns {Object[]}              New note records; finish assigns canonical order and IDs later
 * @throws {Error}                  If a note is malformed or contradicts its explicit kind
 */
function readNotes(input, keys) {
  const notes = readArray(input, "hitObjects");

  if (notes.length > 500000) {
    throw new Error("hitObjects exceeds the 500,000 note limit.");
  }

  return notes.map((inputNote, index) => {
    const path = `hitObjects[${index}]`;
    const note = readRecord(inputNote, {}, path);

    checkNumber(note.time, path + ".time");

    if (!Number.isInteger(note.lane) || note.lane < 0 || note.lane >= keys) {
      throw new Error(`${path}.lane must be an integer from 0 to ${keys - 1}.`);
    }
    if (!["tap", "hold", "roll", "mine", "lift", "fake"].includes(note.type)) {
      throw new Error(`${path}.type must be tap, hold, roll, mine, lift or fake.`);
    }

    const result = {
      ...createHitObject(),
      ...note
    };

    if (!Number.isInteger(result.id) || result.id < 0) {
      throw new Error(`${path}.id must be a nonnegative integer.`);
    }

    if (["hold", "roll"].includes(result.type)) {
      checkNumber(result.endTime, path + ".endTime");

      if (result.endTime <= result.time) {
        throw new Error(`${path}.endTime must be greater than time for a hold or roll.`);
      }
    } else if (result.endTime !== null) {
      throw new Error(`${path}.endTime must be null for ${result.type}.`);
    }

    for (const field of ["beat", "endBeat"]) {
      if (result[field] !== undefined) checkNumber(result[field], path + "." + field);
    }

    for (const field of ["sound", "hitsound"]) {
      checkString(result[field], path + "." + field);
    }

    checkNumber(result.volume, path + ".volume");
    result.ext = readRecord(result.ext, {}, path + ".ext");

    if (result.ext.osu?.sample !== undefined) {
      checkString(result.ext.osu.sample, path + ".ext.osu.sample");
    }

    return result;
  });
}

/**
 * Read one imported UBE 1.0 document into a privately owned, usable model
 *  This is the JSON import boundary, not a new validator for format parsers or a
 *  finalized portable schema. Unknown JSON fields and opaque ext values are retained
 * 
 * @param {Object} document   Caller owned JSON shaped doc
 * @returns {Object}          Fresh defaulted/validated model normalized by existing finish
 * @throws {Error}            If markers, known structures or canonical field invariants fail :(
 */
export function readUBEDocument(document) {
  const root = readRecord(document, {}, "document");

  if (root.format !== "UBEBeatmap" || root.version !== "1.0") {
    throw new Error("Expected a UBEBeatmap version 1.0 document.");
  }

  const input    = structuredClone(root);
  const defaults = createUBEBeatmap();
  const map = {
    ...defaults,
    ...input
  };

  map.metadata = readRecord(input.metadata, defaults.metadata, "metadata");
  for (const field of ["title", "titleUnicode", "artist", "artistUnicode", "creator", "version", "source", "description"]) {
    checkString(map.metadata[field], "metadata." + field);
  }

  for (const field of ["beatmapId", "beatmapSetId"]) {
    const value = map.metadata[field];

    if (typeof value !== "string" && !Number.isFinite(value)) {
      throw new Error(`metadata.${field} must be text or a finite number.`);
    }
  }

  map.metadata.tags = readArray(map.metadata.tags, "metadata.tags");
  map.metadata.tags.forEach((value, index) => checkString(value, `metadata.tags[${index}]`));
  map.metadata.ext = readRecord(map.metadata.ext, {}, "metadata.ext");
  map.difficulty   = readRecord(input.difficulty, defaults.difficulty, "difficulty");

  const keys = map.difficulty.keyCount;
  if (!Number.isInteger(keys) || keys < 1 || keys > 18) {
    throw new Error("difficulty.keyCount must be an integer from 1 to 18.");
  }

  for (const field of ["overallDifficulty", "initialScrollVelocity", "rating"]) {
    checkNumber(map.difficulty[field], "difficulty." + field);
  }

  map.difficulty.ext = readRecord(map.difficulty.ext, {}, "difficulty.ext");
  map.audio          = readRecord(input.audio, defaults.audio, "audio");

  checkString(map.audio.file, "audio.file");
  checkNumber(map.audio.previewTime, "audio.previewTime");

  map.audio.ext    = readRecord(map.audio.ext, {}, "audio.ext");
  map.audio.events = readArray(map.audio.events, "audio.events").map((inputEvent, index) => {
    const path = `audio.events[${index}]`;
    const event = readRecord(inputEvent, {}, path);

    checkNumber(event.time, path + ".time");
    checkString(event.file, path + ".file");

    if (event.beat !== undefined) {
      checkNumber(event.beat, path + ".beat");
    }

    event.ext = readRecord(event.ext, {}, path + ".ext");

    return event;
  });

  map.visual = readRecord(input.visual, defaults.visual, "visual");

  for (const field of ["background", "banner"]) {
    checkString(map.visual[field], "visual." + field);
  }

  map.visual.ext       = readRecord(map.visual.ext, {}, "visual.ext");
  map.editor           = readRecord(input.editor, defaults.editor, "editor");
  map.editor.bookmarks = readArray(map.editor.bookmarks, "editor.bookmarks");
  map.editor.bookmarks.forEach((value, index) => checkNumber(value, `editor.bookmarks[${index}]`));
  map.editor.ext       = readRecord(map.editor.ext, {}, "editor.ext");
  map.timing           = readTiming(input.timing, defaults.timing);

  map.lanes = readArray(input.lanes, "lanes").map((inputLane, index) => {
    const path = `lanes[${index}]`;
    const lane = readRecord(inputLane, {}, path);

    if (!Number.isInteger(lane.index) || lane.index < 0 || lane.index >= keys) {
      throw new Error(`${path}.index must be an integer from 0 to ${keys - 1}.`);
    }

    const result = {
      ...createLaneInfo(),
      ...lane
    };

    for (const field of ["name", "keysound"]) {
      checkString(result[field], path + "." + field);
    }

    if (typeof result.visible !== "boolean") {
      throw new Error(`${path}.visible must be true or false.`);
    }

    result.ext = readRecord(result.ext, {}, path + ".ext");

    return result;
  });

  map.hitObjects = readNotes(input.hitObjects, keys);
  map.provenance = readRecord(input.provenance, defaults.provenance, "provenance");

  for (const field of ["sourceFormat", "sourceVersion"]) {
    checkString(map.provenance[field], "provenance." + field);
  }

  if (map.provenance.sourcePath !== undefined) {
    checkString(map.provenance.sourcePath, "provenance.sourcePath");
  }

  map.warnings = readArray(input.warnings, "warnings");
  map.warnings.forEach((value, index) => checkString(value, `warnings[${index}]`));
  map.ext = readRecord(input.ext, {}, "ext");

  return finish(map);
}
