import {
  BUILT_IN_SONGS,
  DEFAULT_SONG_ID,
  materializeSong,
  noteName,
} from "./songs.js";
import { parseMidi } from "./midi.js";
import { PianoEngine } from "./audio.js";
import { FallingNotes } from "./visualizer.js";
import { GuideHands } from "./hands.js";

const SETTINGS_KEY = "lumen.settings.v1";
const DEFAULT_RANGE = [36, 96];
const MAX_MIDI_FILE_BYTES = 10 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  theme: "aurora",
  speed: 1,
  glow: 0.75,
  volume: 0.78,
  mute: false,
  tiles: true,
  particles: true,
  hands: true,
  keyHints: true,
  noteNames: true,
  ambient: true,
  loop: false,
  training: false,
};

// Three chromatic octaves, laid out like a computer keyboard:
// white keys use Q…P and Z…/ while black keys use 2…0 and S…'.
const KEY_MAP = [
  { code: "KeyQ", offset: 0, label: "q" },
  { code: "Digit2", offset: 1, label: "2" },
  { code: "KeyW", offset: 2, label: "w" },
  { code: "Digit3", offset: 3, label: "3" },
  { code: "KeyE", offset: 4, label: "e" },
  { code: "KeyR", offset: 5, label: "r" },
  { code: "Digit5", offset: 6, label: "5" },
  { code: "KeyT", offset: 7, label: "t" },
  { code: "Digit6", offset: 8, label: "6" },
  { code: "KeyY", offset: 9, label: "y" },
  { code: "Digit7", offset: 10, label: "7" },
  { code: "KeyU", offset: 11, label: "u" },
  { code: "KeyI", offset: 12, label: "i" },
  { code: "Digit9", offset: 13, label: "9" },
  { code: "KeyO", offset: 14, label: "o" },
  { code: "Digit0", offset: 15, label: "0" },
  { code: "KeyP", offset: 16, label: "p" },
  { code: "KeyZ", offset: 17, label: "z" },
  { code: "KeyS", offset: 18, label: "s" },
  { code: "KeyX", offset: 19, label: "x" },
  { code: "KeyD", offset: 20, label: "d" },
  { code: "KeyC", offset: 21, label: "c" },
  { code: "KeyF", offset: 22, label: "f" },
  { code: "KeyV", offset: 23, label: "v" },
  { code: "KeyB", offset: 24, label: "b" },
  { code: "KeyH", offset: 25, label: "h" },
  { code: "KeyN", offset: 26, label: "n" },
  { code: "KeyJ", offset: 27, label: "j" },
  { code: "KeyM", offset: 28, label: "m" },
  { code: "Comma", offset: 29, label: "," },
  { code: "KeyL", offset: 30, label: "l" },
  { code: "Period", offset: 31, label: "." },
  { code: "Semicolon", offset: 32, label: ";" },
  { code: "Slash", offset: 33, label: "/" },
  { code: "Quote", offset: 34, label: "'" },
];

const KEY_SPAN = KEY_MAP[KEY_MAP.length - 1].offset;
const CODE_TO_ENTRY = new Map(KEY_MAP.map((entry) => [entry.code, entry]));
const THEMES = new Set(["aurora", "ember", "tide", "mono"]);

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"),
  stage: $("stage"),
  canvas: $("visualizer"),
  keyboard: $("keyboard"),
  handsLayer: $("handsLayer"),
  songTitle: $("songTitle"),
  songSubtitle: $("songSubtitle"),
  noteCount: $("noteCount"),
  rangeReadout: $("rangeReadout"),
  statusLabel: $("statusLabel"),
  stageInvite: $("stageInvite"),
  playBtn: $("playBtn"),
  trainingBtn: $("trainingBtn"),
  songSelect: $("songSelect"),
  timeline: $("timeline"),
  currentTime: $("currentTime"),
  totalTime: $("totalTime"),
  loopBtn: $("loopBtn"),
  sustainBtn: $("sustainBtn"),
  muteBtn: $("muteBtn"),
  volumeRange: $("volumeRange"),
  volumeRangeSettings: $("volumeRangeSettings"),
  volumeOutput: $("volumeOutput"),
  octaveDown: $("octaveDown"),
  octaveUp: $("octaveUp"),
  octaveLabel: $("octaveLabel"),
  loadMidiBtn: $("loadMidiBtn"),
  midiFileInput: $("midiFileInput"),
  settingsBtn: $("settingsBtn"),
  settingsPanel: $("settingsPanel"),
  closeSettingsBtn: $("closeSettingsBtn"),
  drawerBackdrop: $("drawerBackdrop"),
  themeGrid: $("themeGrid"),
  speedRange: $("speedRange"),
  speedOutput: $("speedOutput"),
  glowRange: $("glowRange"),
  glowOutput: $("glowOutput"),
  toggleTiles: $("toggleTiles"),
  toggleParticles: $("toggleParticles"),
  toggleHands: $("toggleHands"),
  toggleKeyHints: $("toggleKeyHints"),
  toggleNoteNames: $("toggleNoteNames"),
  toggleAmbient: $("toggleAmbient"),
  resetSettingsBtn: $("resetSettingsBtn"),
  fullscreenBtn: $("fullscreenBtn"),
  dropzone: $("dropzone"),
  toast: $("toast"),
};

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const settings = loadSettings();
const engine = new PianoEngine();
const visualizer = new FallingNotes(el.canvas, el.stage);
const hands = new GuideHands(el.handsLayer);

const state = {
  songs: new Map(BUILT_IN_SONGS.map((song) => [song.id, song])),
  currentSong: null,
  songTime: 0,
  playing: false,
  octaveBase: 48,
  octaveCandidates: [],
  keyElements: new Map(),
  keyHints: new Map(),
  activeKeys: new Set(),
  lastTimelineValue: -1,
  sustainLocked: false,
  sustainHeld: false,
  sustainedVoices: new Set(),
  liveSources: new Map(),
  pointers: new Map(),
  userHasInteracted: false,
  lastStatus: "",
  lastCurrentTimeText: "",
  lastTotalTimeText: "",
  saveTimer: null,
  toastTimer: null,
  backdropTimer: null,
  layoutQueued: false,
  lastFrame: performance.now(),
  lastFocused: null,
};

let clock = null;
let schedulerCursor = 0;
let audioFailed = false;

/* ---------- Settings ---------- */

function loadSettings() {
  let saved = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = {};
  }

  const result = { ...DEFAULT_SETTINGS, ...saved };
  if (!THEMES.has(result.theme)) result.theme = DEFAULT_SETTINGS.theme;
  for (const key of ["speed", "glow", "volume"]) {
    const value = Number(result[key]);
    result[key] = Number.isFinite(value) ? Math.max(0, Math.min(key === "speed" ? 1.7 : 1, value)) : DEFAULT_SETTINGS[key];
  }
  result.speed = Math.max(0.5, result.speed);
  for (const key of ["mute", "tiles", "particles", "hands", "keyHints", "noteNames", "ambient", "loop", "training"]) {
    result[key] = Boolean(result[key]);
  }

  if (!Object.keys(saved).length && prefersReducedMotion) {
    result.particles = false;
    result.ambient = false;
  }

  return result;
}

function saveSettingsSoon() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // localStorage can be unavailable in privacy-restricted contexts.
    }
  }, 120);
}

function readPalette() {
  const styles = getComputedStyle(document.body);
  const read = (name) => styles.getPropertyValue(name).trim();
  return {
    left: read("--note-left") || "#ff7fc5",
    leftB: read("--note-left-b") || "#ffac72",
    right: read("--note-right") || "#70e9ff",
    rightB: read("--note-right-b") || "#8f9dff",
    accent: read("--accent") || "#7ee7ff",
    accent2: read("--accent-2") || "#b695ff",
    grid: read("--muted") || "#99a5bd",
  };
}

function applyTheme(theme) {
  if (!THEMES.has(theme)) theme = "aurora";
  document.body.dataset.theme = theme;
  const palette = readPalette();
  visualizer.setPalette(palette);
  hands.setPalette(palette);
  for (const button of el.themeGrid.querySelectorAll("[data-theme-choice]")) {
    const selected = button.dataset.themeChoice === theme;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function syncControls() {
  el.speedRange.value = String(Math.round(settings.speed * 100));
  el.speedOutput.textContent = `${settings.speed.toFixed(2).replace(/0$/, "").replace(/\.$/, "")}×`;
  el.glowRange.value = String(Math.round(settings.glow * 100));
  el.glowOutput.textContent = `${Math.round(settings.glow * 100)}%`;

  const volume = Math.round(settings.volume * 100);
  el.volumeRange.value = String(volume);
  el.volumeRangeSettings.value = String(volume);
  el.volumeOutput.textContent = `${volume}%`;

  el.toggleTiles.checked = settings.tiles;
  el.toggleParticles.checked = settings.particles;
  el.toggleHands.checked = settings.hands;
  el.toggleKeyHints.checked = settings.keyHints;
  el.toggleNoteNames.checked = settings.noteNames;
  el.toggleAmbient.checked = settings.ambient;

  el.loopBtn.classList.toggle("is-active", settings.loop);
  el.loopBtn.setAttribute("aria-pressed", String(settings.loop));

  el.trainingBtn.classList.toggle("is-active", settings.training);
  el.trainingBtn.setAttribute("aria-pressed", String(settings.training));
  el.trainingBtn.setAttribute(
    "aria-label",
    settings.training
      ? "Training mode is on. Play along without the song audio."
      : "Training mode is off. Turn it on to play along without the song audio.",
  );

  document.body.classList.toggle("is-muted", settings.mute);
  document.body.classList.toggle("is-training", settings.training);
  document.body.classList.toggle("hide-key-hints", !settings.keyHints);
  document.body.classList.toggle("hide-note-names", !settings.noteNames);
  document.body.classList.toggle("ambient-off", !settings.ambient);
  el.muteBtn.setAttribute("aria-pressed", String(settings.mute));
  el.muteBtn.setAttribute("aria-label", settings.mute ? "Unmute" : "Mute");
}

function applySettings() {
  if (document.body.dataset.theme !== settings.theme) applyTheme(settings.theme);

  visualizer.setOptions({
    speed: settings.speed,
    glow: settings.glow,
    showTiles: settings.tiles,
    particles: settings.particles,
    noteNames: settings.noteNames,
  });

  hands.setEnabled(settings.hands);
  engine.setVolume(settings.volume);
  engine.setMuted(settings.mute);
  syncControls();
  saveSettingsSoon();
}

function setTraining(enabled, { announce = false } = {}) {
  const next = Boolean(enabled);
  if (next === settings.training) return;
  settings.training = next;

  if (next) {
    engine.stopTag("demo", 0.08);
    // Stop the song's hands and key highlights immediately. From here on the
    // keyboard and guide hands only react to what the player actually presses.
    hands.reset();
    updateKeyboardState([]);
  } else if (state.playing && state.currentSong) {
    schedulerCursor = lowerBound(state.currentSong.notes, getSongTime());
    scheduleDemo();
  }

  syncControls();
  saveSettingsSoon();
  updateStatus();

  if (announce) {
    showToast(
      next
        ? "Training on — the song stays silent. Play the falling notes yourself."
        : "Training off — the song will play its own part again.",
      { duration: 3600 },
    );
  }
}

function updateSustainUI() {
  const active = state.sustainLocked || state.sustainHeld;
  el.sustainBtn.classList.toggle("is-active", active);
  el.sustainBtn.setAttribute("aria-pressed", String(active));
}

/* ---------- Small helpers ---------- */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds + 0.0001);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function lowerBound(array, target) {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (array[mid].time < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.("input, select, textarea, button, a, [contenteditable='true']"));
}

function showToast(message, { error = false, duration = 2800 } = {}) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle("is-error", error);
  el.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => el.toast.classList.remove("is-visible"), duration);
}

function primeAudio() {
  if (audioFailed) return;
  engine.unlock().catch((error) => {
    audioFailed = true;
    showToast(error.message || "Audio could not start in this browser.", { error: true });
  });
}

/* ---------- Keyboard rendering ---------- */

function nearestCandidate(candidates, desired) {
  let best = candidates[0];
  let distance = Infinity;
  for (const candidate of candidates) {
    const nextDistance = Math.abs(candidate - desired);
    if (nextDistance < distance) {
      best = candidate;
      distance = nextDistance;
    }
  }
  return best;
}

function buildKeyboard(range) {
  const start = Number(range?.[0] ?? DEFAULT_RANGE[0]);
  const end = Number(range?.[1] ?? DEFAULT_RANGE[1]);
  const safeStart = clamp(start, 21, 108);
  const safeEnd = clamp(end, safeStart, 108);

  const candidates = [];
  for (let candidate = Math.ceil(safeStart / 12) * 12; candidate + KEY_SPAN <= safeEnd; candidate += 12) {
    if (candidate >= safeStart) candidates.push(candidate);
  }
  if (!candidates.length) candidates.push(clamp(Math.ceil(safeStart / 12) * 12, safeStart, safeEnd));
  state.octaveCandidates = candidates;
  state.octaveBase = nearestCandidate(candidates, state.octaveBase || 48);

  el.keyboard.replaceChildren();
  state.keyElements.clear();
  state.keyHints.clear();

  let whiteCount = 0;
  for (let midi = safeStart; midi <= safeEnd; midi += 1) {
    if (!isBlackKey(midi)) whiteCount += 1;
  }

  const blackKeys = [];
  let whitesSeen = 0;

  for (let midi = safeStart; midi <= safeEnd; midi += 1) {
    const black = isBlackKey(midi);
    if (black) {
      blackKeys.push({ midi, whitesBefore: whitesSeen });
      continue;
    }

    const key = document.createElement("div");
    key.className = "piano-key piano-key--white";
    key.dataset.midi = String(midi);
    key.setAttribute("role", "button");
    key.setAttribute("tabindex", "-1");
    key.setAttribute("aria-label", `${noteName(midi)} piano key`);
    if (midi % 12 === 0) {
      const label = document.createElement("span");
      label.className = "key__name";
      label.textContent = noteName(midi);
      key.append(label);
    }
    el.keyboard.append(key);
    state.keyElements.set(midi, key);
    whitesSeen += 1;
  }

  const blackWidth = (0.62 / whiteCount) * 100;
  for (const entry of blackKeys) {
    const key = document.createElement("div");
    key.className = "piano-key piano-key--black";
    key.dataset.midi = String(entry.midi);
    key.setAttribute("role", "button");
    key.setAttribute("tabindex", "-1");
    key.setAttribute("aria-label", `${noteName(entry.midi)} piano key`);
    key.style.width = `${blackWidth}%`;
    key.style.left = `${(entry.whitesBefore / whiteCount) * 100 - blackWidth / 2}%`;
    el.keyboard.append(key);
    state.keyElements.set(entry.midi, key);
  }

  updateKeyHints();
  updateOctaveControls();
  state.activeKeys.clear();
  queueLayout();
  requestAnimationFrame(measureLayout);
}

function updateKeyHints() {
  for (const key of state.keyElements.values()) {
    key.querySelectorAll(".key__hint").forEach((hint) => hint.remove());
  }
  state.keyHints.clear();

  for (const entry of KEY_MAP) {
    const midi = state.octaveBase + entry.offset;
    const key = state.keyElements.get(midi);
    if (!key) continue;
    const hint = document.createElement("span");
    hint.className = "key__hint";
    hint.textContent = entry.label;
    key.append(hint);
    state.keyHints.set(midi, hint);
  }
}

function updateOctaveControls() {
  const index = state.octaveCandidates.indexOf(state.octaveBase);
  el.octaveLabel.textContent = Number.isFinite(state.octaveBase) ? noteName(state.octaveBase) : "—";
  el.octaveDown.disabled = index <= 0;
  el.octaveUp.disabled = index < 0 || index >= state.octaveCandidates.length - 1;
}

function stepOctave(direction) {
  const index = state.octaveCandidates.indexOf(state.octaveBase);
  const next = index + direction;
  if (next < 0 || next >= state.octaveCandidates.length) return;
  state.octaveBase = state.octaveCandidates[next];
  panicLive();
  updateKeyHints();
  updateOctaveControls();
}

function queueLayout() {
  if (state.layoutQueued) return;
  state.layoutQueued = true;
  requestAnimationFrame(() => {
    state.layoutQueued = false;
    measureLayout();
  });
}

function measureLayout() {
  visualizer.resize();
  const stageRect = el.stage.getBoundingClientRect();
  const handsRect = el.handsLayer.getBoundingClientRect();
  const canvasKeys = [];
  const handKeys = [];

  for (const [midi, key] of state.keyElements) {
    const rect = key.getBoundingClientRect();
    if (!rect.width) continue;
    const meta = {
      midi,
      width: rect.width,
      isBlack: key.classList.contains("piano-key--black"),
    };
    canvasKeys.push({
      ...meta,
      x: rect.left + rect.width / 2 - stageRect.left,
    });
    handKeys.push({
      ...meta,
      x: rect.left + rect.width / 2 - handsRect.left,
    });
  }

  visualizer.setKeyGeometry(canvasKeys);
  hands.setKeyGeometry(handKeys);
}

/* ---------- Song loading and header UI ---------- */

function populateSongSelect() {
  const current = state.currentSong?.id || el.songSelect.value;
  el.songSelect.replaceChildren();
  for (const song of state.songs.values()) {
    const option = document.createElement("option");
    option.value = song.id;
    option.textContent = song.title;
    el.songSelect.append(option);
  }
  if (current) el.songSelect.value = current;
}

function updateStatus() {
  let text = "Ready when you are";
  const duration = state.currentSong?.duration || 0;
  if (state.playing) text = settings.training ? "Training · play along" : "Now playing";
  else if (state.currentSong && duration > 0 && state.songTime >= duration - 0.03) text = "Finished";
  else if (state.currentSong && state.songTime > 0.01) text = settings.training ? "Training · paused" : "Paused";
  else if (settings.training) text = "Training mode · press Play";
  if (text !== state.lastStatus) {
    el.statusLabel.textContent = text;
    state.lastStatus = text;
  }
}

function updatePlayUI() {
  el.app.classList.toggle("is-playing", state.playing);
  el.stage.classList.toggle("is-playing", state.playing);
  el.playBtn.setAttribute("aria-label", state.playing ? "Pause song" : "Play song");
  if (state.playing || state.userHasInteracted) {
    el.stageInvite.classList.add("is-hidden");
  } else {
    el.stageInvite.classList.remove("is-hidden");
  }
  updateStatus();
}

function updateTimelineUI(force = false) {
  if (!state.currentSong) return;
  const duration = state.currentSong.duration || 0;
  const progress = duration > 0 ? clamp(state.songTime / duration, 0, 1) : 0;
  const value = Math.round(progress * 1000);
  if (force || value !== state.lastTimelineValue) {
    el.timeline.value = String(value);
    state.lastTimelineValue = value;
  }

  const currentText = formatTime(state.songTime);
  const totalText = formatTime(duration);
  const currentChanged = force || currentText !== state.lastCurrentTimeText;
  const totalChanged = force || totalText !== state.lastTotalTimeText;

  if (currentChanged) {
    el.currentTime.textContent = currentText;
    state.lastCurrentTimeText = currentText;
  }

  if (totalChanged) {
    el.totalTime.textContent = totalText;
    state.lastTotalTimeText = totalText;
  }

  if (currentChanged || totalChanged) {
    el.timeline.setAttribute("aria-valuetext", `${currentText} of ${totalText}`);
  }
}

function loadSong(source) {
  if (!source) return;

  if (state.playing) pausePlayback();
  panicLive();
  engine.stopTag("demo", 0.03);

  const song = materializeSong(source);
  state.currentSong = song;
  state.songTime = 0;
  state.playing = false;
  clock = null;

  visualizer.setSong(song);
  visualizer.onSeek(0);
  hands.reset();
  buildKeyboard(song.range || DEFAULT_RANGE);

  el.songTitle.textContent = song.title;
  el.songSubtitle.textContent = song.subtitle;
  el.noteCount.textContent = song.notes.length.toLocaleString();
  el.rangeReadout.textContent = song.range
    ? `${noteName(song.range[0])}–${noteName(song.range[1])}`
    : "—";

  populateSongSelect();
  el.songSelect.value = song.id;
  state.lastCurrentTimeText = "";
  state.lastTotalTimeText = "";
  state.lastTimelineValue = -1;
  state.lastStatus = "";
  updateTimelineUI(true);

  if (!state.userHasInteracted) el.stageInvite.classList.remove("is-hidden");
  else el.stageInvite.classList.add("is-hidden");

  updatePlayUI();
  measureLayout();
  queueLayout();
}

/* ---------- Playback clock and transport ---------- */

let startingPlayback = false;

function makeClock(songTime, lead = 0.055) {
  const audioReady = engine.ctx?.state === "running";
  return {
    mode: audioReady ? "audio" : "perf",
    song: songTime,
    ctxStart: audioReady ? engine.ctx.currentTime + lead : 0,
    perfStart: performance.now() + lead * 1000,
  };
}

function getSongTime() {
  if (!state.playing || !clock) return state.songTime;
  if (clock.mode === "audio" && engine.ctx) {
    return clock.song + Math.max(0, engine.ctx.currentTime - clock.ctxStart);
  }
  return clock.song + Math.max(0, (performance.now() - clock.perfStart) / 1000);
}

async function startPlayback() {
  if (!state.currentSong || state.playing || startingPlayback) return;
  startingPlayback = true;
  markInteracted();
  const selectedSong = state.currentSong;

  if (state.songTime >= selectedSong.duration - 0.03) {
    state.songTime = 0;
    visualizer.onSeek(0);
    hands.reset();
  }

  try {
    await engine.unlock();
    // The sample bank is decoded in the background as soon as the page loads.
    // Give it a short grace period, but never make Play feel sluggish if a slow
    // device is still preparing the bank; later notes pick up the samples.
    if (engine.samplesReady) {
      await Promise.race([
        engine.samplesReady,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  } catch (error) {
    audioFailed = true;
    showToast(error.message || "Audio could not start. The visualizer will still play.", { error: true });
  }

  if (!state.currentSong || state.currentSong !== selectedSong) {
    startingPlayback = false;
    return;
  }

  state.playing = true;
  clock = makeClock(state.songTime, 0.055);
  schedulerCursor = lowerBound(state.currentSong.notes, state.songTime - 0.015);
  updatePlayUI();
  updateTimelineUI(true);
  scheduleDemo();
  startingPlayback = false;
}

function pausePlayback() {
  if (!state.playing) return;
  const time = getSongTime();
  state.songTime = clamp(time, 0, state.currentSong?.duration || 0);
  state.playing = false;
  clock = null;
  engine.stopTag("demo", 0.06);
  updatePlayUI();
  updateTimelineUI(true);
}

function seekTo(time) {
  if (!state.currentSong) return;
  const duration = state.currentSong.duration;
  state.songTime = clamp(Number(time) || 0, 0, duration);
  engine.stopTag("demo", 0.025);
  visualizer.onSeek(state.songTime);

  if (state.playing && state.songTime >= duration - 0.01) {
    state.playing = false;
    clock = null;
    updatePlayUI();
  } else if (state.playing) {
    clock = makeClock(state.songTime, 0.035);
    schedulerCursor = lowerBound(state.currentSong.notes, state.songTime - 0.01);
    scheduleDemo();
  }

  updateTimelineUI(true);
  updateStatus();
}

function restartLoop() {
  if (!state.currentSong) return;
  engine.stopTag("demo", 0.025);
  state.songTime = 0;
  clock = makeClock(0, 0.045);
  schedulerCursor = 0;
  visualizer.onSeek(0);
  hands.reset();
  updateTimelineUI(true);
}

function scheduleDemo() {
  if (settings.training) return;
  if (!state.playing || !engine.ctx || !clock || clock.mode !== "audio" || !state.currentSong) return;
  if (engine.ctx.state !== "running") return;

  const now = engine.ctx.currentTime;
  const horizon = now + 0.26;
  const notes = state.currentSong.notes;

  try {
    while (schedulerCursor < notes.length) {
      const note = notes[schedulerCursor];
      const startAt = clock.ctxStart + (note.time - clock.song);
      if (startAt > horizon) break;
      schedulerCursor += 1;

      if (note.time < clock.song - 0.01) continue;
      if (startAt < now - 0.12) continue;

      engine.createVoice(note.midi, note.velocity * 0.92, {
        when: startAt,
        duration: note.duration,
        tag: "demo",
      });
    }
  } catch (error) {
    audioFailed = true;
    showToast(error.message || "The audio engine stopped unexpectedly.", { error: true });
  }
}

function getActiveSongNotes(time) {
  if (!state.currentSong) return [];
  const notes = state.currentSong.notes;
  const maxDuration = state.currentSong.maxDuration || 10;
  const from = Math.max(0, time - maxDuration - 0.1);
  const result = [];
  let index = lowerBound(notes, from);

  for (; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.time > time) break;
    if (note.time + note.duration > time) result.push(note);
  }
  return result;
}

function getLiveNotes() {
  const byMidi = new Map();
  for (const source of state.liveSources.values()) {
    if (!byMidi.has(source.midi)) {
      byMidi.set(source.midi, {
        id: `live-${source.midi}`,
        midi: source.midi,
        hand: source.midi < 60 ? "L" : "R",
        velocity: source.velocity,
        time: 0,
        duration: 0,
      });
    }
  }
  return [...byMidi.values()];
}

function updateKeyboardState(activeNotes) {
  const next = new Set(activeNotes.map((note) => note.midi));
  for (const midi of state.activeKeys) {
    if (!next.has(midi)) state.keyElements.get(midi)?.classList.remove("is-active");
  }
  for (const midi of next) {
    if (!state.activeKeys.has(midi)) state.keyElements.get(midi)?.classList.add("is-active");
  }
  state.activeKeys = next;
}

function markInteracted() {
  if (state.userHasInteracted) return;
  state.userHasInteracted = true;
  el.stageInvite.classList.add("is-hidden");
}

/* ---------- Live keys ---------- */

function sustainOn() {
  return state.sustainLocked || state.sustainHeld;
}

function flushSustainedVoices() {
  for (const voice of state.sustainedVoices) {
    if (engine.voices.has(voice)) engine.release(voice);
  }
  state.sustainedVoices.clear();
}

function refreshSustain() {
  updateSustainUI();
  if (!sustainOn()) flushSustainedVoices();
}

function setSustainLocked(locked) {
  state.sustainLocked = Boolean(locked);
  refreshSustain();
}

function setSustainHeld(held) {
  if (state.sustainHeld === held) return;
  state.sustainHeld = Boolean(held);
  refreshSustain();
}

function pressLiveNote(sourceId, midi, velocity = 0.72) {
  if (state.liveSources.has(sourceId)) return;
  markInteracted();

  const record = {
    sourceId,
    midi,
    velocity,
    voice: null,
  };
  state.liveSources.set(sourceId, record);

  if (settings.particles) {
    visualizer.burst(midi, {
      hand: midi < 60 ? "L" : "R",
      count: 8,
      strength: 0.8 + velocity * 0.25,
    });
  }

  if (audioFailed) return;

  const startVoice = () => {
    if (state.liveSources.get(sourceId) !== record) return;
    try {
      record.voice = engine.createVoice(midi, velocity, { tag: "live" });
    } catch (error) {
      audioFailed = true;
      showToast(error.message || "Audio could not start in this browser.", { error: true });
    }
  };

  if (engine.ctx?.state === "running") startVoice();
  else {
    engine.unlock().then(startVoice).catch((error) => {
      audioFailed = true;
      showToast(error.message || "Audio could not start in this browser.", { error: true });
    });
  }
}

function releaseLiveSource(sourceId) {
  const record = state.liveSources.get(sourceId);
  if (!record) return;
  state.liveSources.delete(sourceId);

  if (!record.voice) return;
  if (!engine.voices.has(record.voice)) return;

  if (sustainOn()) {
    state.sustainedVoices.add(record.voice);
  } else {
    engine.release(record.voice);
  }
}

function panicLive() {
  state.liveSources.clear();
  state.sustainedVoices.clear();
  engine.stopTag("live", 0.025);
  state.pointers.clear();
}

/* ---------- Main animation loop ---------- */

function frame(nowMs) {
  const dt = clamp((nowMs - state.lastFrame) / 1000, 0, 0.06);
  state.lastFrame = nowMs;

  if (state.playing) {
    const time = getSongTime();
    const duration = state.currentSong?.duration || 0;
    if (time >= duration) {
      if (settings.loop) {
        restartLoop();
      } else {
        state.songTime = duration;
        state.playing = false;
        clock = null;
        engine.stopTag("demo", 0.08);
        updatePlayUI();
        updateTimelineUI(true);
      }
    } else {
      state.songTime = time;
      scheduleDemo();
    }
  }

  const songNotes = getActiveSongNotes(state.songTime);
  const liveNotes = getLiveNotes();
  const visualNotes = [...songNotes, ...liveNotes];
  // In Training the song is a silent guide: keep its tiles falling, but do
  // not let it operate the keyboard or move the guide hands for the player.
  const inputNotes = settings.training ? liveNotes : visualNotes;

  visualizer.render(state.songTime, dt, {
    playing: state.playing,
    activeNotes: visualNotes,
  });
  updateKeyboardState(inputNotes);
  hands.update(inputNotes, dt);
  updateTimelineUI();
  updateStatus();

  requestAnimationFrame(frame);
}

/* ---------- MIDI import ---------- */

async function loadMidiFile(file) {
  if (!file) return;

  if (!/\.(mid|midi)$/i.test(file.name)) {
    showToast("Please choose a .mid or .midi file.", { error: true });
    return;
  }
  if (file.size > MAX_MIDI_FILE_BYTES) {
    showToast("That MIDI file is larger than 10 MB.", { error: true });
    return;
  }

  state.userHasInteracted = true;
  el.stageInvite.classList.add("is-hidden");
  el.loadMidiBtn.disabled = true;
  el.loadMidiBtn.setAttribute("aria-busy", "true");
  showToast(`Reading ${file.name}…`);

  try {
    const buffer = await file.arrayBuffer();
    const imported = parseMidi(buffer, file.name);
    state.songs.set(imported.id, imported);
    populateSongSelect();
    loadSong(imported);
    el.songSelect.value = imported.id;
    showToast(`Loaded ${imported.title} · ${imported.notes.length.toLocaleString()} notes`, { duration: 3200 });
  } catch (error) {
    showToast(error.message || "That MIDI file could not be read.", { error: true, duration: 5000 });
  } finally {
    el.loadMidiBtn.disabled = false;
    el.loadMidiBtn.removeAttribute("aria-busy");
    el.midiFileInput.value = "";
  }
}

/* ---------- Settings panel ---------- */

function openSettings() {
  if (el.settingsPanel.classList.contains("is-open")) return;
  clearTimeout(state.backdropTimer);
  state.lastFocused = document.activeElement;
  el.drawerBackdrop.hidden = false;
  el.settingsPanel.inert = false;
  el.app.inert = true;
  el.settingsPanel.classList.add("is-open");
  el.settingsPanel.setAttribute("aria-hidden", "false");
  el.settingsBtn.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => el.closeSettingsBtn.focus());
}

function closeSettings({ restoreFocus = true } = {}) {
  if (!el.settingsPanel.classList.contains("is-open")) return;
  el.settingsPanel.classList.remove("is-open");
  el.settingsPanel.setAttribute("aria-hidden", "true");
  el.settingsBtn.setAttribute("aria-expanded", "false");
  el.settingsPanel.inert = true;
  el.app.inert = false;
  clearTimeout(state.backdropTimer);
  state.backdropTimer = setTimeout(() => {
    el.drawerBackdrop.hidden = true;
  }, 300);
  if (restoreFocus && state.lastFocused instanceof HTMLElement) {
    state.lastFocused.focus({ preventScroll: true });
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {
      showToast("Full screen is not available here.", { error: true });
    });
  } else {
    document.exitFullscreen?.().catch(() => {
      showToast("Could not leave full screen.", { error: true });
    });
  }
}

function syncFullscreenUI() {
  const full = Boolean(document.fullscreenElement);
  document.body.classList.toggle("is-fullscreen", full);
  el.fullscreenBtn.setAttribute("aria-label", full ? "Leave full screen" : "Enter full screen");
  queueLayout();
}

/* ---------- Drag and drop ---------- */

let dragDepth = 0;

function hasFiles(event) {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

function hideDropzone() {
  dragDepth = 0;
  el.dropzone.classList.remove("is-active");
  el.dropzone.setAttribute("aria-hidden", "true");
}

/* ---------- Input ---------- */

function isTextInput(target) {
  return Boolean(target?.closest?.("input, select, textarea, [contenteditable='true']"));
}

function isNativeControl(target) {
  return Boolean(target?.closest?.("button, a, input, select, textarea, [role='button'], [contenteditable='true']"));
}

function pointerVelocity(key, event) {
  const rect = key.getBoundingClientRect();
  const ratio = rect.height ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0.6;
  return 0.58 + ratio * 0.32;
}

function keyFromPoint(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof Element)) return null;
  const key = element.closest(".piano-key");
  return key && el.keyboard.contains(key) ? key : null;
}

function handlePointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const key = event.target.closest?.(".piano-key");
  if (!key || !el.keyboard.contains(key)) return;

  event.preventDefault();
  markInteracted();
  const sourceId = `pointer:${event.pointerId}`;
  const midi = Number(key.dataset.midi);
  state.pointers.set(event.pointerId, { midi });
  try {
    el.keyboard.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is a convenience for glissando.
  }
  pressLiveNote(sourceId, midi, pointerVelocity(key, event));
}

function handlePointerMove(event) {
  if (!state.pointers.has(event.pointerId)) return;
  const key = keyFromPoint(event.clientX, event.clientY);
  const sourceId = `pointer:${event.pointerId}`;
  const pointer = state.pointers.get(event.pointerId);

  if (!key) {
    if (pointer.midi !== null) {
      releaseLiveSource(sourceId);
      pointer.midi = null;
    }
    return;
  }

  const midi = Number(key.dataset.midi);
  if (midi === pointer.midi) return;
  if (pointer.midi !== null) releaseLiveSource(sourceId);
  pointer.midi = midi;
  pressLiveNote(sourceId, midi, pointerVelocity(key, event));
}

function handlePointerUp(event) {
  if (!state.pointers.has(event.pointerId)) return;
  state.pointers.delete(event.pointerId);
  releaseLiveSource(`pointer:${event.pointerId}`);
}

function trapSettingsFocus(event) {
  const focusables = [...el.settingsPanel.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]
    .filter((node) => node.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleKeyDown(event) {
  if (event.key === "Escape") {
    closeSettings();
    return;
  }

  if (el.settingsPanel.classList.contains("is-open")) {
    if (event.key === "Tab") trapSettingsFocus(event);
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.code === "Space") {
    if (isNativeControl(event.target) || isTextInput(event.target)) return;
    event.preventDefault();
    if (!event.repeat) {
      markInteracted();
      setSustainHeld(true);
    }
    return;
  }

  if (isTextInput(event.target)) return;

  if (event.code === "BracketLeft" || event.code === "BracketRight") {
    event.preventDefault();
    if (!event.repeat) {
      markInteracted();
      stepOctave(event.code === "BracketRight" ? 1 : -1);
    }
    return;
  }

  const entry = CODE_TO_ENTRY.get(event.code);
  if (!entry) return;
  event.preventDefault();
  if (event.repeat) return;

  markInteracted();
  pressLiveNote(`key:${event.code}`, state.octaveBase + entry.offset, 0.72);
}

function handleKeyUp(event) {
  if (event.code === "Space") {
    setSustainHeld(false);
    return;
  }
  if (CODE_TO_ENTRY.has(event.code)) {
    releaseLiveSource(`key:${event.code}`);
  }
}

/* ---------- Bindings and startup ---------- */

function bindEvents() {
  el.playBtn.addEventListener("click", async () => {
    el.playBtn.blur();
    if (state.playing) pausePlayback();
    else await startPlayback();
  });

  el.trainingBtn.addEventListener("click", () => {
    setTraining(!settings.training, { announce: true });
  });

  el.songSelect.addEventListener("change", () => {
    const source = state.songs.get(el.songSelect.value);
    if (!source) return;
    markInteracted();
    loadSong(source);
  });

  el.timeline.addEventListener("input", () => {
    const duration = state.currentSong?.duration || 0;
    seekTo((Number(el.timeline.value) / 1000) * duration);
  });

  el.loopBtn.addEventListener("click", () => {
    settings.loop = !settings.loop;
    syncControls();
    saveSettingsSoon();
  });

  el.sustainBtn.addEventListener("click", () => {
    markInteracted();
    setSustainLocked(!state.sustainLocked);
  });

  el.muteBtn.addEventListener("click", () => {
    settings.mute = !settings.mute;
    if (!settings.mute && settings.volume < 0.01) settings.volume = 0.5;
    applySettings();
  });

  for (const slider of [el.volumeRange, el.volumeRangeSettings]) {
    slider.addEventListener("input", () => {
      settings.volume = Number(slider.value) / 100;
      if (settings.volume > 0) settings.mute = false;
      applySettings();
    });
  }

  el.loadMidiBtn.addEventListener("click", () => el.midiFileInput.click());
  el.midiFileInput.addEventListener("change", () => {
    const file = el.midiFileInput.files?.[0];
    if (file) loadMidiFile(file);
  });

  el.settingsBtn.addEventListener("click", openSettings);
  el.closeSettingsBtn.addEventListener("click", () => closeSettings());
  el.drawerBackdrop.addEventListener("click", () => closeSettings());

  el.themeGrid.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-theme-choice]");
    if (!button) return;
    settings.theme = button.dataset.themeChoice;
    applyTheme(settings.theme);
    saveSettingsSoon();
  });

  el.speedRange.addEventListener("input", () => {
    settings.speed = Number(el.speedRange.value) / 100;
    applySettings();
  });

  el.glowRange.addEventListener("input", () => {
    settings.glow = Number(el.glowRange.value) / 100;
    applySettings();
  });

  const toggleBindings = [
    [el.toggleTiles, "tiles"],
    [el.toggleParticles, "particles"],
    [el.toggleHands, "hands"],
    [el.toggleKeyHints, "keyHints"],
    [el.toggleNoteNames, "noteNames"],
    [el.toggleAmbient, "ambient"],
  ];
  for (const [checkbox, key] of toggleBindings) {
    checkbox.addEventListener("change", () => {
      settings[key] = checkbox.checked;
      applySettings();
    });
  }

  el.resetSettingsBtn.addEventListener("click", () => {
    const wasTraining = settings.training;
    Object.assign(settings, DEFAULT_SETTINGS);
    applyTheme(settings.theme);
    applySettings();
    if (wasTraining) engine.stopTag("demo", 0.08);
    updateStatus();
    showToast("Settings reset to defaults.");
  });

  el.octaveDown.addEventListener("click", () => stepOctave(-1));
  el.octaveUp.addEventListener("click", () => stepOctave(1));
  el.fullscreenBtn.addEventListener("click", toggleFullscreen);

  el.keyboard.addEventListener("pointerdown", handlePointerDown);
  el.keyboard.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);

  document.addEventListener("pointerdown", primeAudio, { once: true, capture: true });
  document.addEventListener("keydown", primeAudio, { once: true, capture: true });

  window.addEventListener("blur", () => {
    setSustainHeld(false);
    panicLive();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.playing) pausePlayback();
      setSustainHeld(false);
      panicLive();
    }
  });

  document.addEventListener("fullscreenchange", syncFullscreenUI);

  window.addEventListener("resize", queueLayout);

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    el.dropzone.classList.add("is-active");
    el.dropzone.setAttribute("aria-hidden", "false");
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      el.dropzone.classList.remove("is-active");
      el.dropzone.setAttribute("aria-hidden", "true");
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    hideDropzone();
    const file = event.dataTransfer?.files?.[0];
    if (file) loadMidiFile(file);
  });

  window.addEventListener("beforeunload", () => {
    engine.stopAll();
  });
}

function init() {
  el.settingsPanel.inert = true;
  el.settingsPanel.setAttribute("aria-hidden", "true");
  applyTheme(settings.theme);
  applySettings();
  populateSongSelect();
  bindEvents();

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(queueLayout);
    observer.observe(el.stage);
    observer.observe(el.keyboard);
    observer.observe(el.handsLayer);
  }

  const defaultSong = state.songs.get(DEFAULT_SONG_ID) || state.songs.values().next().value;
  loadSong(defaultSong);
  state.lastFrame = performance.now();
  requestAnimationFrame(frame);
}

init();
