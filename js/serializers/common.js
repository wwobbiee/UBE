/**
 * @param {*} value     Field value
 * @returns {string}    Text with line breaks and NULs replaced by spaces
 */
export const clean = (value) => String(value ?? "").replace(/[\r\n\0]/g, " ");

/**
 * @param {number} value    Number to write
 * @returns {string}        Shortest form, rounded to 9 decimals
 */
export const decimal = (value) => Number(Number(value).toFixed(9)).toString();

/**
 * @param {*} value     Field value
 * @returns {string}    Text escaped for an SM/DWI tag value
 */
export const smText = (value) => clean(value)
  .replace(/\\/g, "\\\\")
  .replace(/:/g, "\\:")
  .replace(/;/g, "\\;")
  .replace(/\/\//g, "/ /");

/**
 * Copy the notes a destination can represent, converting rolls to holds where needed
 * 
 * @param {Object} map            Finished UBEBeatmap
 * @param {string} target         Destination format
 * @param {string[]} warnings     Receives omitted/converted note counts
 * @returns {Object[]}            Shallow note copies for the serializer
 * @throws {Error}                If no supported notes remain in a nonempty chart
 */
export function supportedNotes(map, target, warnings) {
  const allowed =
    target === "stepmania"
      ? ["tap", "hold", "roll", "mine", "lift", "fake"]
      : target === "quaver"
        ? ["tap", "hold", "mine"]
        : ["tap", "hold"];

  const counts = {};
  const notes  = map.hitObjects.flatMap((n) => {
    if (allowed.includes(n.type)) {
      return [{
        ...n
      }];
    }

    counts[n.type] = (counts[n.type] || 0) + 1;

    return n.type === "roll" ? [{ ...n, type: "hold" }] : [];
  });

  for (const [type, count] of Object.entries(counts)) {
    warnings.push(`${count} ${type} note(s) ${type === "roll" ? "converted to holds" : "omitted"}: unsupported by ${target}.`);
  }

  if (map.hitObjects.length && !notes.length) {
    throw new Error("No supported notes remain for this destination.");
  }

  return notes;
}

/**
 * Report source features that cannot transfer to the destination format
 * 
 * @param {Object} map          Finished UBEBeatmap
 * @param {string} target       Destination format
 * @param {string[]} warnings   Receives the export warnings
 */
export function crossWarnings(map, target, warnings) {
  if (["osu", "quaver"].includes(target) && map.hitObjects.some((n) => n.time < 0)) {
    warnings.push("Notes before audio time zero are retained; the destination game may require a timing adjustment.");
  }

  if (target === map.provenance.sourceFormat) {
    return;
  }

  if (map.timing.modifiers.stops.length && ["osu", "quaver"].includes(target)) {
    warnings.push("Stops are baked into note timestamps; the destination does not retain stop/beat-grid semantics.");
  }

  if (map.timing.modifiers.scrollVelocities.some((s) => s.multiplier !== 1) || map.timing.modifiers.speedChanges.length) {
    warnings.push(
      ["stepmania", "beatmania"].includes(target)
        ? "Scroll velocity effects are omitted; note timing is retained."
        : "Scroll velocity behavior differs between games; speeds may differ even though note timing is retained.",
    );
  }

  if (map.provenance.sourceFormat === "osu") {
    warnings.push("osu! sample sets, storyboard events and game-specific difficulty settings are not fully transferable.");
  }
  if (map.provenance.sourceFormat === "quaver" && (map.hitObjects.some((n) => n.ext?.quaver?.KeySounds?.length) || map.ext.quaver?.SoundEffects?.length)) {
    warnings.push("Quaver keysounds and sound effects are omitted.");
  }
}
