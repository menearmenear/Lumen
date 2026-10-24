/* Sampled piano with a synthesized fallback.
   The Salamander Grand Piano samples are mono, 32 kHz OGG files in
   ../assets/piano. If they cannot be loaded (for example when the page is
   opened directly from disk), the engine falls back to a lightweight synth. */

const TAU = Math.PI * 2;
const MAX_VOICES = 64;
const SAMPLE_BASE = new URL("../assets/piano/", import.meta.url);
const NOTE_NAMES = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"];

// Salamander is sampled in minor thirds from A0. Keeping a root close to the
// requested note means samples are never pitch-shifted more than a semitone or
// two, which preserves the piano's body and attack.
const SAMPLE_ROOTS = [];
for (let midi = 21; midi <= 108; midi += 1) {
  const pitchClass = ((midi % 12) + 12) % 12;
  if (pitchClass === 9 || pitchClass === 0 || pitchClass === 3 || pitchClass === 6) {
    SAMPLE_ROOTS.push(midi);
  }
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sampleName(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export class PianoEngine {
  constructor() {
    this.ctx = null;
    this.input = null;
    this.mix = null;
    this.master = null;
    this.compressor = null;
    this.limiter = null;
    this.convolver = null;
    this.wet = null;
    this.dry = null;
    this.voices = new Set();
    this.volume = 0.78;
    this.muted = false;
    this.ready = false;
    this.pianoWave = null;
    this.noiseBuffer = null;
    this._unlockPromise = null;
    this.sampleBank = [];
    this.sampleRoots = [];
    this.samplesReady = null;
    this._preloadPromise = null;
    this._decodePromise = null;

    // Start moving and decoding the local sample files now so the first Play
    // is not delayed by sample preparation. Firefox allows a suspended
    // AudioContext to decode buffers before the first user gesture; unlock()
    // resumes it later. Direct file:// previews use the synth fallback.
    this._preloadSamples();
    if (location.protocol !== "file:") {
      try {
        this._build();
      } catch {
        // unlock() will retry and report a useful error if audio is unavailable.
        this.ctx = null;
      }
    }
  }

  async unlock() {
    if (this.ready && this.ctx?.state === "running") return;
    if (this._unlockPromise) return this._unlockPromise;

    this._unlockPromise = (async () => {
      if (!this.ctx) this._build();
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.ready = true;
    })();

    try {
      await this._unlockPromise;
    } finally {
      this._unlockPromise = null;
    }
  }

  _preloadSamples() {
    if (this._preloadPromise) return this._preloadPromise;

    // file:// pages cannot fetch sibling files in current Firefox versions.
    // Use the synth fallback there instead of producing a wall of errors.
    if (location.protocol === "file:") {
      this._preloadPromise = Promise.resolve([]);
      return this._preloadPromise;
    }

    this._preloadPromise = Promise.all(
      SAMPLE_ROOTS.map(async (midi) => {
        try {
          const url = new URL(`${sampleName(midi)}.ogg`, SAMPLE_BASE);
          const response = await fetch(url, { cache: "force-cache" });
          if (!response.ok) return null;
          return { midi, data: await response.arrayBuffer() };
        } catch {
          return null;
        }
      }),
    ).then((entries) => entries.filter(Boolean));

    return this._preloadPromise;
  }

  async _decodeSamples() {
    if (this._decodePromise) return this._decodePromise;

    this._decodePromise = (async () => {
      const files = await this._preloadSamples();
      if (!this.ctx || !files.length) return;

      const decoded = await Promise.all(
        files.map(async (entry) => {
          try {
            const buffer = await this.ctx.decodeAudioData(entry.data.slice(0));
            return { midi: entry.midi, buffer };
          } catch {
            return null;
          }
        }),
      );

      this.sampleBank = decoded
        .filter(Boolean)
        .map((entry) => {
          // The source files are recorded at different natural levels. Bring
          // them to a common peak so high notes remain present and the whole
          // keyboard feels like one instrument. Bass is not boosted as much,
          // which preserves its weight without making it overbearing.
          let peak = 0;
          for (let channel = 0; channel < entry.buffer.numberOfChannels; channel += 1) {
            const data = entry.buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i += 1) {
              const value = Math.abs(data[i]);
              if (value > peak) peak = value;
            }
          }
          const gain = clamp(0.58 / Math.max(peak, 0.01), 1, 3.2);
          return { ...entry, gain };
        })
        .sort((a, b) => a.midi - b.midi);
      this.sampleRoots = this.sampleBank.map((entry) => entry.midi);
    })();

    return this._decodePromise;
  }

  _build() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is not available in this browser.");

    const ctx = new AudioContextClass();
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.input.gain.value = 1;

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.96;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._buildImpulse(ctx, 1.8);

    const reverbTone = ctx.createBiquadFilter();
    reverbTone.type = "highpass";
    reverbTone.frequency.value = 180;
    reverbTone.Q.value = 0.4;

    this.wet = ctx.createGain();
    this.wet.gain.value = 0.08;

    this.mix = ctx.createGain();
    this.mix.gain.value = 1;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -9;
    this.compressor.knee.value = 14;
    this.compressor.ratio.value = 2.2;
    this.compressor.attack.value = 0.008;
    this.compressor.release.value = 0.22;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this._volumeGain();

    // A final brick-wall stage only catches the loudest chord peaks. It is
    // deliberately after the master gain so the volume slider stays useful.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 28;
    highpass.Q.value = 0.4;

    this.input.connect(this.dry).connect(this.mix);
    this.input.connect(this.convolver).connect(reverbTone).connect(this.wet).connect(this.mix);
    this.mix
      .connect(highpass)
      .connect(this.compressor)
      .connect(this.master)
      .connect(this.limiter)
      .connect(ctx.destination);

    this.pianoWave = this._buildPianoWave(ctx);
    this.noiseBuffer = this._buildNoiseBuffer(ctx);
    this.samplesReady = this._decodeSamples();
  }

  _buildPianoWave(ctx) {
    const count = 36;
    const real = new Float32Array(count + 1);
    const imag = new Float32Array(count + 1);

    for (let n = 1; n <= count; n += 1) {
      const rolloff = n ** -1.27;
      const even = n % 2 === 0 ? 0.82 : 1;
      const irregularity = 0.78 + 0.22 * Math.sin(n * 1.73 + 0.4);
      const amplitude = rolloff * even * irregularity;
      const phase = (n * 2.31) % TAU;
      real[n] = amplitude * Math.cos(phase);
      imag[n] = amplitude * Math.sin(phase);
    }

    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  _buildNoiseBuffer(ctx) {
    const length = Math.floor(ctx.sampleRate * 0.09);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.22 + white * 0.78;
      data[i] = last * (1 - i / length) ** 1.8;
    }
    return buffer;
  }

  _buildImpulse(ctx, seconds) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      let smoothed = 0;
      for (let i = 0; i < length; i += 1) {
        const t = i / length;
        const decay = (1 - t) ** 3.4;
        const noise = Math.random() * 2 - 1;
        smoothed = smoothed * 0.72 + noise * 0.28;
        data[i] = smoothed * decay * (channel ? 0.88 : 1);
      }
    }
    return buffer;
  }

  _volumeGain() {
    if (this.volume <= 0) return 0;
    return this.volume ** 1.08 * 1.85;
  }

  setVolume(value) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    this._applyVolume();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this._applyVolume();
  }

  _applyVolume() {
    if (!this.ctx) return;
    const target = this.muted ? 0 : this._volumeGain();
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.035);
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  _nearestSample(midi) {
    if (!this.sampleBank.length) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const entry of this.sampleBank) {
      const distance = Math.abs(entry.midi - midi);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best;
  }

  createVoice(midi, velocity = 0.7, options = {}) {
    if (!this.ctx) return null;

    const when = Math.max(this.ctx.currentTime + 0.004, options.when ?? this.ctx.currentTime);
    const duration = Number.isFinite(options.duration) ? Math.max(0.06, options.duration) : null;
    const tag = options.tag || "live";
    const velocityValue = clamp(velocity, 0.02, 1);

    if (this.voices.size >= MAX_VOICES) {
      const oldest = this.voices.values().next().value;
      if (oldest) this.release(oldest, true);
    }

    // A piano key can only sound once at a time. Retriggering a note damps the
    // old string instead of layering two copies, which is what made repeated
    // MIDI notes and same-note overlaps sound doubled or phasey.
    this._dampSameKey(midi, when);

    const sample = this._nearestSample(midi);
    if (sample) return this._createSampleVoice(midi, velocityValue, when, duration, tag, sample);
    return this._createSynthVoice(midi, velocityValue, when, duration, tag);
  }

  _dampSameKey(midi, when) {
    const now = this.ctx.currentTime;
    for (const voice of [...this.voices]) {
      if (voice.midi !== midi || voice.released) continue;

      if (voice.when >= when - 0.004) {
        // A duplicate that has not spoken yet can be cancelled silently.
        this._silenceVoice(voice, now + 0.002);
      } else {
        // Let the old note sustain right up to the new strike, then damp it.
        this._scheduleRelease(voice, Math.max(now + 0.008, when - 0.01), 0.06);
      }
    }
  }

  _createSampleVoice(midi, velocityValue, when, duration, tag, sample) {
    const ctx = this.ctx;
    const rate = 2 ** ((midi - sample.midi) / 12);

    const source = ctx.createBufferSource();
    source.buffer = sample.buffer;
    source.playbackRate.setValueAtTime(rate, when);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.setValueAtTime(0.32, when);
    const cutoff = clamp(3000 + velocityValue ** 1.15 * 14000, 3000, 17500);
    filter.frequency.setValueAtTime(cutoff, when);

    const toneGain = ctx.createGain();
    const peak = 0.62 * velocityValue ** 1.15 * (sample.gain || 1);
    // Keep the hammer transient intact. A long fade-in rounds off the attack
    // and is the main reason synthesized/sample-blended pianos sound soft.
    const attack = 0.0004;
    toneGain.gain.setValueAtTime(0.0001, when);
    toneGain.gain.linearRampToValueAtTime(peak, when + attack);

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      const spread = ((midi - 60) / 39) * 0.42;
      pan.pan.setValueAtTime(clamp(spread, -0.58, 0.58), when);
    }

    source.connect(filter);
    filter.connect(toneGain);
    if (pan) {
      toneGain.connect(pan);
      pan.connect(this.input);
    } else {
      toneGain.connect(this.input);
    }

    const voice = {
      midi,
      tag,
      when,
      createdAt: ctx.currentTime,
      osc: source,
      toneGain,
      gains: [toneGain.gain],
      nodes: pan ? [source, filter, toneGain, pan] : [source, filter, toneGain],
      released: false,
      stopped: false,
    };

    this.voices.add(voice);
    source.onended = () => this._cleanupVoice(voice);
    source.start(when);

    if (duration !== null) {
      const off = when + duration;
      const sampleEnd = when + sample.buffer.duration / rate;
      if (off < sampleEnd - 0.015) this._scheduleRelease(voice, off, 0.34);
    }

    return voice;
  }

  _createSynthVoice(midi, velocityValue, when, duration, tag) {
    const ctx = this.ctx;
    const frequency = midiToFrequency(midi);
    const register = clamp((midi - 21) / 87, 0, 1);

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.pianoWave);
    osc.frequency.setValueAtTime(frequency, when);
    osc.detune.setValueAtTime((Math.random() * 2 - 1) * 2.8, when);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.setValueAtTime(0.55, when);

    const cutoff = clamp(1500 + velocityValue * 5600 + frequency * 2.3, 900, 11500);
    const restingCutoff = clamp(frequency * 2.4 + 520, 420, 4500);
    filter.frequency.setValueAtTime(cutoff, when);
    filter.frequency.exponentialRampToValueAtTime(restingCutoff, when + 0.85);

    const toneGain = ctx.createGain();
    const peak = (0.19 + register * 0.02) * velocityValue ** 1.4;
    const attack = 0.005 + (1 - velocityValue) * 0.008;
    const decayLength = 4.2 + (1 - register) * 4.8;

    toneGain.gain.setValueAtTime(0.0001, when);
    toneGain.gain.linearRampToValueAtTime(peak, when + attack);
    toneGain.gain.exponentialRampToValueAtTime(peak * 0.34, when + 0.38);
    toneGain.gain.exponentialRampToValueAtTime(Math.max(0.00012, peak * 0.055), when + 2.15);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, when + decayLength);

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      const spread = ((midi - 60) / 39) * 0.48;
      pan.pan.setValueAtTime(clamp(spread + (Math.random() * 2 - 1) * 0.03, -0.72, 0.72), when);
    }

    osc.connect(filter);
    filter.connect(toneGain);
    if (pan) {
      toneGain.connect(pan);
      pan.connect(this.input);
    } else {
      toneGain.connect(this.input);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = clamp(frequency * 5.2, 900, 5400);
    noiseFilter.Q.value = 0.5;
    const noiseGain = ctx.createGain();
    const noisePeak = 0.02 * velocityValue + 0.004;
    noiseGain.gain.setValueAtTime(noisePeak, when);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    if (pan) noiseGain.connect(pan);
    else noiseGain.connect(this.input);

    const voice = {
      midi,
      tag,
      when,
      createdAt: ctx.currentTime,
      osc,
      toneGain,
      gains: [toneGain.gain, noiseGain.gain],
      nodes: pan
        ? [osc, filter, toneGain, pan, noise, noiseFilter, noiseGain]
        : [osc, filter, toneGain, noise, noiseFilter, noiseGain],
      released: false,
      stopped: false,
    };

    this.voices.add(voice);
    osc.onended = () => this._cleanupVoice(voice);
    osc.start(when);

    try {
      noise.start(when);
      noise.stop(when + 0.1);
    } catch {
      // The hammer noise is decorative; never let it stop the note.
    }

    if (duration !== null) {
      this._scheduleRelease(voice, when + duration, 0.38);
    } else {
      this._scheduleOscillatorStop(voice, when + decayLength + 0.2);
    }

    return voice;
  }

  _cleanupVoice(voice) {
    if (voice.stopped) return;
    voice.stopped = true;
    this.voices.delete(voice);
    for (const node of voice.nodes || []) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }

  _scheduleRelease(voice, releaseTime, tail = 0.4) {
    const ctx = this.ctx;
    if (!ctx || !voice || voice.stopped) return;
    const t = Math.max(releaseTime, ctx.currentTime + 0.003);

    for (const gain of voice.gains || []) {
      try {
        gain.cancelScheduledValues(t);
        gain.setTargetAtTime(0.0001, t, Math.max(0.008, tail / 6));
      } catch {
        // A failed fade still leaves the stop below as a hard safety net.
      }
    }

    this._scheduleOscillatorStop(voice, t + tail);
  }

  _silenceVoice(voice, time) {
    if (!this.ctx || !voice || voice.stopped) return;
    voice.released = true;
    const t = Math.max(time, this.ctx.currentTime + 0.001);
    for (const gain of voice.gains || []) {
      try {
        gain.cancelScheduledValues(t);
        gain.setTargetAtTime(0.0001, t, 0.003);
      } catch {
        // Stop immediately below.
      }
    }
    this._scheduleOscillatorStop(voice, t + 0.02);
  }

  _scheduleOscillatorStop(voice, time) {
    if (!voice?.osc) return;
    try {
      voice.osc.stop(time);
    } catch {
      // Already stopped.
    }
  }

  release(voice, immediate = false) {
    if (!voice || voice.released) return;
    voice.released = true;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._scheduleRelease(voice, immediate ? now : now + 0.012, 0.32);
  }

  stopTag(tag, fade = 0.05) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const voice of [...this.voices]) {
      if (voice.tag !== tag) continue;
      this._scheduleRelease(voice, now + fade, 0.28);
    }
  }

  stopAll() {
    for (const voice of [...this.voices]) this.release(voice, true);
  }
}
