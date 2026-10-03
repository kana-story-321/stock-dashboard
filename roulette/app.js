import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const TAU = Math.PI * 2;
const POINTER_ANGLE = -Math.PI / 2; // 針は真上
const MAX_HISTORY = 50;
const MIN_ITEMS_TO_SPIN = 2;

const PALETTE = [
  "#ff4fa3", "#ffd23f", "#3fe0ff", "#3ff29b", "#a974ff", "#ff8a3d",
  "#ff5b5b", "#4f8bff", "#c6ff3f", "#ff3fe0", "#3fffd2", "#ffa3c8",
];

const TEMPLATES = [
  { name: "今日のランチ", items: ["ラーメン", "カレー", "寿司", "パスタ", "定食", "ハンバーガー", "うどん", "中華"] },
  { name: "罰ゲーム", items: ["モノマネ", "一発ギャグ", "変顔", "恥ずかしい話", "セーフ！", "全員にジュース"] },
  { name: "順番決め 1〜6", items: ["1", "2", "3", "4", "5", "6"] },
  { name: "今日の家事当番", items: ["掃除機", "皿洗い", "洗濯", "ゴミ出し", "買い出し", "お風呂掃除"] },
  { name: "YES / NO", items: ["YES", "NO"] },
  { name: "週末なにする？", items: ["映画", "カラオケ", "ボウリング", "おうちでゴロゴロ", "カフェ巡り", "公園"] },
];

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
const mod = (a, n) => ((a % n) + n) % n;

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#2a1145" : "#ffffff";
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + amt)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function makeItem(label, index) {
  return { id: uid(), label, color: PALETTE[index % PALETTE.length], weight: 1, excluded: false };
}

function makeRoulette(name, labels = []) {
  const now = Date.now();
  return {
    id: uid(),
    name,
    items: labels.map(makeItem),
    history: [],
    removeWinner: false,
    createdAt: now,
    updatedAt: now,
  };
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------
// バックエンド（Firebase / デモ用ローカル保存）
// ---------------------------------------------------------------------------
const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

async function createFirebaseBackend() {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  const provider = new authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const col = (u) => fsMod.collection(db, "users", u, "roulettes");

  return {
    onUser(cb) {
      authMod.getRedirectResult(auth).catch((e) => showLoginError(e));
      authMod.onAuthStateChanged(auth, (u) =>
        cb(u ? { uid: u.uid, name: u.displayName || u.email || "ユーザー", photo: u.photoURL || "" } : null));
    },
    async signIn() {
      try {
        await authMod.signInWithPopup(auth, provider);
      } catch (e) {
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
          await authMod.signInWithRedirect(auth, provider);
        } else {
          throw e;
        }
      }
    },
    signOut: () => authMod.signOut(auth),
    async list(u) {
      const snap = await fsMod.getDocs(col(u));
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    },
    save: (u, r) => fsMod.setDoc(fsMod.doc(col(u), r.id), r),
    remove: (u, id) => fsMod.deleteDoc(fsMod.doc(col(u), id)),
  };
}

function createLocalBackend() {
  const FLAG = "roulette:demo-login";
  const key = (u) => `roulette:v1:${u}`;
  let listener = () => {};
  const demoUser = { uid: "demo", name: "デモユーザー", photo: "" };
  const read = (u) => {
    try { return JSON.parse(localStorage.getItem(key(u))) || []; } catch { return []; }
  };
  const write = (u, list) => localStorage.setItem(key(u), JSON.stringify(list));
  return {
    onUser(cb) {
      listener = cb;
      let loggedIn = false;
      try { loggedIn = localStorage.getItem(FLAG) === "1"; } catch { /* ignore */ }
      cb(loggedIn ? demoUser : null);
    },
    async signIn() {
      try { localStorage.setItem(FLAG, "1"); } catch { /* ignore */ }
      listener(demoUser);
    },
    async signOut() {
      try { localStorage.removeItem(FLAG); } catch { /* ignore */ }
      listener(null);
    },
    async list(u) { return read(u); },
    async save(u, r) {
      const list = read(u).filter((x) => x.id !== r.id);
      list.push(r);
      write(u, list);
    },
    async remove(u, id) { write(u, read(u).filter((x) => x.id !== id)); },
  };
}

// ---------------------------------------------------------------------------
// サウンド
// ---------------------------------------------------------------------------
const sound = {
  enabled: true,
  ctx: null,
  lastTick: 0,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  tone(freq, start, dur, type = "triangle", vol = 0.12) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  },
  tick() {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastTick < 0.035) return;
    this.lastTick = now;
    this.tone(1400 + rand() * 200, now, 0.04, "square", 0.05);
  },
  start() {
    if (!this.enabled || !this.ensure()) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.35);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  },
  fanfare() {
    if (!this.enabled || !this.ensure()) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone(f, now + i * 0.11, 0.25, "triangle", 0.16));
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => this.tone(f, now + 0.5, 0.9, "triangle", 0.09));
  },
};

// ---------------------------------------------------------------------------
// 紙吹雪
// ---------------------------------------------------------------------------
const confetti = (() => {
  const canvas = $("#confetti");
  const ctx = canvas.getContext("2d");
  let parts = [];
  let running = false;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener("resize", resize);
  resize();
  function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.y < innerHeight + 40 && p.life > 0);
    for (const p of parts) {
      p.vy += 0.18;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.min(1, p.life / 40);
      if (p.circle) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)));
      }
      ctx.restore();
    }
    if (parts.length) requestAnimationFrame(frame);
    else running = false;
  }
  return {
    burst(colors) {
      const cols = colors.length ? colors : PALETTE;
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < 90; i++) {
          const fromLeft = side === 0;
          parts.push({
            x: fromLeft ? -10 : innerWidth + 10,
            y: innerHeight * (0.55 + rand() * 0.3),
            vx: (fromLeft ? 1 : -1) * (6 + rand() * 9),
            vy: -(9 + rand() * 9),
            w: 7 + rand() * 7, h: 10 + rand() * 8,
            rot: rand() * TAU, vr: (rand() - 0.5) * 0.4,
            color: cols[Math.floor(rand() * cols.length)],
            circle: rand() < 0.25,
            life: 200 + rand() * 80,
          });
        }
      }
      if (!running) {
        running = true;
        requestAnimationFrame(frame);
      }
    },
  };
})();

// ---------------------------------------------------------------------------
// ルーレット描画＆回転
// ---------------------------------------------------------------------------
const wheel = {
  canvas: $("#wheel"),
  ctx: $("#wheel").getContext("2d"),
  size: 0,
  rotation: 0,
  velocity: 0,
  phase: "idle", // idle | accel | cruise | decel
  stopRequested: false,
  decel: null,
  segments: [],
  winnerIndex: -1,
  pointerIndex: -1,
  lastTime: 0,
  onResult: null,

  setItems(items) {
    const active = items.filter((it) => !it.excluded && it.label.trim());
    const total = active.reduce((s, it) => s + it.weight, 0);
    let a = 0;
    this.segments = active.map((item) => {
      const span = (item.weight / total) * TAU;
      const seg = { item, start: a, end: a + span };
      a += span;
      return seg;
    });
    this.winnerIndex = -1;
    this.pointerIndex = this.indexAtPointer();
    this.draw();
  },

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const css = this.canvas.getBoundingClientRect().width || 500;
    this.size = Math.round(css * dpr);
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.draw();
  },

  indexAtPointer() {
    if (!this.segments.length) return -1;
    const rel = mod(POINTER_ANGLE - this.rotation, TAU);
    const i = this.segments.findIndex((s) => rel >= s.start && rel < s.end);
    return i === -1 ? this.segments.length - 1 : i;
  },

  draw() {
    const { ctx, size } = this;
    if (!size) return;
    const c = size / 2;
    const R = c;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(c, c);

    if (!this.segments.length) {
      const g = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
      g.addColorStop(0, "#3a1677");
      g.addColorStop(1, "#1d0b3d");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = `800 ${Math.round(R * 0.08)}px "M PLUS Rounded 1c", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("候補を追加してね", 0, R * 0.42);
      ctx.restore();
      return;
    }

    ctx.rotate(this.rotation);
    const n = this.segments.length;
    this.segments.forEach((seg, i) => {
      const color = seg.item.color;
      const grad = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R);
      grad.addColorStop(0, shade(color, 40));
      grad.addColorStop(1, shade(color, -25));
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, seg.start, seg.end);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      if (this.winnerIndex !== -1 && i !== this.winnerIndex) {
        ctx.fillStyle = "rgba(10,0,25,.55)";
        ctx.fill();
      }
      if (n > 1) {
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.lineWidth = Math.max(2, R * 0.008);
        ctx.stroke();
      }

      // ラベル
      const span = seg.end - seg.start;
      const mid = seg.start + span / 2;
      ctx.save();
      ctx.rotate(mid);
      const maxW = R * 0.62;
      const arcH = Math.sin(Math.min(span, Math.PI) / 2) * R * 0.75 * 2;
      let fontSize = Math.max(10, Math.min(R * 0.1, arcH * 0.55));
      ctx.font = `800 ${fontSize}px "M PLUS Rounded 1c", sans-serif`;
      let label = seg.item.label;
      while (ctx.measureText(label).width > maxW && fontSize > R * 0.055) {
        fontSize -= 1;
        ctx.font = `800 ${fontSize}px "M PLUS Rounded 1c", sans-serif`;
      }
      if (ctx.measureText(label).width > maxW) {
        while (label.length > 1 && ctx.measureText(label + "…").width > maxW) label = label.slice(0, -1);
        label += "…";
      }
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = textColorFor(color);
      ctx.shadowColor = "rgba(0,0,0,.25)";
      ctx.shadowBlur = R * 0.01;
      ctx.fillText(label, R * 0.9, 0);
      ctx.restore();
    });

    // 中心の光沢
    ctx.rotate(-this.rotation);
    const gloss = ctx.createLinearGradient(0, -R, 0, R);
    gloss.addColorStop(0, "rgba(255,255,255,.22)");
    gloss.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.fillStyle = gloss;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.restore();
  },

  get spinning() { return this.phase !== "idle"; },

  start() {
    if (this.spinning || this.segments.length < MIN_ITEMS_TO_SPIN) return false;
    this.winnerIndex = -1;
    this.stopRequested = false;
    this.phase = "accel";
    this.velocity = 0;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    return true;
  },

  stop() {
    if (this.phase === "accel") this.stopRequested = true;
    else if (this.phase === "cruise") this.beginDecel();
  },

  beginDecel() {
    // 当たりは止めた瞬間に重み付きランダムで決定し、そこに自然に止まるよう減速カーブを計算
    const total = this.segments.reduce((s, seg) => s + (seg.end - seg.start), 0);
    let r = rand() * total;
    let idx = this.segments.findIndex((seg) => (r -= seg.end - seg.start) < 0);
    if (idx === -1) idx = this.segments.length - 1;
    const seg = this.segments[idx];
    const span = seg.end - seg.start;
    const target = seg.start + span * (0.12 + rand() * 0.76);

    const v0 = Math.max(this.velocity, 4);
    const POWER = 4; // ease-out quart：最後にじわじわ止まる
    const desiredT = 4 + rand() * 2;
    const minDist = (v0 * desiredT) / POWER;
    const base = POINTER_ANGLE - target;
    const r0 = this.rotation;
    const k = Math.ceil((r0 + minDist - base) / TAU);
    const rf = base + k * TAU;
    const dist = rf - r0;
    this.decel = { r0, dist, duration: (POWER * dist) / v0, elapsed: 0, power: POWER, idx };
    this.phase = "decel";
  },

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const VMAX = TAU * 2.3;

    if (this.phase === "accel") {
      this.velocity = Math.min(VMAX, this.velocity + VMAX * dt * 1.6);
      this.rotation += this.velocity * dt;
      if (this.velocity >= VMAX) {
        this.phase = "cruise";
        if (this.stopRequested) this.beginDecel();
      }
    } else if (this.phase === "cruise") {
      // わずかにゆらぎを入れてライブ感を出す
      this.velocity = VMAX * (1 + Math.sin(now / 350) * 0.04);
      this.rotation += this.velocity * dt;
    } else if (this.phase === "decel") {
      const d = this.decel;
      d.elapsed += dt;
      const t = Math.min(1, d.elapsed / d.duration);
      const prev = this.rotation;
      this.rotation = d.r0 + d.dist * (1 - (1 - t) ** d.power);
      this.velocity = (this.rotation - prev) / (dt || 1 / 60);
      if (t >= 1) {
        this.rotation = mod(this.rotation, TAU);
        this.phase = "idle";
        this.velocity = 0;
        this.winnerIndex = d.idx;
        this.draw();
        this.onPointerChange?.(this.indexAtPointer(), false);
        this.onResult?.(this.segments[d.idx].item);
        return;
      }
    }

    const idx = this.indexAtPointer();
    if (idx !== this.pointerIndex) {
      this.pointerIndex = idx;
      this.onPointerChange?.(idx, true);
    }
    this.draw();
    requestAnimationFrame((t) => this.frame(t));
  },
};

// 周囲の電球
const bulbs = (() => {
  const wrap = $("#bulbs");
  const COUNT = 28;
  const els = [];
  for (let i = 0; i < COUNT; i++) {
    const b = document.createElement("span");
    b.className = "bulb";
    const a = (i / COUNT) * TAU;
    b.style.left = `${50 + Math.cos(a) * 47.2}%`;
    b.style.top = `${50 + Math.sin(a) * 47.2}%`;
    wrap.appendChild(b);
    els.push(b);
  }
  let mode = "idle";
  let celebrateUntil = 0;
  function loop(now) {
    const m = now < celebrateUntil ? "win" : mode;
    els.forEach((el, i) => {
      let on;
      if (m === "spin") on = (i + Math.floor(now / 60)) % 4 === 0;
      else if (m === "win") on = Math.floor(now / 120) % 2 === i % 2;
      else on = Math.floor(now / 700) % 2 === i % 2;
      el.classList.toggle("on", on);
    });
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return {
    set(m) { mode = m; },
    celebrate() { celebrateUntil = performance.now() + 3500; },
  };
})();

// ---------------------------------------------------------------------------
// アプリ状態
// ---------------------------------------------------------------------------
const state = {
  backend: null,
  user: null,
  roulettes: [],
  currentId: null,
};
const saveTimers = new Map();

const current = () => state.roulettes.find((r) => r.id === state.currentId);

function scheduleSave(r) {
  r.updatedAt = Date.now();
  $("#save-status").textContent = "保存中…";
  clearTimeout(saveTimers.get(r.id));
  saveTimers.set(r.id, setTimeout(() => persist(r), 600));
}

async function persist(r) {
  saveTimers.delete(r.id);
  try {
    await state.backend.save(state.user.uid, JSON.parse(JSON.stringify(r)));
    if (!saveTimers.size) $("#save-status").textContent = "保存しました ✓";
  } catch (e) {
    console.error(e);
    $("#save-status").textContent = "保存に失敗しました";
    toast("保存に失敗しました。通信状況を確認してください");
  }
}

function flushSaves() {
  for (const [id, timer] of saveTimers) {
    clearTimeout(timer);
    const r = state.roulettes.find((x) => x.id === id);
    if (r) persist(r);
  }
}

async function loadRoulettes() {
  let list = await state.backend.list(state.user.uid);
  list = list.map(normalizeRoulette).sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) {
    const first = makeRoulette(TEMPLATES[0].name, TEMPLATES[0].items);
    list.push(first);
    await state.backend.save(state.user.uid, first);
  }
  state.roulettes = list;
  state.currentId = list[0].id;
}

function normalizeRoulette(r) {
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "ルーレット",
    items: Array.isArray(r.items) ? r.items.map((it, i) => ({
      id: it.id || uid(),
      label: String(it.label ?? ""),
      color: /^#[0-9a-f]{6}$/i.test(it.color) ? it.color : PALETTE[i % PALETTE.length],
      weight: Math.min(10, Math.max(1, Number(it.weight) || 1)),
      excluded: Boolean(it.excluded),
    })) : [],
    history: Array.isArray(r.history) ? r.history.slice(0, MAX_HISTORY) : [],
    removeWinner: Boolean(r.removeWinner),
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 描画（DOM）
// ---------------------------------------------------------------------------
function renderAll() {
  renderList();
  renderEditor();
  renderHistory();
  refreshWheel();
}

function refreshWheel() {
  const r = current();
  wheel.setItems(r ? r.items : []);
  updateControls();
  updateCurrentLabel(wheel.pointerIndex);
}

function miniWheelBg(items) {
  const act = items.filter((it) => !it.excluded && it.label.trim());
  if (!act.length) return "#3a1677";
  const step = 360 / act.length;
  return `conic-gradient(${act.map((it, i) => `${it.color} ${i * step}deg ${(i + 1) * step}deg`).join(",")})`;
}

function renderList() {
  const ul = $("#roulette-list");
  ul.replaceChildren();
  for (const r of state.roulettes) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = r.id === state.currentId ? "active" : "";
    const mini = document.createElement("span");
    mini.className = "mini-wheel";
    mini.style.background = miniWheelBg(r.items);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = r.name || "（無題）";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${r.items.length}件`;
    btn.append(mini, name, count);
    btn.addEventListener("click", () => selectRoulette(r.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderEditor() {
  const r = current();
  if (!r) return;
  $("#roulette-title").value = r.name;
  $("#remove-winner").checked = r.removeWinner;
  const ul = $("#item-list");
  ul.replaceChildren();
  if (!r.items.length) {
    const p = document.createElement("li");
    p.className = "empty-note";
    p.textContent = "まだ候補がありません。上の入力欄から追加してください。";
    ul.appendChild(p);
  }
  r.items.forEach((it) => {
    const li = document.createElement("li");
    if (it.excluded) li.classList.add("excluded");

    const color = document.createElement("input");
    color.type = "color";
    color.value = it.color;
    color.title = "色を変更";
    color.addEventListener("input", () => { it.color = color.value; changed({ list: true }); });

    const label = document.createElement("input");
    label.className = "item-label";
    label.value = it.label;
    label.maxLength = 40;
    label.addEventListener("input", () => { it.label = label.value; changed({ list: false }); });
    label.addEventListener("change", () => {
      it.label = label.value.trim();
      label.value = it.label;
      changed({ list: true });
    });

    const weight = document.createElement("label");
    weight.className = "weight";
    weight.title = "当たりやすさ（1〜10）";
    const w = document.createElement("input");
    w.type = "number";
    w.min = "1";
    w.max = "10";
    w.value = String(it.weight);
    w.addEventListener("change", () => {
      it.weight = Math.min(10, Math.max(1, Math.round(Number(w.value)) || 1));
      w.value = String(it.weight);
      changed({ list: false });
    });
    weight.append("×", w);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "item-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", `${it.label} を削除`);
    del.addEventListener("click", () => {
      r.items = r.items.filter((x) => x.id !== it.id);
      changed({ list: true, editor: true });
    });

    li.append(color, label, weight, del);
    ul.appendChild(li);
  });
}

function renderHistory() {
  const r = current();
  const ol = $("#history-list");
  ol.replaceChildren();
  if (!r || !r.history.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.style.listStyle = "none";
    li.textContent = "まだ履歴はありません";
    ol.appendChild(li);
    return;
  }
  for (const h of r.history) {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = h.label;
    const time = document.createElement("time");
    const d = new Date(h.at);
    time.dateTime = d.toISOString();
    time.textContent = d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    li.append(strong, time);
    ol.appendChild(li);
  }
}

function changed({ list = false, editor = false } = {}) {
  const r = current();
  if (!r) return;
  scheduleSave(r);
  if (editor) renderEditor();
  if (list) renderList();
  refreshWheel();
}

function updateControls() {
  const r = current();
  const activeCount = r ? r.items.filter((it) => !it.excluded && it.label.trim()).length : 0;
  const spinning = wheel.spinning;
  const canStart = !spinning && activeCount >= MIN_ITEMS_TO_SPIN;
  $("#start-btn").disabled = !canStart;
  $("#stop-btn").disabled = !spinning || wheel.phase === "decel" || wheel.stopRequested;
  const hub = $("#hub");
  hub.textContent = spinning ? "STOP" : "GO";
  hub.disabled = spinning ? $("#stop-btn").disabled : !canStart;
  document.body.classList.toggle("is-spinning", spinning);
  for (const el of document.querySelectorAll(".editor input, .editor button, .editor textarea, .sidebar button, #roulette-title, #remove-winner")) {
    el.disabled = spinning;
  }
  if (!spinning && activeCount < MIN_ITEMS_TO_SPIN) {
    $("#current-label").textContent = activeCount === 0 ? "候補を追加してね" : "候補は2つ以上必要です";
  }
}

function updateCurrentLabel(idx) {
  const r = current();
  const activeCount = r ? r.items.filter((it) => !it.excluded && it.label.trim()).length : 0;
  if (activeCount < MIN_ITEMS_TO_SPIN) return;
  const seg = wheel.segments[idx];
  $("#current-label").textContent = seg ? seg.item.label : " ";
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------
function selectRoulette(id) {
  if (wheel.spinning) return;
  state.currentId = id;
  wheel.rotation = 0;
  renderAll();
  $("#sidebar").classList.remove("open");
}

function addRoulette(r) {
  state.roulettes.push(r);
  scheduleSave(r);
  selectRoulette(r.id);
  return r;
}

function startSpin() {
  sound.ensure();
  if (!wheel.start()) return;
  sound.start();
  bulbs.set("spin");
  $("#wheel-wrap").classList.add("spinning");
  updateControls();
}

function stopSpin() {
  if (!wheel.spinning) return;
  wheel.stop();
  updateControls();
}

wheel.onPointerChange = (idx, spinning) => {
  updateCurrentLabel(idx);
  if (!spinning) return;
  sound.tick();
  const p = $("#pointer");
  p.classList.remove("tick");
  void p.offsetWidth;
  p.classList.add("tick");
};

wheel.onResult = (item) => {
  const r = current();
  bulbs.set("idle");
  bulbs.celebrate();
  $("#wheel-wrap").classList.remove("spinning");
  sound.fanfare();
  confetti.burst([item.color, "#ffd23f", "#ffffff", "#ff4fa3", "#3fe0ff"]);
  $("#result-text").textContent = item.label;
  $("#result-modal").hidden = false;
  $("#again-btn").focus();

  if (r) {
    r.history.unshift({ label: item.label, at: Date.now() });
    r.history = r.history.slice(0, MAX_HISTORY);
    if (r.removeWinner) {
      const it = r.items.find((x) => x.id === item.id);
      if (it) it.excluded = true;
    }
    scheduleSave(r);
    renderHistory();
  }
  updateControls();
};

function closeResult() {
  $("#result-modal").hidden = true;
  const r = current();
  if (r && r.removeWinner) {
    // 当たりを外したので盤面を作り直す
    renderEditor();
    renderList();
    refreshWheel();
  }
}

function addItems(labels, replace = false) {
  const r = current();
  if (!r) return;
  const clean = labels.map((s) => s.trim().slice(0, 40)).filter(Boolean);
  if (replace) r.items = [];
  const room = 200 - r.items.length;
  clean.slice(0, room).forEach((label) => r.items.push(makeItem(label, r.items.length)));
  if (clean.length > room) toast("候補は200件までです");
  changed({ list: true, editor: true });
}

function bindEvents() {
  $("#start-btn").addEventListener("click", startSpin);
  $("#stop-btn").addEventListener("click", stopSpin);
  $("#hub").addEventListener("click", () => (wheel.spinning ? stopSpin() : startSpin()));

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SUMMARY") return;
    if (!$("#app-view").hidden && $("#result-modal").hidden) {
      e.preventDefault();
      wheel.spinning ? stopSpin() : startSpin();
    }
  });

  $("#again-btn").addEventListener("click", () => { closeResult(); startSpin(); });
  $("#close-modal").addEventListener("click", closeResult);
  $("#result-modal").addEventListener("click", (e) => { if (e.target.id === "result-modal") closeResult(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#result-modal").hidden) closeResult(); });

  $("#add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#add-input");
    if (!input.value.trim()) return;
    addItems([input.value]);
    input.value = "";
    input.focus();
  });
  $("#bulk-append").addEventListener("click", () => {
    addItems($("#bulk-input").value.split(/\r?\n/));
    $("#bulk-input").value = "";
  });
  $("#bulk-replace").addEventListener("click", () => {
    const lines = $("#bulk-input").value.split(/\r?\n/).filter((s) => s.trim());
    if (!lines.length) return toast("候補を入力してください");
    if (!confirm("今の候補をすべて置き換えますか？")) return;
    addItems(lines, true);
    $("#bulk-input").value = "";
  });

  $("#roulette-title").addEventListener("input", (e) => {
    const r = current();
    if (!r) return;
    r.name = e.target.value.slice(0, 40);
    scheduleSave(r);
    renderList();
  });
  $("#remove-winner").addEventListener("change", (e) => {
    const r = current();
    if (!r) return;
    r.removeWinner = e.target.checked;
    scheduleSave(r);
  });

  $("#new-roulette").addEventListener("click", () => {
    const r = addRoulette(makeRoulette(`新しいルーレット ${state.roulettes.length + 1}`));
    $("#roulette-title").select();
    return r;
  });
  $("#duplicate-roulette").addEventListener("click", () => {
    const src = current();
    if (!src) return;
    const copy = makeRoulette(`${src.name} のコピー`.slice(0, 40));
    copy.items = src.items.map((it) => ({ ...it, id: uid(), excluded: false }));
    copy.removeWinner = src.removeWinner;
    addRoulette(copy);
    toast("複製しました");
  });
  $("#delete-roulette").addEventListener("click", async () => {
    const r = current();
    if (!r || !confirm(`「${r.name}」を削除しますか？`)) return;
    clearTimeout(saveTimers.get(r.id));
    saveTimers.delete(r.id);
    state.roulettes = state.roulettes.filter((x) => x.id !== r.id);
    try {
      await state.backend.remove(state.user.uid, r.id);
    } catch (e) {
      console.error(e);
      toast("削除に失敗しました");
    }
    if (!state.roulettes.length) addRoulette(makeRoulette("新しいルーレット"));
    else selectRoulette(state.roulettes[0].id);
    toast("削除しました");
  });
  $("#shuffle-colors").addEventListener("click", () => {
    const r = current();
    if (!r) return;
    const offset = Math.floor(rand() * PALETTE.length);
    const shuffled = [...PALETTE].sort(() => rand() - 0.5);
    r.items.forEach((it, i) => { it.color = shuffled[(i + offset) % shuffled.length]; });
    changed({ list: true, editor: true });
  });
  $("#restore-items").addEventListener("click", () => {
    const r = current();
    if (!r) return;
    const n = r.items.filter((it) => it.excluded).length;
    if (!n) return toast("外した候補はありません");
    r.items.forEach((it) => { it.excluded = false; });
    changed({ list: true, editor: true });
    toast(`${n}件の候補を戻しました`);
  });
  $("#clear-history").addEventListener("click", () => {
    const r = current();
    if (!r || !r.history.length || !confirm("履歴をクリアしますか？")) return;
    r.history = [];
    scheduleSave(r);
    renderHistory();
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("#panel-items").hidden = tab.dataset.tab !== "items";
      $("#panel-history").hidden = tab.dataset.tab !== "history";
    });
  }

  const tl = $("#template-list");
  for (const t of TEMPLATES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t.name;
    b.addEventListener("click", () => { addRoulette(makeRoulette(t.name, t.items)); toast(`「${t.name}」を作成しました`); });
    tl.appendChild(b);
  }

  $("#menu-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  document.addEventListener("click", (e) => {
    const sb = $("#sidebar");
    if (sb.classList.contains("open") && !sb.contains(e.target) && e.target.id !== "menu-toggle") sb.classList.remove("open");
  });

  $("#sound-toggle").addEventListener("click", (e) => {
    sound.enabled = !sound.enabled;
    e.currentTarget.textContent = sound.enabled ? "🔊" : "🔇";
    try { localStorage.setItem("roulette:sound", sound.enabled ? "1" : "0"); } catch { /* ignore */ }
  });
  try {
    if (localStorage.getItem("roulette:sound") === "0") {
      sound.enabled = false;
      $("#sound-toggle").textContent = "🔇";
    }
  } catch { /* ignore */ }

  $("#logout").addEventListener("click", async () => {
    if (wheel.spinning) return;
    flushSaves();
    await state.backend.signOut();
  });

  addEventListener("resize", () => wheel.resize());
  addEventListener("beforeunload", flushSaves);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSaves(); });
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------
function showLoginError(e) {
  if (!e) return;
  console.error(e);
  const map = {
    "auth/popup-closed-by-user": "",
    "auth/cancelled-popup-request": "",
    "auth/unauthorized-domain": "このドメインは Firebase の承認済みドメインに登録されていません。",
    "auth/network-request-failed": "通信エラーが発生しました。",
  };
  $("#login-error").textContent = e.code in map ? map[e.code] : "ログインに失敗しました。もう一度お試しください。";
}

function showView(name) {
  $("#loading").hidden = true;
  $("#login-view").hidden = name !== "login";
  $("#app-view").hidden = name !== "app";
}

async function onUser(user) {
  state.user = user;
  if (!user) {
    state.roulettes = [];
    state.currentId = null;
    showView("login");
    return;
  }
  $("#loading").hidden = false;
  try {
    await loadRoulettes();
  } catch (e) {
    console.error(e);
    $("#loading").hidden = true;
    showView("login");
    $("#login-error").textContent = "データの読み込みに失敗しました。Firestore の設定を確認してください。";
    return;
  }
  $("#user-name").textContent = user.name;
  const avatar = $("#user-avatar");
  if (user.photo) avatar.src = user.photo;
  else avatar.removeAttribute("src");
  showView("app");
  wheel.resize();
  renderAll();
}

async function main() {
  bindEvents();
  if (isFirebaseConfigured) {
    try {
      state.backend = await createFirebaseBackend();
    } catch (e) {
      console.error(e);
      showView("login");
      $("#login-error").textContent = "Firebase の読み込みに失敗しました。";
      $("#google-login").disabled = true;
      return;
    }
  } else {
    state.backend = createLocalBackend();
    $("#setup-notice").hidden = false;
    $("#google-login").disabled = true;
    $("#demo-login").addEventListener("click", () => state.backend.signIn());
  }

  $("#google-login").addEventListener("click", async () => {
    $("#login-error").textContent = "";
    try {
      await state.backend.signIn();
    } catch (e) {
      showLoginError(e);
    }
  });

  if (document.fonts?.ready) document.fonts.ready.then(() => wheel.draw());
  state.backend.onUser(onUser);
}

main();
