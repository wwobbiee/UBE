/** 
 * Render BMS sample schedules locally into PCM WAV
 * Missing samples block mixing instead of silently producing an incomplete soundtrack
 * Note timing is untouched
 */
export async function renderBmsMix(job) {
  const warnings = [];
  if (job.missing.length) {
    return {
      id: job.id,
      warnings: [
        `Audio mix not created: ${job.missing.length} sample(s) missing (${job.missing.slice(0, 6).join(", ")}). Supply the complete BMS song folder.`
      ]
    };
  }

  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) {
    return {
      id: job.id,
      warnings: [
        "This browser cannot render BMS audio; export BMS/UBE or provide a mixed audio file."
      ]
    };
  }

  try {
    const decoder = new Offline(2, 1, 44100);
    const buffers = new Map();
    for (const [file, bytes] of Object.entries(job.assets)) {
      buffers.set(file, await decoder.decodeAudioData(bytes.slice().buffer));
    }

    const end = job.events.reduce((end, e) => Math.max(end, e.time / 1000 + buffers.get(e.file).duration), 0);

    if (!Number.isFinite(end) || end <= 0 || end > 600) {
      throw new Error("Automatic BMS audio mixing is limited to 10 minutes.");
    }

    const context = new Offline(2, Math.ceil((end + 0.1) * 44100), 44100);
    for (const e of job.events) {
      if (e.time < 0) {
        throw new Error("Negative-time BMS audio events need manual mixing.");
      }

      const source  = context.createBufferSource();
      source.buffer = buffers.get(e.file);
      source.connect(context.destination);
      source.start(e.time / 1000);
    }

    let peak       = 1;
    const result   = await context.startRendering();
    const channels = [result.getChannelData(0), result.getChannelData(1)];

    for (const channel of channels) {
      for (const v of channel) peak = Math.max(peak, Math.abs(v));
    }

    if (peak > 1) {
      warnings.push("BMS audio mix gain reduced to prevent clipping.");
    }

    warnings.push("BMS keysounds were baked into a music track; they will play automatically instead of following key presses.");

    const data = new Uint8Array(44 + result.length * 4);
    const view = new DataView(data.buffer);
    const write = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));

    write(0, "RIFF");
    view.setUint32(4, data.length - 8, true);
    write(8, "WAVEfmt ");
    view.setUint32(16, 16,     true);
    view.setUint16(20, 1,      true);
    view.setUint16(22, 2,      true);
    view.setUint32(24, 44100,  true);
    view.setUint32(28, 176400, true);
    view.setUint16(32, 4,      true);
    view.setUint16(34, 16,     true);
    write(36, "data");
    view.setUint32(40, result.length * 4, true);

    for (let i = 0; i < result.length; i++)
      for (let channel = 0; channel < 2; channel++) {
        const value = channels[channel][i] / peak;
        view.setInt16(44 + i * 4 + channel * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }

    return {
      id:    job.id,
      path:  job.path,
      bytes: data,
      warnings
    };

  } catch (e) {
    return {
      id: job.id,
      warnings: [`BMS audio mix failed: ${e.message}`]
    };
  }
}
