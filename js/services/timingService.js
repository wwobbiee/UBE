/**
 * Build a forward clock in milliseconds from quarter-note beats
 * BPM ties retain source order (last value wins); stops follow the note/BPMs at
 * their beat and add their durations. Exact beat lookup returns the stop's start
 * Inputs are copied, not sorted or changed in place. Arithmetic uses JS numbers;
 * event identity uses exact coordinates, without rounding or epsilon grouping
 * 
 * @param {Object[]} bpms                                                         Finite nonnegative beats and positive finite BPMs
 * @param {Object[]} stops                                                        Finite nonnegative beats and durations (milliseconds)
 * @param {number} zeroTime                                                       Milliseconds at beat zero; negative offsets are supported
 * @returns {{at: function(number): number, points: Object[], stops: Object[]}}   Clock and copied timed records
 * @throws {Error}                                                                Unsupported BPM/beat or stop value
 */
export function beatClock(bpms, stops = [], zeroTime = 0) {
  const sorted = [...bpms].sort((a, b) => a.beat - b.beat);
  if (!sorted.length || sorted.some((p) => !Number.isFinite(p.beat) || p.beat < 0 || !Number.isFinite(p.bpm) || p.bpm <= 0)) {
    throw new Error("Unsupported BPM/beat value (negative BPMs and warps are not supported).");
  }

  if (sorted[0].beat !== 0) {
    sorted.unshift({
      beat: 0,
      bpm: sorted[0].bpm
    });
  }

  if (stops.some((s) => !Number.isFinite(s.beat) || s.beat < 0 || !Number.isFinite(s.duration) || s.duration < 0)) {
    throw new Error("Unsupported stop value.");
  }

  const segments = [{
    beat: 0,
    time: zeroTime,
    bpm: sorted[0].bpm
  }];

  let beat = 0;
  let time = zeroTime;
  let bpm  = sorted[0].bpm;

  const beats = [...new Set([...sorted.map((p) => p.beat), ...stops.map((s) => s.beat)])].sort((a, b) => a - b);
  const times = new Map();

  for (const next of beats) {
    time += ((next - beat) * 60000) / bpm;
    beat = next;
    times.set(beat, time);

    for (const p of sorted) {
      if (p.beat === beat) {
        bpm = p.bpm;
      }
    }

    for (const s of stops) {
      if (s.beat === beat) {
        time += s.duration;
      }
    }

    segments.push({
      beat,
      time,
      bpm
    });
  }

  /**
   * @param {number} b    Beat
   * @returns {number}    Milliseconds, including earlier stops
   */
  const at = (b) => {
    if (times.has(b)) {
      return times.get(b);
    }

    let lo = 0;
    let hi = segments.length;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if (segments[mid].beat < b) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const p = segments[Math.max(0, lo - 1)];
    return p.time + ((b - p.beat) * 60000) / p.bpm;
  };

  return {
    at,
    points: sorted.map((p) => ({
      ...p,
      time: at(p.beat)
    })),
    stops:  stops.map((s) => ({
      ...s,
      time: at(s.beat)
    }))
  };
}

/**
 * Assign newly timed arrays to a caller-owned map, preserving source event records
 * 
 * @param {Object} map        Mutable UBEBeatmap with a timing record
 * @param {Object[]} bpms     Beat/BPM records
 * @param {Object[]} stops    Beat/duration records, in milliseconds
 * @param {number} zeroTime   Milliseconds at beat zero
 * @returns {Object}          Forward clock from beatClock; its arrays are assigned to map
 * @throws {Error}            Unsupported beat-clock values
 */
export function applyBeatTiming(map, bpms, stops = [], zeroTime = 0) {
  const clock = beatClock(bpms, stops, zeroTime);

  map.timing.beatZeroTime    = zeroTime;
  map.timing.points          = clock.points;
  map.timing.modifiers.stops = clock.stops;

  return clock;
}

/**
 * Infer a quarter-note beat without changing the input map
 * The first timing point anchors its finite beat, or beat zero for millisecond formats
 * Before it, extrapolate with its BPM; beatZeroTime metadata is not used
 * At one timestamp, BPMs retain source order and precede stops
 * Simultaneous stops add their durations and hold the beat through the combined
 *  ending boundary
 * Time resumes immediately after that boundary at the final BPM for the timestamp
 * 
 * @param {Object} map    Normalized UBEBeatmap with time-ordered timing points
 * @param {number} time   Finite milliseconds, including negative times
 * @returns {number}      Beat, using binary64 arithmetic and exact timestamp equality
 */
export function timeToBeat(map, time) {
  const points = map.timing.points;
  let beat     = Number.isFinite(points[0].beat) ? points[0].beat : 0;
  let cursor   = points[0].time;
  let bpm      = points[0].bpm;

  if (time < cursor) {
    return beat + ((time - cursor) * bpm) / 60000;
  }

  const events = [
    ...points.slice(1).map((p) => ({ ...p, kind: "bpm" })),
    ...map.timing.modifiers.stops.map((s) => ({ ...s, kind: "stop" }))
  ].sort((a, b) => {
    if (a.time !== b.time) {
      return a.time - b.time;
    }
    if (a.kind === b.kind) {
      return 0;
    }

    return a.kind === "bpm" ? -1 : 1;
  });

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.time > time) {
      break;
    }

    beat  += (Math.max(0, e.time - cursor) * bpm) / 60000;
    cursor = e.time;

    if (e.kind === "bpm") {
      bpm = e.bpm;
    } else {
      // Same-time stops share a start, not successive starts
      // Consume them once so a later stop cannot rewind the cursor
      //  or discard an earlier duration
      let duration = e.duration;
      while (events[i + 1]?.kind === "stop" && events[i + 1].time === e.time) {
        i++;
        duration += events[i].duration;
      }

      if (time <= e.time + duration) {
        return beat;
      }

      cursor += duration;
    }
  }

  return beat + ((time - cursor) * bpm) / 60000;
}

/**
 * Project copied timing/note records into beats for beat-based writers
 * Existing finite beats/endBeats take precedence; missing/nonfinite values use timeToBeat
 * Non-hold null endpoints remain null. No coherence validation or deep clone
 *  of nested extras is performed, and the source map is unchanged
 * 
 * @param {Object} map                                                Normalized UBEBeatmap
 * @returns {{points: Object[], stops: Object[], notes: Object[]}}    Shallow record copies
 */
export function chartBeats(map) {
  return {
    points: map.timing.points.map((p) => ({
      ...p,
      beat: Number.isFinite(p.beat) ? p.beat : timeToBeat(map, p.time),
    })),
    stops: map.timing.modifiers.stops.map((s) => ({
      ...s,
      beat: Number.isFinite(s.beat) ? s.beat : timeToBeat(map, s.time),
    })),
    notes: map.hitObjects.map((n) => ({
      ...n,
      beat: Number.isFinite(n.beat) ? n.beat : timeToBeat(map, n.time),
      endBeat:
        n.endTime === null
          ? null
          : Number.isFinite(n.endBeat)
            ? n.endBeat
            : timeToBeat(map, n.endTime),
    }))
  };
}
