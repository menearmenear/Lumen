/* Built-in arrangements for Lumen Piano. */

const PITCH_CLASSES = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiFromName(name) {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!match) throw new Error(`Unknown note: ${name}`);
  const pc = PITCH_CLASSES[`${match[1]}${match[2]}`];
  return (Number(match[3]) + 1) * 12 + pc;
}

export function noteName(midi, withOctave = true) {
  const pc = NAMES[((midi % 12) + 12) % 12];
  if (!withOctave) return pc;
  return `${pc}${Math.floor(midi / 12) - 1}`;
}

function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function scoreBuilder(bpm, leadIn = 1.4, beatsPerBar = 4) {
  const secondsPerBeat = 60 / bpm;
  const notes = [];

  function add(note, beat, length, velocity = 0.65, hand = null) {
    const midi = typeof note === "number" ? note : midiFromName(note);
    const time = leadIn + beat * secondsPerBeat;
    notes.push({
      midi,
      name: noteName(midi),
      time: round(Math.max(0, time)),
      duration: round(Math.max(0.06, length * secondsPerBeat)),
      velocity: Math.max(0.05, Math.min(1, velocity)),
      hand: hand || (midi < 60 ? "L" : "R"),
    });
  }

  function chord(names, beat, length, velocity = 0.35, hand = "R") {
    for (const name of names) add(name, beat, length, velocity, hand);
  }

  return { notes, add, chord, bars: beatsPerBar, secondsPerBeat };
}

function finish(builder, meta, range) {
  builder.notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return { ...meta, bpm: meta.bpm, notes: builder.notes, range };
}

/* ---------------------------------------------------------
   Rêverie — an original 12-bar miniature in A minor.
   --------------------------------------------------------- */
function buildReverie() {
  const b = scoreBuilder(70, 1.7, 4);
  const bar = 4;
  const chords = [
    ["A2", "E3", "A3", "C4"],
    ["F2", "C3", "F3", "A3"],
    ["C3", "G3", "C4", "E4"],
    ["G2", "D3", "G3", "B3"],
    ["A2", "E3", "A3", "C4"],
    ["F2", "C3", "F3", "A3"],
    ["D3", "A3", "D4", "F4"],
    ["E2", "B2", "E3", "G#3"],
    ["F2", "C3", "F3", "A3"],
    ["C3", "G3", "C4", "E4"],
    ["G2", "D3", "G3", "B3"],
    ["A2", "E3", "A3", "C4"],
  ];

  const melody = [
    [["E5", 0, 1.25, 0.72], ["C5", 1.5, 0.75, 0.62], ["B4", 2.25, 0.75, 0.58], ["A4", 3, 0.9, 0.56]],
    [["A5", 0, 1.25, 0.74], ["G5", 1.5, 0.75, 0.64], ["F5", 2.25, 0.9, 0.6], ["E5", 3.25, 0.6, 0.56]],
    [["G5", 0, 1.1, 0.72], ["E5", 1.5, 0.75, 0.62], ["D5", 2.25, 0.75, 0.6], ["C5", 3, 1.25, 0.56]],
    [["D5", 0, 0.9, 0.64], ["B4", 1, 0.9, 0.58], ["G4", 2, 1.2, 0.54], ["A4", 3.25, 0.6, 0.5]],
    [["C5", 0, 0.9, 0.6], ["E5", 1, 1.1, 0.68], ["D5", 2.25, 0.6, 0.55], ["C5", 3, 0.9, 0.56], ["B4", 3.75, 0.5, 0.5]],
    [["A4", 0, 1.35, 0.56], ["C5", 1.5, 0.9, 0.58], ["F5", 2.5, 1.2, 0.7], ["E5", 3.75, 0.5, 0.56]],
    [["D5", 0, 1.3, 0.64], ["F5", 1.5, 0.9, 0.68], ["A5", 2.5, 1.25, 0.76], ["G5", 3.75, 0.5, 0.65]],
    [["E5", 0, 1.25, 0.68], ["G#5", 1.5, 0.9, 0.72], ["B5", 2.5, 1.6, 0.8]],
    [["A5", 0, 1.1, 0.74], ["G5", 1.25, 0.7, 0.66], ["F5", 2, 1.1, 0.62], ["E5", 3.25, 0.75, 0.58]],
    [["E5", 0, 1.2, 0.64], ["D5", 1.25, 0.8, 0.6], ["C5", 2.25, 1, 0.58], ["G4", 3.25, 0.75, 0.52]],
    [["B4", 0, 1, 0.58], ["D5", 1.25, 0.9, 0.62], ["G5", 2.25, 1.7, 0.72]],
    [["A5", 0, 1.65, 0.74], ["E5", 1.75, 0.9, 0.6], ["C5", 2.75, 1.3, 0.55]],
  ];

  const arpOffsets = [0, 1.5, 2.5, 3.25];
  const arpLengths = [1.8, 1, 1, 0.65];

  for (let i = 0; i < 11; i += 1) {
    const start = i * bar;
    chords[i].forEach((note, index) => {
      b.add(note, start + arpOffsets[index], arpLengths[index], index === 0 ? 0.5 : 0.38, "L");
    });
    melody[i].forEach(([note, beat, length, velocity]) => {
      b.add(note, start + beat, length, velocity, "R");
    });
  }

  // Final bar: let the harmony settle instead of repeating the arpeggio.
  const finalStart = 11 * bar;
  b.add("A2", finalStart, 3.9, 0.5, "L");
  b.add("E3", finalStart + 0.75, 3.1, 0.4, "L");
  b.add("A3", finalStart + 1.5, 2.4, 0.37, "L");
  b.add("C4", finalStart + 2.25, 1.7, 0.34, "L");
  b.add("E4", finalStart + 3, 1, 0.3, "L");
  melody[11].forEach(([note, beat, length, velocity]) => {
    b.add(note, finalStart + beat, length, velocity, "R");
  });

  return finish(
    b,
    {
      id: "reverie",
      title: "Rêverie",
      subtitle: "Original · Lumen Sessions",
      bpm: 70,
      description: "A quiet A-minor daydream",
    },
    [36, 96],
  );
}

/* ---------------------------------------------------------
   Für Elise — Beethoven, public-domain theme, simple arrangement.
   --------------------------------------------------------- */
function buildFurElise() {
  const b = scoreBuilder(100, 1.4, 3);
  const bar = 3;

  const theme = [
    ["E5", 0, 0.25, 0.7],
    ["D#5", 0.25, 0.25, 0.66],
    ["E5", 0.5, 0.25, 0.7],
    ["D#5", 0.75, 0.25, 0.66],
    ["E5", 1, 0.5, 0.72],
    ["B4", 1.5, 0.5, 0.64],
    ["D5", 2, 0.5, 0.68],
    ["C5", 2.5, 0.5, 0.64],
  ];

  const response = [
    ["A4", 0, 1, 0.66],
    ["C4", 1, 0.5, 0.5],
    ["E4", 1.5, 0.5, 0.53],
    ["A4", 2, 0.5, 0.58],
    ["B4", 2.5, 0.5, 0.56],
  ];

  const answer = [
    ["E4", 0, 0.5, 0.52],
    ["G#4", 0.5, 0.5, 0.54],
    ["B4", 1, 0.5, 0.58],
    ["C5", 1.5, 0.5, 0.62],
    ["E4", 2, 1, 0.55],
  ];

  const cadence = [
    ["E4", 0, 0.5, 0.52],
    ["C5", 0.5, 0.5, 0.62],
    ["B4", 1, 0.5, 0.57],
    ["A4", 1.5, 1.5, 0.63],
  ];

  const phrases = [theme, response, answer, theme, response, cadence, theme, response, answer, theme, response, cadence];

  phrases.forEach((phrase, index) => {
    const start = index * bar;
    phrase.forEach(([note, beat, length, velocity]) => {
      b.add(note, start + beat, length, velocity, "R");
    });
  });

  for (const i of [1, 4, 7, 10, 5, 11]) {
    const start = i * bar;
    b.add("A2", start, 2.6, 0.45, "L");
    b.add("E3", start + 1, 1.4, 0.36, "L");
    b.add("A3", start + 2, 0.85, 0.33, "L");
  }

  for (const i of [2, 8]) {
    const start = i * bar;
    b.add("E2", start, 2.6, 0.45, "L");
    b.add("B2", start + 1, 1.4, 0.36, "L");
    b.add("E3", start + 2, 0.85, 0.33, "L");
  }

  // A final sustained A-minor chord.
  const finalStart = 12 * bar;
  b.add("A4", finalStart, 2.8, 0.56, "R");
  b.add("C5", finalStart + 0.2, 2.6, 0.45, "R");
  b.add("E5", finalStart + 0.4, 2.4, 0.4, "R");
  b.add("A2", finalStart, 2.8, 0.46, "L");
  b.add("E3", finalStart + 0.15, 2.6, 0.36, "L");
  b.add("A3", finalStart + 0.3, 2.4, 0.33, "L");

  return finish(
    b,
    {
      id: "fur-elise",
      title: "Für Elise",
      subtitle: "Ludwig van Beethoven · Public domain",
      bpm: 100,
      description: "The familiar A-minor bagatelle",
    },
    [36, 96],
  );
}

/* ---------------------------------------------------------
   Gymnopédie — a slow waltz after Erik Satie.
   --------------------------------------------------------- */
function buildGymnopedie() {
  const b = scoreBuilder(58, 1.8, 3);
  const bar = 3;

  const progression = [
    { root: "G2", chord: ["B3", "D4", "F#4"] },
    { root: "D2", chord: ["A3", "C#4", "F#4"] },
    { root: "G2", chord: ["B3", "D4", "F#4"] },
    { root: "D2", chord: ["A3", "C#4", "F#4"] },
    { root: "G2", chord: ["B3", "D4", "G4"] },
    { root: "B2", chord: ["D4", "F#4", "B4"] },
    { root: "E2", chord: ["G3", "B3", "E4"] },
    { root: "A2", chord: ["C#4", "E4", "G4"] },
    { root: "D2", chord: ["A3", "D4", "F#4"] },
    { root: "G2", chord: ["B3", "D4", "G4"] },
  ];

  const melody = [
    [["F#5", 0, 1.4, 0.65], ["A5", 1.5, 0.7, 0.56], ["G5", 2.2, 0.8, 0.54]],
    [["F#5", 0, 1.2, 0.62], ["E5", 1.25, 0.8, 0.54], ["D5", 2.05, 1, 0.56]],
    [["B4", 0, 1.2, 0.52], ["D5", 1.2, 0.8, 0.55], ["E5", 2, 0.9, 0.6]],
    [["F#5", 0, 1.4, 0.64], ["A5", 1.4, 0.8, 0.56], ["G5", 2.2, 0.8, 0.54]],
    [["F#5", 0, 1.2, 0.62], ["E5", 1.2, 0.9, 0.55], ["D5", 2.1, 1, 0.53]],
    [["B4", 0, 1.2, 0.54], ["D5", 1.2, 0.8, 0.55], ["F#5", 2.1, 1, 0.6]],
    [["E5", 0, 1.3, 0.58], ["G5", 1.3, 0.8, 0.55], ["F#5", 2.1, 0.9, 0.54]],
    [["E5", 0, 1.2, 0.57], ["D5", 1.2, 0.8, 0.53], ["C#5", 2.05, 1.2, 0.52]],
    [["D5", 0, 1.4, 0.55], ["F#5", 1.4, 0.8, 0.6], ["E5", 2.2, 0.8, 0.55]],
    [["D5", 0, 2.8, 0.56]],
  ];

  progression.forEach((entry, index) => {
    const start = index * bar;
    b.add(entry.root, start, 2.85, 0.42, "L");

    // The soft chord on beats two and three, like a lazy waltz.
    if (index < progression.length - 1) {
      b.chord(entry.chord, start + 1, 0.82, 0.26, "R");
      b.chord(entry.chord, start + 2, 0.82, 0.23, "R");
    } else {
      b.chord(entry.chord, start + 1, 1.75, 0.24, "R");
    }

    melody[index].forEach(([note, beat, length, velocity]) => {
      b.add(note, start + beat, length, velocity, "R");
    });
  });

  return finish(
    b,
    {
      id: "gymnopedie",
      title: "Gymnopédie",
      subtitle: "After Erik Satie · Public domain",
      bpm: 58,
      description: "Slow waltz, soft edges",
    },
    [36, 96],
  );
}

export const BUILT_IN_SONGS = [buildReverie(), buildFurElise(), buildGymnopedie()];

export function materializeSong(song) {
  let end = 0;
  let maxDuration = 1;
  const unique = [];
  const byStart = new Map();

  for (const note of song.notes) {
    const key = `${note.midi}:${note.time}`;
    const existing = byStart.get(key);
    if (!existing) {
      const copy = { ...note };
      byStart.set(key, copy);
      unique.push(copy);
    } else if (note.duration > existing.duration) {
      existing.duration = note.duration;
      existing.velocity = Math.max(existing.velocity, note.velocity);
    }
  }

  const notes = unique.map((note, index) => {
    const copy = {
      ...note,
      name: note.name || noteName(note.midi),
      id: `${song.id}-${index}`,
      end: note.time + note.duration,
    };
    if (copy.end > end) end = copy.end;
    if (copy.duration > maxDuration) maxDuration = copy.duration;
    return copy;
  });

  return {
    ...song,
    notes,
    duration: Math.max(4, end + 1.8),
    maxDuration,
    range: song.range ? [...song.range] : null,
  };
}

export const DEFAULT_SONG_ID = "reverie";
