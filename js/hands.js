/* Stylized SVG guide hands that follow the active notes. */

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_WIDTH = 420;
const VIEW_HEIGHT = 335;
const CENTER_X = VIEW_WIDTH / 2;
const SIDE_SIGN = { L: 1, R: -1 };

const FINGER_GEOMETRY = [
  // thumb, index, middle, ring, pinky
  { baseX: 64, baseY: 158, restY: 236, activeY: 280, width: 26, sheen: 4.2, tip: 5, restOffset: 56, activeOffset: 76 },
  { baseX: 36, baseY: 194, restY: 276, activeY: 316, width: 22, sheen: 3.6, tip: 4.3, restOffset: 28, activeOffset: 38 },
  { baseX: 0, baseY: 200, restY: 286, activeY: 326, width: 23, sheen: 3.8, tip: 4.3, restOffset: 4, activeOffset: 2 },
  { baseX: -34, baseY: 196, restY: 280, activeY: 318, width: 20, sheen: 3.3, tip: 4.1, restOffset: -22, activeOffset: -30 },
  { baseX: -64, baseY: 186, restY: 256, activeY: 296, width: 17, sheen: 2.9, tip: 3.8, restOffset: -48, activeOffset: -64 },
];

function makeSvgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function smooth(current, target, speed, dt) {
  const amount = 1 - Math.exp(-speed * Math.min(dt, 0.05));
  return current + (target - current) * amount;
}

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class HandRig {
  constructor(side, layer, palette) {
    this.side = side;
    this.layer = layer;
    this.palette = palette;
    this.palmX = null;
    this.visible = false;
    this.lastActiveAt = -Infinity;
    this.fingers = FINGER_GEOMETRY.map((geometry, index) => ({
      ...geometry,
      worldX: null,
      localY: geometry.restY,
      active: false,
      note: null,
      index,
    }));

    this.svg = makeSvgElement("svg", {
      class: `guide-hand guide-hand--${side === "L" ? "left" : "right"}`,
      viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
      "aria-hidden": "true",
      focusable: "false",
    });

    this._build();
    layer.append(this.svg);
    this._measure();
  }

  _build() {
    this.fingerGroups = this.fingers.map((finger) => {
      const group = makeSvgElement("g", {
        class: `finger finger--${this.side === "L" ? "left" : "right"}`,
      });

      const body = makeSvgElement("path", {
        class: "finger__body",
        d: "",
      });
      const sheen = makeSvgElement("path", {
        class: "finger__sheen",
        "stroke-width": finger.sheen,
        d: "",
      });
      const knuckle = makeSvgElement("circle", {
        class: "finger__knuckle",
        cx: finger.baseX,
        cy: finger.baseY,
        r: finger.width * 0.22,
      });
      const tip = makeSvgElement("circle", {
        class: "finger__tip",
        cx: finger.baseX,
        cy: finger.restY,
        r: finger.tip,
      });

      group.append(body, sheen, knuckle, tip);
      this.svg.appendChild(group);
      finger.group = group;
      finger.bodyPath = body;
      finger.sheenPath = sheen;
      finger.knuckle = knuckle;
      finger.tipNode = tip;
      return group;
    });

    // The palm sits over the roots of the fingers so the fingers appear to
    // emerge from the knuckle line instead of floating like glow tubes.
    this.palm = makeSvgElement("path", {
      class: "guide-hand__palm",
      d: "M 166 78 C 166 55 182 42 210 42 C 238 42 254 55 254 78 L 264 104 C 274 126 278 152 276 174 C 272 199 246 208 210 208 C 174 208 148 199 144 174 C 142 152 146 126 156 104 Z",
    });
    this.svg.appendChild(this.palm);

    // Palm creases and knuckle grooves keep the soft silhouette from
    // reading as a featureless glove.
    this.creases = makeSvgElement("g", { class: "guide-hand__creases" });
    for (const d of [
      "M 172 110 C 188 126 232 128 248 108",
      "M 166 140 C 186 156 234 158 254 136",
      "M 260 203 C 258 195 255 190 251 185",
      "M 228 208 C 226 198 223 191 219 185",
      "M 194 208 C 193 198 191 191 188 185",
      "M 163 200 C 164 192 167 187 171 182",
    ]) {
      this.creases.appendChild(makeSvgElement("path", { class: "guide-hand__crease", d }));
    }
    this.svg.appendChild(this.creases);
  }

  _measure() {
    const rect = this.svg.getBoundingClientRect();
    const layerRect = this.layer.getBoundingClientRect();
    this.scale = rect.width > 0 ? rect.width / VIEW_WIDTH : 1;
    // Black keys are shorter, so their pressing point sits higher up the
    // keyboard. Lift the fingertip by the same distance in SVG units so a
    // finger lands on the black key instead of the white-key junction below.
    this.blackLift = clampValue((layerRect.height * 0.34) / (this.scale || 1), 32, 120);
  }

  setPalette(palette) {
    this.palette = palette;
  }

  setRestCenter(x) {
    this.restCenter = x;
    if (this.palmX === null) this.palmX = x;
  }

  reset() {
    this.palmX = this.restCenter ?? this.palmX;
    this.fingers.forEach((finger) => {
      finger.worldX = null;
      finger.note = null;
      finger.active = false;
      finger.group.classList.remove("is-active");
    });
    this.visible = false;
    this.svg.classList.remove("is-visible");
    this.lastActiveAt = -Infinity;
  }

  update(activeNotes, keyGeometry, dt, now) {
    if (this.palmX === null) this.palmX = this.restCenter || this.layer.clientWidth / 2;

    const notes = activeNotes
      .filter((note) => keyGeometry.has(note.midi))
      .sort((a, b) => a.midi - b.midi);

    const hasNotes = notes.length > 0;
    if (hasNotes) this.lastActiveAt = now;
    const shouldShow = hasNotes || now - this.lastActiveAt < 0.7;

    if (shouldShow !== this.visible) {
      this.visible = shouldShow;
      this.svg.classList.toggle("is-visible", shouldShow);
    }

    if (!shouldShow) return;

    let targetPalm = this.restCenter ?? this.palmX;
    if (hasNotes) {
      let sum = 0;
      for (const note of notes) sum += keyGeometry.get(note.midi).x;
      targetPalm = sum / notes.length;
    }

    this.palmX = smooth(this.palmX, targetPalm, hasNotes ? 10 : 4, dt);

    // Assign up to five notes to the physically ordered fingers.
    // Right hand: thumb is the lowest, pinky the highest.
    // Left hand mirrors that order.
    const maxFingers = Math.min(notes.length, 5);
    const selected = [];
    if (maxFingers > 0) {
      if (notes.length <= 5) {
        selected.push(...notes);
      } else {
        for (let i = 0; i < 5; i += 1) {
          const index = Math.round((i / 4) * (notes.length - 1));
          const note = notes[index];
          if (!selected.some((entry) => entry.id === note.id)) selected.push(note);
        }
      }
    }

    const assignments = new Map();
    selected.forEach((note, order) => {
      const fingerIndex = this.side === "L" ? 4 - order : order;
      assignments.set(fingerIndex, note);
    });

    this.fingers.forEach((finger, index) => {
      const note = assignments.get(index) || null;
      finger.note = note;
      const wasActive = finger.active;
      finger.active = Boolean(note);
      if (wasActive !== finger.active) finger.group.classList.toggle("is-active", finger.active);

      const side = SIDE_SIGN[this.side];
      let targetWorldX = this.palmX + finger.restOffset * side * (this.scale || 1);
      if (note) {
        const key = keyGeometry.get(note.midi);
        targetWorldX = key.x;
      }

      if (finger.worldX === null) finger.worldX = targetWorldX;
      finger.worldX = smooth(finger.worldX, targetWorldX, note ? 16 : 8, dt);

      const key = note ? keyGeometry.get(note.midi) : null;
      const targetY = note
        ? finger.activeY - (key?.isBlack ? this.blackLift || 0 : 0)
        : finger.restY;
      finger.localY = smooth(finger.localY, targetY, note ? 18 : 9, dt);

      const baseX = CENTER_X + finger.baseX * side;
      const tipX = CENTER_X + (finger.worldX - this.palmX) / (this.scale || 1);
      const tipY = finger.localY;
      const path = fingerPath(baseX, finger.baseY, tipX, tipY);
      finger.bodyPath.setAttribute("d", fingerOutlinePath(baseX, finger.baseY, tipX, tipY, finger.width, finger.width * 0.54));
      finger.sheenPath.setAttribute("d", path);
      finger.knuckle.setAttribute("cx", baseX);
      finger.tipNode.setAttribute("cx", tipX);
      finger.tipNode.setAttribute("cy", tipY);
      finger.tipNode.setAttribute("r", note ? finger.tip * 1.08 : finger.tip * 0.82);
    });

    this.svg.style.transform = `translate3d(${this.palmX.toFixed(2)}px, 0, 0) translateX(-50%)`;
  }

  hide() {
    this.visible = false;
    this.svg.classList.remove("is-visible");
  }
}

function fingerControls(baseX, baseY, tipX, tipY) {
  const dx = tipX - baseX;
  const dy = tipY - baseY;
  return {
    c1x: baseX + dx * 0.12,
    c1y: baseY + dy * 0.4,
    c2x: tipX - dx * 0.19,
    c2y: tipY - dy * 0.2,
  };
}

function pointOnCubic(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function fingerPath(baseX, baseY, tipX, tipY) {
  const { c1x, c1y, c2x, c2y } = fingerControls(baseX, baseY, tipX, tipY);
  return `M ${baseX.toFixed(2)} ${baseY.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${tipX.toFixed(2)} ${tipY.toFixed(2)}`;
}

// Build a tapered, rounded finger silhouette around the same curve used by
// the highlight. The outline is what keeps the hands from reading as glow
// tubes when they sit over the dark stage.
function fingerOutlinePath(baseX, baseY, tipX, tipY, baseWidth, tipWidth) {
  const p0 = [baseX, baseY];
  const controls = fingerControls(baseX, baseY, tipX, tipY);
  const cp1 = [controls.c1x, controls.c1y];
  const cp2 = [controls.c2x, controls.c2y];
  const p3 = [tipX, tipY];
  const steps = 12;
  const left = [];
  const right = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = pointOnCubic(t, p0, cp1, cp2, p3);
    const ahead = pointOnCubic(Math.min(1, t + 0.012), p0, cp1, cp2, p3);
    const behind = pointOnCubic(Math.max(0, t - 0.012), p0, cp1, cp2, p3);
    let nx = -(ahead[1] - behind[1]);
    let ny = ahead[0] - behind[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const width = baseWidth * (1 - t) ** 0.7 + tipWidth * (1 - (1 - t) ** 0.7);
    const half = width / 2;
    left.push([point[0] + nx * half, point[1] + ny * half]);
    right.push([point[0] - nx * half, point[1] - ny * half]);
  }

  const fmt = (point) => `${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
  const forward = left.map(fmt).join(" L ");
  const backward = right.reverse().map(fmt).join(" L ");
  return `M ${forward} L ${backward} Z`;
}

function findKeyNear(keyGeometry, midi) {
  let best = null;
  let bestDistance = Infinity;
  for (const key of keyGeometry.values()) {
    const distance = Math.abs(key.midi - midi);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best;
}

export class GuideHands {
  constructor(layer) {
    this.layer = layer;
    this.enabled = true;
    this.keyGeometry = new Map();
    this.palette = {
      accent: "#7ee7ff",
      accent2: "#b695ff",
      left: "#ff7fc5",
      leftB: "#ffac72",
      right: "#70e9ff",
      rightB: "#8f9dff",
    };
    this.left = new HandRig("L", layer, this.palette);
    this.right = new HandRig("R", layer, this.palette);
    this._nowSeconds = 0;
    this._lastUpdate = 0;
    this._observer = new ResizeObserver(() => {
      this.left._measure();
      this.right._measure();
    });
    this._observer.observe(layer);
  }

  setPalette(palette) {
    this.palette = { ...this.palette, ...palette };
    this.left.setPalette(this.palette);
    this.right.setPalette(this.palette);
  }

  setKeyGeometry(keys) {
    this.keyGeometry = new Map();
    for (const key of keys) this.keyGeometry.set(key.midi, key);
    const leftKey = findKeyNear(this.keyGeometry, 55);
    const rightKey = findKeyNear(this.keyGeometry, 71);
    if (leftKey) this.left.setRestCenter(leftKey.x);
    if (rightKey) this.right.setRestCenter(rightKey.x);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.layer.classList.toggle("is-disabled", !this.enabled);
    if (!this.enabled) {
      this.left.hide();
      this.right.hide();
    }
  }

  reset() {
    this.left.reset();
    this.right.reset();
    this._lastUpdate = 0;
  }

  update(activeNotes, dt) {
    if (!this.enabled || !this.keyGeometry.size) return;
    if (!activeNotes.length && !this.left.visible && !this.right.visible) return;

    const now = performance.now() / 1000;
    if (this._lastUpdate) {
      const elapsed = now - this._lastUpdate;
      // SVG path updates are comparatively costly. 40 fps still reads as
      // fluid for the soft guide hands and leaves headroom for the canvas.
      if (elapsed < 0.024) return;
    }
    const step = this._lastUpdate ? Math.max(0.001, now - this._lastUpdate) : dt;
    this._lastUpdate = now;

    const leftNotes = [];
    const rightNotes = [];
    for (const note of activeNotes) {
      if (note.hand === "L") leftNotes.push(note);
      else rightNotes.push(note);
    }

    this.left.update(leftNotes, this.keyGeometry, step, now);
    this.right.update(rightNotes, this.keyGeometry, step, now);
  }
}
