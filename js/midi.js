/* A small Standard MIDI File reader with tempo-map support.
   Format 0 and 1 are supported. Data never leaves the page. */

const DEFAULT_TEMPO = 500000; // microseconds per quarter note
const LEAD_IN_SECONDS = 1.25;
const MAX_NOTES = 30000;

class MidiError extends Error {}

function readAscii(view, offset, length) {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

function readVarInt(view, state) {
  let value = 0;
  let bytes = 0;
  while (state.offset < view.byteLength) {
    const byte = view.getUint8(state.offset);
    state.offset += 1;
    bytes += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
    if (bytes > 4) throw new MidiError("A damaged variable-length value was found.");
  }
  throw new MidiError("The MIDI file ends unexpectedly.");
}

function parseTrack(view, start, length, trackIndex, tempoEvents, trackNames) {
  const end = start + length;
  const state = { offset: start };
  let tick = 0;
  let runningStatus = 0;
  let maxTick = 0;
  let ended = false;
  const rawNotes = [];
  const open = new Map();

  const keyFor = (channel, note) => `${channel}:${note}`;

  while (state.offset < end && !ended) {
    tick += readVarInt(view, state);
    if (tick > maxTick) maxTick = tick;
    if (state.offset >= end) break;

    let status = view.getUint8(state.offset);
    if (status < 0x80) {
      if (!runningStatus) throw new MidiError("The MIDI file has an invalid running-status event.");
      status = runningStatus;
    } else {
      state.offset += 1;
    }

    if (status === 0xff) {
      if (state.offset >= end) break;
      const type = view.getUint8(state.offset);
      state.offset += 1;
      const dataLength = readVarInt(view, state);
      const dataStart = state.offset;
      if (dataStart + dataLength > end) throw new MidiError("A MIDI meta-event is truncated.");

      if (type === 0x51 && dataLength === 3) {
        const microseconds = (view.getUint8(dataStart) << 16) | (view.getUint8(dataStart + 1) << 8) | view.getUint8(dataStart + 2);
        if (microseconds > 0) tempoEvents.push({ tick, microseconds });
      } else if (type === 0x03 && dataLength > 0) {
        const name = readAscii(view, dataStart, dataLength).replace(/\0/g, "").trim();
        if (name) trackNames.push({ track: trackIndex, name });
      } else if (type === 0x2f) {
        ended = true;
      }

      state.offset = dataStart + dataLength;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const dataLength = readVarInt(view, state);
      state.offset += dataLength;
      runningStatus = 0;
      continue;
    }

    if (status < 0x80 || status > 0xef) {
      throw new MidiError("The MIDI file contains an unknown event.");
    }

    runningStatus = status;
    const type = status & 0xf0;
    const channel = status & 0x0f;

    if (type === 0x80 || type === 0x90) {
      if (state.offset + 2 > end) throw new MidiError("A MIDI note event is truncated.");
      const note = view.getUint8(state.offset);
      const velocity = view.getUint8(state.offset + 1);
      state.offset += 2;

      if (channel === 9) continue;

      const isOn = type === 0x90 && velocity > 0;
      const key = keyFor(channel, note);
      if (isOn) {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ tick, velocity });
      } else {
        const stack = open.get(key);
        if (stack && stack.length) {
          const start = stack.shift();
          if (note >= 0 && note <= 127) {
            rawNotes.push({
              midi: note,
              startTick: start.tick,
              endTick: tick,
              velocity: start.velocity,
              track: trackIndex,
              channel,
            });
          }
        }
      }
    } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
      state.offset += 2;
    } else if (type === 0xc0 || type === 0xd0) {
      state.offset += 1;
    } else {
      throw new MidiError("The MIDI file contains an unsupported event.");
    }

    if (state.offset > end) throw new MidiError("An event runs past the end of a MIDI track.");
  }

  for (const [key, stack] of open) {
    const [channelText, noteText] = key.split(":");
    const channel = Number(channelText);
    const note = Number(noteText);
    if (channel === 9 || note < 0 || note > 127) continue;

    // A few exporters omit the final note-off. Keep those notes instead of
    // silently dropping them, ending them at the last event in the track.
    for (const start of stack) {
      rawNotes.push({
        midi: note,
        startTick: start.tick,
        endTick: Math.max(maxTick, start.tick + 1),
        velocity: start.velocity,
        track: trackIndex,
        channel,
        incomplete: true,
      });
    }
  }

  return rawNotes;
}

function makeClock(tempoEvents, division) {
  const sorted = [...tempoEvents].sort((a, b) => a.tick - b.tick);
  const segments = [{ tick: 0, time: 0, microseconds: DEFAULT_TEMPO }];

  for (const event of sorted) {
    if (event.tick < 0) continue;
    const last = segments[segments.length - 1];
    if (event.tick === last.tick) {
      last.microseconds = event.microseconds;
      continue;
    }
    const seconds = ((event.tick - last.tick) * last.microseconds) / (division * 1e6);
    segments.push({
      tick: event.tick,
      time: last.time + seconds,
      microseconds: event.microseconds,
    });
  }

  return function tickToSeconds(tick) {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (segments[mid].tick <= tick) low = mid;
      else high = mid - 1;
    }
    const segment = segments[low];
    return segment.time + ((tick - segment.tick) * segment.microseconds) / (division * 1e6);
  };
}

function buildRange(notes) {
  let min = 127;
  let max = 0;
  for (const note of notes) {
    if (note.midi < min) min = note.midi;
    if (note.midi > max) max = note.midi;
  }

  let start = Math.max(21, Math.floor(min / 12) * 12);
  let end = Math.min(108, Math.ceil((max + 1) / 12) * 12);
  if (end <= start) end = Math.min(108, start + 36);
  while (end - start < 36) {
    if (end + 12 <= 108) end += 12;
    else if (start - 12 >= 21) start -= 12;
    else break;
  }
  return [start, end];
}

export function friendlyTitle(filename) {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .slice(0, 80);
  if (!base) return "Imported MIDI";
  return base.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

export function parseMidi(arrayBuffer, filename = "song.mid") {
  if (!arrayBuffer || arrayBuffer.byteLength < 14) {
    throw new MidiError("That file is too small to be a MIDI file.");
  }

  const view = new DataView(arrayBuffer);
  if (readAscii(view, 0, 4) !== "MThd") {
    throw new MidiError("This is not a Standard MIDI File.");
  }

  const headerLength = view.getUint32(4);
  if (headerLength < 6 || headerLength + 8 > view.byteLength) {
    throw new MidiError("The MIDI header is damaged.");
  }

  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);

  if (format === 2) {
    throw new MidiError("Format 2 MIDI files are not supported. Export the song as format 0 or 1.");
  }
  if (format > 2 || division === 0) {
    throw new MidiError("The MIDI header contains an unsupported format.");
  }
  if (division & 0x8000) {
    throw new MidiError("SMPTE-timed MIDI files are not supported.");
  }

  let offset = 8 + headerLength;
  let parsedTracks = 0;
  const tempoEvents = [];
  const trackNames = [];
  const rawNotes = [];

  while (offset + 8 <= view.byteLength && parsedTracks < trackCount) {
    const id = readAscii(view, offset, 4);
    const length = view.getUint32(offset + 4);
    const dataStart = offset + 8;
    if (dataStart + length > view.byteLength) {
      throw new MidiError("A MIDI track chunk is truncated.");
    }

    if (id === "MTrk") {
      rawNotes.push(...parseTrack(view, dataStart, length, parsedTracks, tempoEvents, trackNames));
      parsedTracks += 1;
    }

    offset = dataStart + length;
  }

  if (!rawNotes.length) {
    throw new MidiError("No notes were found in that MIDI file.");
  }

  // Format-1 exports often carry the same musical line in more than one
  // track. Those copies are visually redundant and make the piano sound
  // doubled, so merge notes that start on the same tick with the same pitch.
  const uniqueNotes = [];
  const byStart = new Map();
  for (const note of rawNotes) {
    const key = `${note.midi}:${note.startTick}`;
    const existing = byStart.get(key);
    if (!existing) {
      byStart.set(key, note);
      uniqueNotes.push(note);
      continue;
    }

    if (note.endTick > existing.endTick) existing.endTick = note.endTick;
    existing.velocity = Math.max(existing.velocity, note.velocity);
  }

  if (uniqueNotes.length > MAX_NOTES) {
    throw new MidiError(`That MIDI file has ${rawNotes.length.toLocaleString()} notes. The limit is ${MAX_NOTES.toLocaleString()}.`);
  }

  const tickToSeconds = makeClock(tempoEvents, division);
  const leadIn = LEAD_IN_SECONDS;
  const notes = uniqueNotes.map((note, index) => {
    const start = tickToSeconds(note.startTick) + leadIn;
    const length = Math.max(0.06, tickToSeconds(note.endTick) - tickToSeconds(note.startTick));
    return {
      midi: note.midi,
      name: null,
      time: Math.round(start * 1000) / 1000,
      duration: Math.round(length * 1000) / 1000,
      velocity: Math.max(0.18, Math.min(1, 0.22 + (note.velocity / 127) * 0.78)),
      hand: note.midi < 60 ? "L" : "R",
      id: `midi-${index}`,
      end: 0,
    };
  });

  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  for (const note of notes) note.end = note.time + note.duration;

  const duration = Math.max(4, notes[notes.length - 1].end + 1.8);
  const range = buildRange(notes);
  const title = friendlyTitle(filename);
  const firstTempo = tempoEvents.length ? tempoEvents[0].microseconds : DEFAULT_TEMPO;

  return {
    id: `midi-${Date.now()}`,
    title,
    subtitle: `Imported MIDI · ${notes.length.toLocaleString()} notes`,
    bpm: Math.round(60000000 / firstTempo),
    notes,
    duration,
    range,
    imported: true,
    sourceName: filename,
  };
}
