/* Canvas falling-note visualizer.
   Notes, lanes, and particles are rendered into reusable sprite layers so the
   animation loop only has to composite a handful of images and paths. */

const TAU = Math.PI * 2;
const SPRITE_PAD = 42;
const SPRITE_CACHE_LIMIT = 64;
const SPRITE_CACHE_BYTES = 40 * 1024 * 1024;
const PARTICLE_LIMIT = 150;
const RING_LIMIT = 24;
const PIXEL_BUDGET = 3_400_000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lowerBound(array, target, key = "time") {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (array[mid][key] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function hexToRgb(hex) {
  const value = String(hex).trim().replace("#", "");
  if (value.length === 3) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
    ];
  }
  return [
    parseInt(value.slice(0, 2), 16) || 255,
    parseInt(value.slice(2, 4), 16) || 255,
    parseInt(value.slice(4, 6), 16) || 255,
  ];
}

function rgba(color, alpha = 1) {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* Keep the sprite atlas small without making tile heights visibly step. */
function heightBucket(height) {
  if (height <= 40) return Math.max(4, Math.round(height));
  if (height <= 160) return Math.round(height / 8) * 8;
  if (height <= 560) return Math.round(height / 24) * 24;
  return Math.round(height / 64) * 64;
}

export class FallingNotes {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    this.baseCanvas = stage.querySelector(".visualizer-base");
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.notes = [];
    this.song = null;
    this.duration = 0;
    this.maxDuration = 1;
    this.keyGeometry = new Map();
    this.palette = {
      left: "#ff7fc5",
      leftB: "#ffac72",
      right: "#70e9ff",
      rightB: "#8f9dff",
      accent: "#7ee7ff",
      accent2: "#b695ff",
      grid: "#8fa4c7",
    };
    this.options = {
      glow: 0.75,
      speed: 1,
      showTiles: true,
      particles: true,
      noteNames: true,
    };
    this.particles = [];
    this.rings = [];
    this.lastTime = null;
    this.lastRenderedTime = null;
    this.hitIds = new Set();
    this.activeCount = 0;
    this.playing = false;
    this.dirty = true;
    this.baseDirty = true;
    this.spriteCache = new Map();
    this.spriteBytes = 0;
    this.particleSprites = new Map();
    this._fontSet = false;
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    // High-DPI looks best, but a full-screen 4K canvas can cost more than it
    // adds. Keep a pixel budget and let the canvas stretch to the stage.
    let dpr = clamp(window.devicePixelRatio || 1, 1, 1.5);
    const budgetDpr = Math.sqrt(PIXEL_BUDGET / Math.max(1, width * height));
    dpr = Math.min(dpr, Math.max(0.75, budgetDpr));
    dpr = Math.round(dpr * 100) / 100;

    if (width === this.width && height === this.height && dpr === this.dpr) return false;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));

    for (const target of [this.canvas, this.baseCanvas]) {
      if (!target) continue;
      target.width = pixelWidth;
      target.height = pixelHeight;
      target.style.width = `${width}px`;
      target.style.height = `${height}px`;
    }

    this._clearSprites();
    this.baseDirty = true;
    this.dirty = true;
    return true;
  }

  _clearSprites() {
    this.spriteCache.clear();
    this.spriteBytes = 0;
  }

  setSong(song) {
    this.song = song;
    this.notes = song?.notes || [];
    this.duration = song?.duration || 0;
    this.maxDuration = 1;
    for (const note of this.notes) {
      if (note.duration > this.maxDuration) this.maxDuration = note.duration;
    }
    this.resetTracking();
    this.baseDirty = true;
    this.dirty = true;
  }

  setKeyGeometry(keys) {
    this.keyGeometry = new Map();
    for (const key of keys) this.keyGeometry.set(key.midi, key);
    this._clearSprites();
    this.baseDirty = true;
    this.dirty = true;
  }

  setPalette(palette) {
    this.palette = { ...this.palette, ...palette };
    this._clearSprites();
    this.baseDirty = true;
    this.dirty = true;
  }

  setOptions(options) {
    const previous = this.options;
    this.options = { ...this.options, ...options };
    if (options.glow !== undefined && Number(options.glow) !== previous.glow) {
      this._clearSprites();
      this.dirty = true;
    }
    if (options.showTiles !== undefined && Boolean(options.showTiles) !== previous.showTiles) {
      this.baseDirty = true;
      this.dirty = true;
    }
    if (options.particles === false && (this.particles.length || this.rings.length)) {
      this.particles.length = 0;
      this.rings.length = 0;
      this.dirty = true;
    }
    if (this.options.noteNames !== previous.noteNames) this.dirty = true;
    if (this.options.speed !== previous.speed) this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  onSeek(time = 0) {
    this.hitIds.clear();
    this.lastTime = time;
    this.lastRenderedTime = null;
    this.particles.length = 0;
    this.rings.length = 0;
    this.dirty = true;
  }

  resetTracking() {
    this.hitIds.clear();
    this.lastTime = null;
    this.lastRenderedTime = null;
    this.particles.length = 0;
    this.rings.length = 0;
    this.dirty = true;
  }

  _spawnBurst(x, color, options = {}) {
    if (!this.options.particles) return;

    const room = PARTICLE_LIMIT - this.particles.length;
    if (room <= 0) return;
    const requested = options.count ?? 13;
    const count = Math.min(requested, Math.max(2, room));
    const strength = options.strength ?? 1;
    const baseY = this.height - 2;

    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.45;
      const speed = (45 + Math.random() * 150) * strength;
      const life = 0.35 + Math.random() * 0.55;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 16,
        y: baseY,
        vx: Math.cos(angle) * speed * (0.55 + Math.random() * 0.7),
        vy: Math.sin(angle) * speed,
        gravity: 90 + Math.random() * 60,
        life,
        maxLife: life,
        size: 1.1 + Math.random() * 2.4,
        color,
      });
    }

    if (this.rings.length < RING_LIMIT) {
      this.rings.push({
        x,
        y: baseY,
        radius: 2,
        speed: 48 + Math.random() * 24,
        life: 0.52,
        maxLife: 0.52,
        color,
      });
    }

    this.dirty = true;
  }

  burst(midi, options = {}) {
    const key = this.keyGeometry.get(midi);
    if (!key) return;
    const color = options.hand === "L" ? this.palette.left : this.palette.right;
    this._spawnBurst(key.x + (Math.random() - 0.5) * 4, color, options);
  }

  _detectHits(time) {
    if (this.lastTime === null) {
      this.lastTime = time;
      return;
    }

    if (time < this.lastTime - 0.001) {
      this.hitIds.clear();
      this.lastTime = time;
      return;
    }

    if (!this.playing || time <= this.lastTime) {
      this.lastTime = time;
      return;
    }

    const from = this.lastTime;
    const to = time;
    const startIndex = lowerBound(this.notes, from);
    for (let i = startIndex; i < this.notes.length; i += 1) {
      const note = this.notes[i];
      if (note.time > to) break;
      if (note.time < from - 0.0005) continue;
      if (this.hitIds.has(note.id)) continue;
      this.hitIds.add(note.id);
      if (this.options.particles) {
        const key = this.keyGeometry.get(note.midi);
        if (key) {
          const color = note.hand === "L" ? this.palette.left : this.palette.right;
          this._spawnBurst(key.x, color, {
            count: note.velocity > 0.72 ? 13 : 9,
            strength: 0.7 + note.velocity * 0.45,
          });
        }
      }
    }

    this.lastTime = time;
  }

  _updateParticles(dt) {
    const step = clamp(dt, 0, 0.05);
    let write = 0;
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      particle.life -= step;
      if (particle.life <= 0) continue;
      particle.vy += particle.gravity * step;
      particle.x += particle.vx * step;
      particle.y += particle.vy * step;
      this.particles[write] = particle;
      write += 1;
    }
    this.particles.length = write;

    write = 0;
    for (let i = 0; i < this.rings.length; i += 1) {
      const ring = this.rings[i];
      ring.life -= step;
      if (ring.life <= 0) continue;
      ring.radius += ring.speed * step;
      this.rings[write] = ring;
      write += 1;
    }
    this.rings.length = write;
  }

  render(time, dt, context = {}) {
    if (!this.width) this.resize();
    this.playing = Boolean(context.playing);
    this.activeCount = context.activeNotes?.length || 0;
    this._detectHits(time);

    const hadEffects = this.particles.length > 0 || this.rings.length > 0;
    this._updateParticles(dt);

    const moved = this.lastRenderedTime === null || Math.abs(time - this.lastRenderedTime) > 0.000001;
    if (!this.dirty && !this.playing && !moved && !hadEffects) return;

    if (this.baseDirty) this._buildBase();

    const ctx = this.ctx;
    const { width, height } = this;
    const hitY = height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.dirty = false;
    this.lastRenderedTime = time;

    if (!this.song) return;

    const pps = (height / 3.1) * this.options.speed;
    const latestTime = time + height / pps + 0.3;
    const earliest = Math.max(0, time - this.maxDuration - 0.5);
    let index = lowerBound(this.notes, earliest);

    if (this.options.showTiles) {
      if (this.options.noteNames) {
        ctx.font = '600 9px ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255, 255, 255, 0.63)";
      }

      for (; index < this.notes.length; index += 1) {
        const note = this.notes[index];
        if (note.time > latestTime) break;
        const key = this.keyGeometry.get(note.midi);
        if (!key) continue;

        const onsetY = hitY - (note.time - time) * pps;
        const tileHeight = Math.min(note.duration * pps, height * 1.8);
        const topY = onsetY - tileHeight;
        if (topY > hitY + 60 || onsetY < -60) continue;

        this._drawNote(ctx, note, key, topY, onsetY, time);
      }
    }

    if (this.particles.length || this.rings.length) {
      this._drawParticles(ctx);
    }
  }

  _buildBase() {
    const base = this.baseCanvas;
    this.baseDirty = false;
    if (!base) return;
    const ctx = base.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (!this.song) return;
    if (this.options.showTiles) this._drawLanes(ctx, this.height);
    this._drawHitline(ctx, this.height);
  }

  _drawLanes(ctx, hitY) {
    if (!this.keyGeometry.size) return;
    const gradient = ctx.createLinearGradient(0, 0, 0, hitY);
    gradient.addColorStop(0, rgba(this.palette.grid, 0));
    gradient.addColorStop(0.45, rgba(this.palette.grid, 0.028));
    gradient.addColorStop(0.9, rgba(this.palette.grid, 0.075));
    gradient.addColorStop(1, rgba(this.palette.accent, 0.16));
    ctx.save();
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const key of this.keyGeometry.values()) {
      if (key.isBlack) continue;
      const x = Math.round(key.x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hitY);
    }
    ctx.stroke();
    ctx.restore();
  }

  _getNoteSprite(hand, active, width, height) {
    const spriteWidth = Math.max(4, Math.round(width * 2) / 2);
    const bucketHeight = heightBucket(height);
    const key = `${hand}${active ? "a" : "n"}:${spriteWidth}:${bucketHeight}`;
    const cached = this.spriteCache.get(key);
    if (cached) {
      // Refresh LRU order.
      this.spriteCache.delete(key);
      this.spriteCache.set(key, cached);
      return cached;
    }

    const renderHeight = Math.min(bucketHeight, 760);
    const dpr = this.dpr;
    const pixelWidth = Math.max(1, Math.ceil((spriteWidth + SPRITE_PAD * 2) * dpr));
    const pixelHeight = Math.max(1, Math.ceil((renderHeight + SPRITE_PAD * 2) * dpr));
    const sprite = document.createElement("canvas");
    sprite.width = pixelWidth;
    sprite.height = pixelHeight;
    const c = sprite.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.translate(SPRITE_PAD, SPRITE_PAD);

    const glow = this.options.glow;
    const leftHand = hand === "L";
    const colorTop = leftHand ? this.palette.left : this.palette.right;
    const colorBottom = leftHand ? this.palette.leftB : this.palette.rightB;
    const radius = Math.min(7, spriteWidth * 0.28);

    const gradient = c.createLinearGradient(0, 0, 0, renderHeight);
    gradient.addColorStop(0, rgba(colorTop, active ? 0.2 : 0.11));
    gradient.addColorStop(0.42, rgba(colorTop, active ? 0.65 : 0.48));
    gradient.addColorStop(0.88, rgba(colorBottom, active ? 1 : 0.9));
    gradient.addColorStop(1, rgba(colorBottom, active ? 1 : 0.98));

    if (glow > 0) {
      c.shadowColor = rgba(colorBottom, clamp(glow * (active ? 0.8 : 0.52), 0, 0.9));
      c.shadowBlur = (active ? 28 : 15) * glow;
      c.shadowOffsetY = active ? 0 : 5;
    }

    c.fillStyle = gradient;
    c.beginPath();
    c.roundRect(0, 0, spriteWidth, renderHeight, radius);
    c.fill();

    c.shadowBlur = 0;
    c.shadowOffsetY = 0;
    c.globalAlpha = 0.32 + glow * 0.25;
    c.fillStyle = "rgba(255, 255, 255, 0.55)";
    c.beginPath();
    c.roundRect(
      spriteWidth * 0.16,
      2,
      Math.max(1, spriteWidth * 0.18),
      Math.max(2, renderHeight - 4),
      spriteWidth * 0.1,
    );
    c.fill();
    c.globalAlpha = 1;

    const edgeHeight = Math.min(4, renderHeight * 0.16);
    const edge = c.createLinearGradient(0, renderHeight - edgeHeight, 0, renderHeight);
    edge.addColorStop(0, "rgba(255, 255, 255, 0)");
    edge.addColorStop(0.68, rgba(colorBottom, 0.62));
    edge.addColorStop(1, "rgba(255, 255, 255, 0.9)");
    c.fillStyle = edge;
    c.beginPath();
    c.roundRect(1, renderHeight - edgeHeight, spriteWidth - 2, edgeHeight, [2, 2, radius, radius]);
    c.fill();

    const entry = {
      canvas: sprite,
      pad: SPRITE_PAD,
      width: spriteWidth,
      height: renderHeight,
      bytes: pixelWidth * pixelHeight * 4,
    };
    this.spriteCache.set(key, entry);
    this.spriteBytes += entry.bytes;

    for (const [oldKey, old] of this.spriteCache) {
      if (this.spriteCache.size <= SPRITE_CACHE_LIMIT && this.spriteBytes <= SPRITE_CACHE_BYTES) break;
      if (this.spriteCache.size <= 1) break;
      this.spriteCache.delete(oldKey);
      this.spriteBytes -= old.bytes;
    }

    return entry;
  }

  _drawNote(ctx, note, key, topY, onsetY, time) {
    const height = onsetY - topY;
    if (height <= 0.5) return;

    const width = Math.max(4, key.width * (key.isBlack ? 0.72 : 0.8));
    const active = time >= note.time && time < note.end;
    const sprite = this._getNoteSprite(note.hand, active, width, height);
    const pad = sprite.pad;
    const x = key.x - width / 2 - pad;
    const y = onsetY - height - pad;
    ctx.drawImage(sprite.canvas, x, y, width + pad * 2, height + pad * 2);

    if (this.options.noteNames && height > 30 && width > 16 && onsetY > 10) {
      const labelY = clamp(onsetY - 11, 11, this.height - 8);
      if (labelY < onsetY - 6 && labelY < this.height - 4) {
        ctx.fillText(note.name, key.x, labelY);
      }
    }
  }

  _drawHitline(ctx, hitY) {
    const glow = this.options.glow;
    const intensity = clamp(0.55 + glow * 0.38, 0, 1);
    ctx.save();

    const line = ctx.createLinearGradient(0, 0, this.width, 0);
    line.addColorStop(0, rgba(this.palette.accent, 0));
    line.addColorStop(0.12, rgba(this.palette.accent, 0.14 * intensity));
    line.addColorStop(0.5, rgba(this.palette.accent, 0.62 * intensity));
    line.addColorStop(0.88, rgba(this.palette.accent, 0.14 * intensity));
    line.addColorStop(1, rgba(this.palette.accent, 0));
    ctx.fillStyle = line;
    ctx.fillRect(0, hitY - 1, this.width, 1.2);

    if (glow > 0.1) {
      const bloom = ctx.createLinearGradient(0, hitY - 90, 0, hitY);
      bloom.addColorStop(0, rgba(this.palette.accent, 0));
      bloom.addColorStop(0.72, rgba(this.palette.accent, 0.02 * glow));
      bloom.addColorStop(1, rgba(this.palette.accent, 0.14 * glow * intensity));
      ctx.fillStyle = bloom;
      ctx.fillRect(0, hitY - 90, this.width, 90);
    }

    ctx.restore();
  }

  _particleSprite(color) {
    let sprite = this.particleSprites.get(color);
    if (sprite) return sprite;

    sprite = document.createElement("canvas");
    sprite.width = 32;
    sprite.height = 32;
    const c = sprite.getContext("2d");
    const gradient = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.98)");
    gradient.addColorStop(0.16, rgba(color, 0.92));
    gradient.addColorStop(0.52, rgba(color, 0.35));
    gradient.addColorStop(1, rgba(color, 0));
    c.fillStyle = gradient;
    c.fillRect(0, 0, 32, 32);
    this.particleSprites.set(color, sprite);
    return sprite;
  }

  _drawParticles(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const ring of this.rings) {
      const progress = 1 - ring.life / ring.maxLife;
      ctx.beginPath();
      ctx.globalAlpha = (1 - progress) * 0.45;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = Math.max(0.5, 1.4 - progress * 0.8);
      ctx.ellipse(ring.x, ring.y, ring.radius, ring.radius * 0.45, 0, 0, TAU);
      ctx.stroke();
    }

    for (const particle of this.particles) {
      const progress = clamp(particle.life / particle.maxLife, 0, 1);
      const size = particle.size * (0.55 + progress * 0.45) * 4;
      ctx.globalAlpha = progress * 0.82;
      const sprite = this._particleSprite(particle.color);
      ctx.drawImage(sprite, particle.x - size / 2, particle.y - size / 2, size, size);
    }

    ctx.restore();
  }
}
