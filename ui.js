import {
  initialState,
  pieceToGlyph,
  generatePseudoLegalMoves,
  expandWithPortalOutcomes,
  applyResolvedMove,
  isSquareAttacked,
  filterLegalByCheck,
  SOUND_FILES,
} from "./engine.js";

import { getBestMove } from "./ai.js";

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");

const modeSelect = document.getElementById("modeSelect");
const aiColorSelect = document.getElementById("aiColorSelect");
const aiDepthInput = document.getElementById("aiDepthInput");
const suggestBtn = document.getElementById("suggestBtn");
const applySuggestionBtn = document.getElementById("applySuggestionBtn");
const resetBtn = document.getElementById("resetBtn");
const flipBtn = document.getElementById("flipBtn");
const aiColorLabel = document.getElementById("aiColorLabel");
const aiDepthLabel = document.getElementById("aiDepthLabel");

const FILES = "ABCDEFGH".split("");
const RANKS = "12345678".split("");
// Path to local SVG piece set (use absolute path so deep-linking to /play/:id
// still resolves images from site root). Place cburnett SVGs under this folder
// with names like 'wP.svg', 'bK.svg', etc.
const PIECE_IMG_PATH = "/pieces/cburnett";

// Inject minimal CSS for portal selection overlay/highlights (kept local so
// edits don't require changes to styles.css).
(function injectPortalStyles(){
  const css = `
  .portal-active .square { opacity: 0.35; transition: opacity .18s ease; }
  .portal-active .square.portal-selectable { opacity: 1 !important; pointer-events: auto; box-shadow: 0 0 18px rgba(80,180,255,0.9); border-radius:6px; animation: portal-pulse 1.2s infinite; }
  @keyframes portal-pulse { 0% { box-shadow: 0 0 6px rgba(80,180,255,0.6); } 50% { box-shadow: 0 0 20px rgba(80,180,255,0.95); } 100% { box-shadow: 0 0 6px rgba(80,180,255,0.6); } }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
})();

// --- Audio synthesis (small inlined WebAudio helper, no external files) ---
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
}
function playTone(freq, type = 'sine', dur = 0.12, vol = 0.08, nowOffset = 0) {
  if (typeof window === 'undefined') return;
  ensureAudio();
  if (!audioCtx) return;
  const now = audioCtx.currentTime + nowOffset;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  try {
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  } catch (e) {
    // ignore audio errors silently
  }
}

function playSoundForResolved(resolved, afterState) {
  try {
    ensureAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const via = resolved && resolved.viaPortal;
    const kind = resolved && resolved.kind;

    // Prefer sample playback if available (loaded by loadAudioAssets)
    const sampleKey = (kind === 'promotion') ? 'promotion'
      : (kind === 'capture' || (via && via.swapped)) ? 'capture'
      : (via) ? 'portal'
      : (kind === 'castle') ? 'castle'
      : 'move';

    if (audioBuffers && audioBuffers[sampleKey]) {
      playBuffer(audioBuffers[sampleKey]);
    } else {
      // fallback to synthesized tones if samples missing
      if (kind === 'promotion') {
        playTone(1100, 'sine', 0.12, 0.09);
        playTone(1500, 'sine', 0.12, 0.07, 0.06);
      } else if (kind === 'capture' || (via && via.swapped)) {
        playTone(700, 'sawtooth', 0.16, 0.12);
        playTone(420, 'sine', 0.18, 0.08, 0.02);
      } else if (via) {
        playTone(880, 'triangle', 0.18, 0.09);
        playTone(1320, 'sine', 0.12, 0.06, 0.04);
      } else if (kind === 'castle') {
        playTone(720, 'square', 0.14, 0.08);
      } else {
        playTone(920, 'sine', 0.12, 0.07);
      }
    }

    // If the move left the opponent in check, play a short staccato indicator
    if (afterState) {
      try {
        const opponent = afterState.turn;
        if (inCheck(afterState, opponent)) {
          // prefer check sample when present
          if (audioBuffers && audioBuffers.check) playBuffer(audioBuffers.check);
          else playTone(1600, 'sine', 0.06, 0.12, 0.04);
        }
      } catch (e) { /* ignore check-detection errors */ }
    }
  } catch (e) {
    // swallow audio errors to avoid breaking game flow
  }
}

let audioBuffers = {};

function playBuffer(buffer) {
  if (!audioCtx || !buffer) return;
  try {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const g = audioCtx.createGain();
    g.gain.value = 0.9;
    src.connect(g); g.connect(audioCtx.destination);
    src.start();
  } catch (e) {
    // ignore
  }
}

async function loadAudioAssets() {
  ensureAudio();
  if (!audioCtx) return;
  const entries = Object.entries(SOUND_FILES);
  for (const [key, path] of entries) {
    try {
      const resp = await fetch(path, { cache: 'force-cache' });
      if (!resp.ok) throw new Error('Not found');
      const ab = await resp.arrayBuffer();
      const buf = await audioCtx.decodeAudioData(ab.slice(0));
      audioBuffers[key] = buf;
      console.log(`Loaded audio asset: ${key} <- ${path}`);
    } catch (e) {
      console.warn(`Audio asset not available: ${path} (${e && e.message})`);
    }
  }
}

// Portal selection runtime state (null when inactive)
let portalSelection = null;
// Track the most recent move applied in the UI. Shape: { from: 'E2', to: 'E4' } (upper-case)
let lastMove = null;

function enablePortalSelection(outcomes, baseMoves) {
  // Only enable when outcomes are portal outcomes and the originating base move
  // wasn't a capture. Guarded by callers, but double-check here.
  if (!outcomes || outcomes.length === 0) return false;
  if (baseMoves && baseMoves.some(m => m.kind === 'capture')) return false;
  if (!outcomes.every(o => o.viaPortal)) return false;

  // Unique destination squares to present as choices
  const dests = [...new Set(outcomes.map(o => (o.toFinal || o.to || '').toUpperCase()))];
  const allowed = new Set(dests);

  // Mark board as portal-active
  document.body.classList.add('has-portal-selection');
  boardEl.classList.add('portal-active');

  // Add portal-selectable class to allowed squares, dim others handled by CSS
  const sqEls = boardEl.querySelectorAll('.square');
  sqEls.forEach(el => {
    const s = el.dataset.sq;
    if (allowed.has(s)) {
      el.classList.add('portal-selectable');
    } else {
      el.classList.remove('portal-selectable');
    }
  });

  portalSelection = { allowed, outcomes, cleanup: disablePortalSelection };
  return true;
}

function disablePortalSelection() {
  portalSelection = null;
  boardEl.classList.remove('portal-active');
  document.body.classList.remove('has-portal-selection');
  const sqEls = boardEl.querySelectorAll('.square');
  sqEls.forEach(el => el.classList.remove('portal-selectable'));
}

let state = initialState();
let selectedSq = null;
let legalTargets = new Set();
let suggestion = null; // suggested resolved move (not applied)
let mode = modeSelect.value; // 'hotseat' | 'vs-ai' | 'analyze'
let aiColor = aiColorSelect.value; // 'w'|'b'
let aiDepth = parseInt(aiDepthInput.value, 10) || 3;
let __dev_safety_wrapper_installed = true; // marker

// Board orientation: false = white at bottom (default), true = flipped (black at bottom)
let boardFlipped = false;
try {
  const saved = localStorage.getItem('boardFlipped');
  if (saved === 'true' || saved === 'false') boardFlipped = saved === 'true';
} catch (e) {}

// --- Online (Socket.io) state ---
let socket = null;
let onlineRoomId = null;
let onlineColor = null; // 'w' or 'b'
let isHost = false;
let onlinePanel = null;

// Rehydrate server-sent state to the client's expected shapes (Sets for portals)
function hydrateState(srvState) {
  if (!srvState) return srvState;
  const s = typeof structuredClone === 'function' ? structuredClone(srvState) : JSON.parse(JSON.stringify(srvState));
  try {
    if (s.portals) {
      // If portals.white/black arrived as arrays or plain objects, convert to Set
      if (!s.portals.white || typeof s.portals.white.has !== 'function') {
        try { s.portals.white = new Set(Array.isArray(s.portals.white) ? s.portals.white.map(x => (x||'').toUpperCase()) : Object.keys(s.portals.white || {})); } catch(e) { s.portals.white = new Set(); }
      }
      if (!s.portals.black || typeof s.portals.black.has !== 'function') {
        try { s.portals.black = new Set(Array.isArray(s.portals.black) ? s.portals.black.map(x => (x||'').toUpperCase()) : Object.keys(s.portals.black || {})); } catch(e) { s.portals.black = new Set(); }
      }
      // neutralPairs may be an array of pairs; keep as-is
      if (!Array.isArray(s.portals.neutralPairs)) s.portals.neutralPairs = s.portals.neutralPairs || [];
    }
  } catch (e) {
    // if anything goes wrong, return the server state as-is
    return srvState;
  }
  // If hydration produced empty portal sets (because server serialized Sets
  // into plain objects), fall back to the client's engine default portal map
  // so UI helpers like .has() behave correctly.
  try {
    const defaults = initialState().portals || {};
    if (s.portals) {
      if (s.portals.white && s.portals.white.size === 0 && defaults.white) s.portals.white = defaults.white;
      if (s.portals.black && s.portals.black.size === 0 && defaults.black) s.portals.black = defaults.black;
      if (!s.portals.neutralPairs || s.portals.neutralPairs.length === 0) s.portals.neutralPairs = defaults.neutralPairs || [];
    }
  } catch (e) { /* ignore fallback errors */ }
  return s;
}

function isLight(fileIdx, rankIdx) { return (fileIdx + rankIdx) % 2 === 1; }
function sq(fileIdx, rankIdx) { return `${FILES[fileIdx]}${RANKS[rankIdx]}`; }

function isWhitePortal(sqStr) { return state.portals.white?.has(sqStr.toUpperCase()); }
function isBlackPortal(sqStr) { return state.portals.black?.has(sqStr.toUpperCase()); }
function isNeutralPortal(sqStr) {
  return state.portals.neutralPairs.some(([a,b]) => a===sqStr.toUpperCase() || b===sqStr.toUpperCase());
}

function clearSuggestion() { suggestion = null; render(); }

function render() {
  boardEl.innerHTML = "";
  if (!boardFlipped) {
    // White at bottom (default): render rows top->bottom (r=7..0), files left->right (f=0..7)
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
        const fIdx = f, rIdx = r;
        const s = sq(fIdx, rIdx);
        const su = s.toUpperCase();
        const div = document.createElement("div");
        div.className = `square ${isLight(fIdx,rIdx) ? "light" : "dark"}`;
        // expose square id for portal-selection wiring
        div.dataset.sq = su;
        // compute index for board access early
        const idx = FILES.indexOf(su[0]) + 8 * RANKS.indexOf(su[1]);
      const piece = state.board[idx];

      // Portal coloring and cooldown hint
      if (isWhitePortal(su)) {
        div.classList.add("portal-white");
        // add a richer portal visual overlay (sparkles + ring)
        const p = document.createElement('div');
        p.className = 'portal-visual portal-white';
        // create spark particles
        for (let si = 0; si < 12; si++) {
          const spark = document.createElement('i');
          const angle = Math.random() * 360;
          const dist = 10 + Math.random() * 26;
          const delay = (Math.random() * -3).toFixed(2) + 's';
          spark.style.setProperty('--angle', angle + 'deg');
          spark.style.setProperty('--dist', dist + 'px');
          spark.style.setProperty('--delay', delay);
          p.appendChild(spark);
        }
        div.appendChild(p);
      } else if (isBlackPortal(su)) {
        div.classList.add("portal-black");
        const p = document.createElement('div');
        p.className = 'portal-visual portal-black';
        for (let si = 0; si < 12; si++) {
          const spark = document.createElement('i');
          const angle = Math.random() * 360;
          const dist = 10 + Math.random() * 26;
          const delay = (Math.random() * -3).toFixed(2) + 's';
          spark.style.setProperty('--angle', angle + 'deg');
          spark.style.setProperty('--dist', dist + 'px');
          spark.style.setProperty('--delay', delay);
          p.appendChild(spark);
        }
        div.appendChild(p);
      } else if (isNeutralPortal(su)) {
        div.classList.add("portal-neutral");
        const p = document.createElement('div');
        p.className = 'portal-visual portal-neutral';
        for (let si = 0; si < 10; si++) {
          const spark = document.createElement('i');
          const angle = Math.random() * 360;
          const dist = 8 + Math.random() * 22;
          const delay = (Math.random() * -3).toFixed(2) + 's';
          spark.style.setProperty('--angle', angle + 'deg');
          spark.style.setProperty('--dist', dist + 'px');
          spark.style.setProperty('--delay', delay);
          p.appendChild(spark);
        }
        div.appendChild(p);
        // Show visual cooldown hint if neutralSwapCooldown blocks the owning player
        if (state.neutralSwapCooldown) {
          // If the piece on this square belongs to a player with cooldown, dim the portal
          if (piece && state.neutralSwapCooldown[piece.color]) {
            div.classList.add("cooldown");
            // also add a subtle lock icon overlay to make the restriction obvious
            const lock = document.createElement("span");
            lock.className = "cooldown-lock";
            lock.textContent = "🔒";
            // inline styling to avoid requiring a separate CSS change
            lock.style.position = "absolute";
            lock.style.right = "4px";
            lock.style.top = "4px";
            lock.style.fontSize = "14px";
            lock.style.lineHeight = "1";
            lock.style.pointerEvents = "none";
            lock.style.opacity = "0.9";
            lock.title = "Neutral portal temporarily disabled for this player";
            div.appendChild(lock);
          }
        }
      }

      if (selectedSq === s || legalTargets.has(s)) div.classList.add("highlight");

      // last-move overlay: highlight origin and destination of the most recent move
      if (lastMove) {
        const lu = lastMove.from && lastMove.from.toUpperCase();
        const ld = lastMove.to && lastMove.to.toUpperCase();
        if (su === lu || su === ld) div.classList.add('last-move');
      }

      // show suggestion target highlight
      if (suggestion) {
        const dest = (suggestion.toFinal || suggestion.to).toUpperCase();
        if (dest === su) div.classList.add("suggest");
      }

      // Draw piece
      if (piece) {
        // If the browser is offline (or dev server unreachable), avoid setting
        // img.src which triggers network requests that will fail and spam the
        // console. Instead render the glyph fallback directly. When online we
        // try the nicer SVG set and fall back to glyph on error.
        if (!navigator.onLine) {
          const span = document.createElement('span');
          span.className = `piece piece-${piece.color}`;
          span.textContent = pieceToGlyph(piece);
          div.appendChild(span);
        } else {
          const img = document.createElement('img');
          img.className = `piece piece-${piece.color}`;
          // Example filename: pieces/cburnett/wP.svg
          const fileName = `${piece.color}${piece.type}.svg`;
          img.src = `${PIECE_IMG_PATH}/${fileName}`;
          img.alt = `${piece.color}${piece.type}`;
          // Make the image fill the square nicely
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.display = 'block';
          img.style.pointerEvents = 'none';

          // Fallback: if SVG not available, replace image with glyph span
          img.addEventListener('error', () => {
            const span = document.createElement('span');
            span.className = `piece piece-${piece.color}`;
            span.textContent = pieceToGlyph(piece);
            const coordsEl = div.querySelector('.coords');
            if (coordsEl) div.insertBefore(span, coordsEl);
            else div.appendChild(span);
            img.remove();
          });

          div.appendChild(img);
        }
      }

      const coords = document.createElement("div");
      coords.className = "coords";
      coords.textContent = s.toLowerCase();
      div.appendChild(coords);

        div.addEventListener("click", () => onSquareClick(s));
        boardEl.appendChild(div);
      }
    }
  } else {
    // Flipped: render rows top->bottom as seen by a black player rotated 180deg.
    // Iterate ranks 0..7 and files 7..0 so that top-left becomes H1 and bottom-left becomes H8
    for (let r = 0; r < 8; r++) {
      for (let f = 7; f >= 0; f--) {
        const fIdx = f, rIdx = r;
        const s = sq(fIdx, rIdx);
        const su = s.toUpperCase();
        const div = document.createElement("div");
        div.className = `square ${isLight(fIdx,rIdx) ? "light" : "dark"}`;
        div.dataset.sq = su;

        const idx = FILES.indexOf(su[0]) + 8 * RANKS.indexOf(su[1]);
        const piece = state.board[idx];

        // Portal coloring and cooldown hint
        if (isWhitePortal(su)) {
          div.classList.add("portal-white");
          const p = document.createElement('div');
          p.className = 'portal-visual portal-white';
          for (let si = 0; si < 12; si++) {
            const spark = document.createElement('i');
            const angle = Math.random() * 360;
            const dist = 10 + Math.random() * 26;
            const delay = (Math.random() * -3).toFixed(2) + 's';
            spark.style.setProperty('--angle', angle + 'deg');
            spark.style.setProperty('--dist', dist + 'px');
            spark.style.setProperty('--delay', delay);
            p.appendChild(spark);
          }
          div.appendChild(p);
        } else if (isBlackPortal(su)) {
          div.classList.add("portal-black");
          const p = document.createElement('div');
          p.className = 'portal-visual portal-black';
          for (let si = 0; si < 12; si++) {
            const spark = document.createElement('i');
            const angle = Math.random() * 360;
            const dist = 10 + Math.random() * 26;
            const delay = (Math.random() * -3).toFixed(2) + 's';
            spark.style.setProperty('--angle', angle + 'deg');
            spark.style.setProperty('--dist', dist + 'px');
            spark.style.setProperty('--delay', delay);
            p.appendChild(spark);
          }
          div.appendChild(p);
        } else if (isNeutralPortal(su)) {
          div.classList.add("portal-neutral");
          const p = document.createElement('div');
          p.className = 'portal-visual portal-neutral';
          for (let si = 0; si < 10; si++) {
            const spark = document.createElement('i');
            const angle = Math.random() * 360;
            const dist = 8 + Math.random() * 22;
            const delay = (Math.random() * -3).toFixed(2) + 's';
            spark.style.setProperty('--angle', angle + 'deg');
            spark.style.setProperty('--dist', dist + 'px');
            spark.style.setProperty('--delay', delay);
            p.appendChild(spark);
          }
          div.appendChild(p);
          if (state.neutralSwapCooldown) {
            if (piece && state.neutralSwapCooldown[piece.color]) {
              div.classList.add("cooldown");
              const lock = document.createElement("span");
              lock.className = "cooldown-lock";
              lock.textContent = "🔒";
              lock.style.position = "absolute";
              lock.style.right = "4px";
              lock.style.top = "4px";
              lock.style.fontSize = "14px";
              lock.style.lineHeight = "1";
              lock.style.pointerEvents = "none";
              lock.style.opacity = "0.9";
              lock.title = "Neutral portal temporarily disabled for this player";
              div.appendChild(lock);
            }
          }
        }

        if (selectedSq === s || legalTargets.has(s)) div.classList.add("highlight");

        if (lastMove) {
          const lu = lastMove.from && lastMove.from.toUpperCase();
          const ld = lastMove.to && lastMove.to.toUpperCase();
          if (su === lu || su === ld) div.classList.add('last-move');
        }

        if (suggestion) {
          const dest = (suggestion.toFinal || suggestion.to).toUpperCase();
          if (dest === su) div.classList.add("suggest");
        }

        if (piece) {
          if (!navigator.onLine) {
            const span = document.createElement('span');
            span.className = `piece piece-${piece.color}`;
            span.textContent = pieceToGlyph(piece);
            div.appendChild(span);
          } else {
            const img = document.createElement('img');
            img.className = `piece piece-${piece.color}`;
            const fileName = `${piece.color}${piece.type}.svg`;
            img.src = `${PIECE_IMG_PATH}/${fileName}`;
            img.alt = `${piece.color}${piece.type}`;
            img.style.width = '100%'; img.style.height = '100%'; img.style.display = 'block'; img.style.pointerEvents = 'none';
            img.addEventListener('error', () => {
              const span = document.createElement('span');
              span.className = `piece piece-${piece.color}`;
              span.textContent = pieceToGlyph(piece);
              const coordsEl = div.querySelector('.coords');
              if (coordsEl) div.insertBefore(span, coordsEl);
              else div.appendChild(span);
              img.remove();
            });
            div.appendChild(img);
          }
        }

        const coords = document.createElement("div");
        coords.className = "coords";
        coords.textContent = s.toLowerCase();
        div.appendChild(coords);

        div.addEventListener("click", () => onSquareClick(s));
        boardEl.appendChild(div);
      }
    }
  }
  statusEl.textContent = `Mode: ${mode} | Turn: ${state.turn === 'w' ? 'White' : 'Black'} | Move: ${state.moveNumber}`;
}

// Helper: present an in-page chooser for outcomes. Calls cb(chosen) where
// chosen is the resolved outcome (with promo/meta.promo attached) or null
// when canceled. The chooser groups outcomes by destination/via to avoid
// duplicate entries and shows inline promotion buttons (Q,R,B,N) when a
// group contains promotion outcomes.
function showOutcomeChooser(outcomes, cb) {
  // build groups by destination + portal choice + swapped flag
  const groups = {};
  outcomes.forEach(o => {
    const dest = (o.toFinal || o.to || '').toUpperCase();
    const choice = o.viaPortal?.choice || '';
    const swapped = o.viaPortal?.swapped ? '1' : '0';
    const key = `${dest}|${choice}|${swapped}`;
    groups[key] = groups[key] || [];
    groups[key].push(o);
  });

  // create overlay
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.left = '0'; overlay.style.top = '0';
  overlay.style.width = '100%'; overlay.style.height = '100%';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';

  const box = document.createElement('div');
  box.style.background = '#fff';
  box.style.borderRadius = '10px';
  box.style.padding = '12px';
  box.style.minWidth = '260px';
  box.style.maxWidth = '90%';
  box.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
  box.style.fontFamily = 'sans-serif';

  const title = document.createElement('div');
  title.textContent = 'Choose outcome';
  title.style.fontWeight = '600';
  title.style.marginBottom = '8px';
  box.appendChild(title);

  Object.keys(groups).forEach(key => {
    const arr = groups[key];
    const rep = arr[0];
    const dest = (rep.toFinal || rep.to || '').toUpperCase();
    const via = rep.viaPortal ? ` via ${rep.viaPortal.choice || 'PORTAL'}${rep.viaPortal.swapped ? ' (SWAP)' : ''}` : '';

    const row = document.createElement('div');
    row.style.marginBottom = '8px';
    const label = document.createElement('div');
    label.textContent = `${dest}${via}`;
    label.style.marginBottom = '6px';
    row.appendChild(label);

    // If any in group are promotions, show the 4 vertical promo buttons
    const isPromoGroup = arr.some(o => o.kind === 'promotion' || (o.meta && o.meta.promo));
    if (isPromoGroup) {
      const promos = ['Q','R','B','N'];
      const btnContainer = document.createElement('div');
      btnContainer.style.display = 'flex';
      btnContainer.style.flexDirection = 'column';
      btnContainer.style.gap = '6px';
      promos.forEach(pt => {
        const b = document.createElement('button');
        b.textContent = pt;
        b.style.padding = '8px 12px';
        b.style.cursor = 'pointer';
        b.style.border = '1px solid #666';
        b.style.borderRadius = '6px';
        b.style.background = '#f5f5f5';
        b.addEventListener('click', () => {
          // pick representative outcome and attach the selected promo
          const chosen = { ...rep };
          chosen.kind = 'promotion';
          chosen.promo = pt;
          chosen.meta = { ...(chosen.meta || {}), promo: pt };
          cleanup(); cb(chosen);
        });
        btnContainer.appendChild(b);
      });
      row.appendChild(btnContainer);
    } else {
      // single outcome button
      const sel = document.createElement('button');
      sel.textContent = 'Choose';
      sel.style.padding = '8px 12px';
      sel.style.cursor = 'pointer';
      sel.style.border = '1px solid #666';
      sel.style.borderRadius = '6px';
      sel.style.background = '#f5f5f5';
      sel.addEventListener('click', () => { cleanup(); cb(rep); });
      row.appendChild(sel);
    }

    box.appendChild(row);
  });

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.marginTop = '8px';
  cancel.style.padding = '8px 12px';
  cancel.style.cursor = 'pointer';
  cancel.style.border = '1px solid #c33';
  cancel.style.borderRadius = '6px';
  cancel.style.background = '#fff';
  cancel.addEventListener('click', () => { cleanup(); cb(null); });
  box.appendChild(cancel);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function cleanup() { try { overlay.remove(); } catch (e) { overlay.parentNode && overlay.parentNode.removeChild(overlay); } }
}

// Helper to apply a chosen resolved move and then handle post-move logic
function applyChosenMove(chosen) {
  // If we're in online mode, send the chosen resolved move to the server for validation
  if (mode === 'online') {
    if (!onlineRoomId) {
      alert('Not connected to an online room.');
      return;
    }
    const s = connectSocket();
    if (!s) { alert('Socket connection is not available. Make sure the page is served by the game server.'); return; }
    // disable UI briefly while waiting for server reply
    selectedSq = null; legalTargets.clear(); suggestion = null; render();
    s.emit('makeMove', { roomId: onlineRoomId, resolved: chosen }, (ack) => {
      if (!ack) {
        alert('No response from server');
        return;
      }
      if (ack.error) {
        alert('Move rejected: ' + (ack.error || 'illegal'));
        // re-render to restore UI state
        render();
        return;
      }
      // otherwise, server will broadcast moveMade and update state; nothing more to do here
    });
    return;
  }

  // Local (non-online) mode: apply move immediately
  try {
    state = applyResolvedMove(state, chosen);
  } catch (err) {
    console.error('Error applying move:', err);
    alert('Failed to apply move (see console)');
  }
  // Record last move (from/to) for highlighting, then play sound and update UI
  try {
    lastMove = { from: (chosen.from || '').toUpperCase(), to: ((chosen.toFinal || chosen.to) || '').toUpperCase() };
  } catch (e) { lastMove = null; }
  try { playSoundForResolved(chosen, state); } catch (e) {}
  selectedSq = null; legalTargets.clear(); suggestion = null; render();

  // After human move: schedule AI if needed
  if (mode === "vs-ai" && state.turn === aiColor) {
    setTimeout(() => {
      try {
        const aiMove = getBestMove(state, aiDepth, aiColor);
        if (aiMove) {
          state = applyResolvedMove(state, aiMove);
            // record and play sound for AI move
            try { lastMove = { from: (aiMove.from || '').toUpperCase(), to: ((aiMove.toFinal || aiMove.to) || '').toUpperCase() }; } catch (e) { lastMove = null; }
            try { playSoundForResolved(aiMove, state); } catch (e) {}
          suggestion = null;
          render();
        } else {
          render();
        }
      } catch (err) {
        console.error("AI error:", err);
        render();
      }
    }, 40);
  }
}

function onSquareClick(s) {
  // Wrap the entire click handler in try/catch to prevent extension-side
  // errors (or other unexpected runtime exceptions) from stopping UI flow
  // while developing in the browser's DevTools. Errors are logged but the
  // handler will return gracefully so the board remains interactive.
  try {
    // If vs-AI and it's AI's turn, ignore clicks
    if (mode === "vs-ai" && state.turn === aiColor) return;

    // If a portal-selection overlay is active, interpret clicks as selecting
    // one of the highlighted portal destinations. Only allowed squares are
    // clickable while in this mode.
    if (portalSelection) {
      const su = s.toUpperCase();
      if (!portalSelection.allowed.has(su)) {
        // ignore clicks outside allowed set
        return;
      }
      // find an outcome that lands on this square
      const chosen = portalSelection.outcomes.find(o => (o.toFinal || o.to || '').toUpperCase() === su);
      // disable overlay first
      disablePortalSelection();
      if (chosen) {
        applyChosenMove(chosen);
      } else {
        // should not happen, but recover gracefully
        selectedSq = null; legalTargets.clear(); render();
      }
      return;
    }

    const idx = FILES.indexOf(s[0]) + 8 * RANKS.indexOf(s[1]);
    const piece = state.board[idx];

    // In Analyze mode or Hotseat: allow selecting pieces for the side to move
    if (!selectedSq) {
      if (!piece || piece.color !== state.turn) return;
      selectedSq = s;
      const baseMoves = generatePseudoLegalMoves(state, selectedSq);
      // Filter via check legality for UI highlights
      let targetSet = new Set();
      for (const bm of baseMoves) {
        const outcomes = expandWithPortalOutcomes(state, bm);
        const legal = filterLegalByCheck(state, outcomes);
        for (const o of legal) targetSet.add((o.toFinal || o.to));
      }
      legalTargets = targetSet;
      render();
      return;
    }

    // Deselect
    if (selectedSq === s) {
      selectedSq = null; legalTargets.clear(); render(); return;
    }

    // Attempt to move
    const baseMoves = generatePseudoLegalMoves(state, selectedSq).filter(m => m.to === s);
    if (baseMoves.length === 0) {
      selectedSq = null; legalTargets.clear(); render(); return;
    }

    let outcomes = [];
    for (const bm of baseMoves) outcomes.push(...expandWithPortalOutcomes(state, bm));

    // Filter outcomes by check legality
    outcomes = filterLegalByCheck(state, outcomes);

    if (outcomes.length === 0) {
      selectedSq = null; legalTargets.clear(); render(); return;
    }

    // If there's exactly one resolved outcome, apply it immediately (or prompt
    // only for promotion). This avoids showing the chooser/modal for normal
    // single-step moves.
    if (outcomes.length === 1) {
      const single = outcomes[0];
      if (single.kind === 'promotion') {
        // show modal for promotion selection (single outcome)
        showOutcomeChooser([single], chosen => {
          if (!chosen) { selectedSq = null; legalTargets.clear(); render(); return; }
          applyChosenMove(chosen);
        });
        return;
      } else {
        applyChosenMove(single);
        return;
      }
    }

    // If these are portal outcomes (all have viaPortal) and the base move was
    // not a capture, switch into the in-board portal-selection flow that dims
    // the board and highlights only the selectable portal destinations.
    const isPortalOutcomeGroup = outcomes.length > 0 && outcomes.every(o => o.viaPortal);
    if (isPortalOutcomeGroup && !baseMoves.some(m => m.kind === 'capture')) {
      const enabled = enablePortalSelection(outcomes, baseMoves);
      if (!enabled) {
        // fallback to chooser if something prevented portal selection
        showOutcomeChooser(outcomes, chosen => { if (chosen) applyChosenMove(chosen); else { selectedSq = null; legalTargets.clear(); render(); } });
      } else {
        // Portal selection active — future clicks are handled at top of onSquareClick
        return;
      }
    }

    // Non-portal multi-outcome path: show chooser modal with promo buttons etc.
    showOutcomeChooser(outcomes, chosen => {
      if (!chosen) { selectedSq = null; legalTargets.clear(); render(); return; }
      applyChosenMove(chosen);
    });
    return;
  } catch (err) {
    console.error('onSquareClick failed:', err);
    // Try to recover UI state so the board remains usable
    selectedSq = null; legalTargets.clear(); render();
    return;
  }
}

// Controls wiring
modeSelect.addEventListener("change", e => {
  mode = e.target.value;
  // Hide/show AI controls depending on mode
  const aiOnly = (mode === "vs-ai");
  aiColorLabel.style.display = aiOnly ? "inline-block" : "none";
  aiDepthLabel.style.display = aiOnly ? "inline-block" : "none";
  suggestBtn.style.display = (mode === "analyze" || mode === "vs-ai") ? "inline-block" : "none";
  applySuggestionBtn.style.display = (mode === "analyze") ? "inline-block" : "none";
  // If switching to vs-ai and it's AI to move, trigger AI
  if (mode === "vs-ai" && state.turn === aiColor) {
    setTimeout(() => {
      const aiMove = getBestMove(state, aiDepth, aiColor);
      if (aiMove) {
        state = applyResolvedMove(state, aiMove);
        try { lastMove = { from: (aiMove.from || '').toUpperCase(), to: ((aiMove.toFinal || aiMove.to) || '').toUpperCase() }; } catch (e) { lastMove = null; }
        try { playSoundForResolved(aiMove, state); } catch (e) {}
        render();
      }
    }, 40);
  }

  // If switching to online, connect and either create or join a room based on URL
  if (mode === 'online') {
    // if URL contains /play/<id>, auto-join
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0] === 'play') {
      const roomId = parts[1];
      joinRoomOnServer(roomId);
    } else {
      // create a room automatically for the host
      createRoomOnServer();
    }
  }
  render();
});

// On load: if the path is /play/<roomId> then switch to online mode automatically
(function autoJoinFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'play') {
    modeSelect.value = 'online';
    mode = 'online';
    joinRoomOnServer(parts[1]);
  }
})();

aiColorSelect.addEventListener("change", e => {
  aiColor = e.target.value;
});

aiDepthInput.addEventListener("change", e => {
  const v = parseInt(e.target.value, 10);
  if (Number.isFinite(v) && v >= 1 && v <= 5) aiDepth = v;
  else aiDepth = 3;
});

// AI Suggest button: compute suggestion but don't apply (works in analyze and vs-ai)
suggestBtn.addEventListener("click", () => {
  // Which color should the AI suggest for? It's the current turn.
  const colorToSuggest = state.turn;
  try {
    const mv = getBestMove(state, aiDepth, colorToSuggest);
    if (mv) {
      suggestion = mv;
      render();
      // show user a small alert with summary
      const dest = (mv.toFinal || mv.to).toUpperCase();
      alert(`Suggestion for ${colorToSuggest === 'w' ? 'White' : 'Black'}:\nMove from ${mv.from} -> ${dest}${mv.viaPortal?.swapped ? " (SWAP)" : ""}`);
    } else {
      suggestion = null;
      alert("No suggested move (no legal moves).");
    }
  } catch (err) {
    console.error("AI suggest error:", err);
    alert("AI error when generating suggestion (see console).");
  }
});

// Apply suggestion button: only in Analyze mode; applies the suggestion if present
applySuggestionBtn.addEventListener("click", () => {
  if (!suggestion) {
    alert("No suggestion to apply. Click 'AI Suggest' first.");
    return;
  }
  try {
    state = applyResolvedMove(state, suggestion);
    try { lastMove = { from: (suggestion.from || '').toUpperCase(), to: ((suggestion.toFinal || suggestion.to) || '').toUpperCase() }; } catch (e) { lastMove = null; }
    try { playSoundForResolved(suggestion, state); } catch (e) {}
    suggestion = null;
    render();
  } catch (err) {
    console.error("Error applying suggestion:", err);
    alert("Failed to apply suggestion (see console).");
  }
});

// Reset button
resetBtn.addEventListener("click", () => {
  state = initialState();
  selectedSq = null; legalTargets.clear(); suggestion = null;
  // clear last-move highlight on reset
  lastMove = null;
  render();
});

// Flip button and keyboard shortcut (F)
function toggleFlip() {
  boardFlipped = !boardFlipped;
  try { localStorage.setItem('boardFlipped', boardFlipped ? 'true' : 'false'); } catch (e) {}
  render();
}
if (flipBtn) flipBtn.addEventListener('click', toggleFlip);
document.addEventListener('keydown', (e) => {
  if (!e || !e.key) return;
  // ignore typing into inputs
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey) return;
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleFlip();
  }
});

// initial UI setup: show/hide correct controls
(function initUI() {
  aiColorLabel.style.display = (mode === "vs-ai") ? "inline-block" : "none";
  aiDepthLabel.style.display = (mode === "vs-ai") ? "inline-block" : "none";
  suggestBtn.style.display = (mode === "analyze" || mode === "vs-ai") ? "inline-block" : "none";
  applySuggestionBtn.style.display = (mode === "analyze") ? "inline-block" : "none";
  render();
  // Attempt to load external audio assets (non-blocking). If assets are not
  // present the code will silently fall back to synthesized tones.
  loadAudioAssets().then(() => {
    console.log('Audio assets loader finished');
  }).catch(err => {
    console.warn('Audio loader error', err);
  });
})();

// Build an online panel inside the controls area for room info
function ensureOnlinePanel() {
  if (onlinePanel) return onlinePanel;
  const controls = document.getElementById('controls');
  const panel = document.createElement('div');
  panel.id = 'onlinePanel';
  panel.style.display = 'none';
  panel.style.marginLeft = '8px';
  panel.style.padding = '6px';
  panel.style.border = '1px solid #ddd';
  panel.style.borderRadius = '6px';
  panel.style.background = '#fff';

  const info = document.createElement('div'); info.id = 'onlineInfo'; panel.appendChild(info);
  const link = document.createElement('input'); link.id = 'onlineLink'; link.style.width = '260px'; link.readOnly = true; panel.appendChild(link);
  const copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy Link'; copyBtn.style.marginLeft = '6px';
  copyBtn.addEventListener('click', () => { try { link.select(); document.execCommand('copy'); } catch(e){} });
  panel.appendChild(copyBtn);

  controls.appendChild(panel);
  onlinePanel = panel;
  return panel;
}

function showOnlinePanel(text, link) {
  const p = ensureOnlinePanel();
  const info = p.querySelector('#onlineInfo');
  const input = p.querySelector('#onlineLink');
  info.textContent = text || '';
  input.value = link || '';
  p.style.display = 'inline-block';
}

function hideOnlinePanel() { if (onlinePanel) onlinePanel.style.display = 'none'; }

function connectSocket() {
  if (socket) return socket;
  if (typeof io === 'undefined') {
    console.warn('socket.io client not available globally (io). Online mode requires served app via server.');
    return null;
  }
  // Connect to localhost (dev) or the production Render URL
  const SERVER_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://portalchess.onrender.com';
  socket = io(SERVER_URL);

  socket.on('connect', () => { console.log('connected to server', socket.id); });

  socket.on('gameStart', ({ roomId, color, state: serverState }) => {
    onlineRoomId = roomId;
    onlineColor = color;
    // adopt server state and render
    try { state = hydrateState(serverState); } catch (e) { state = serverState; }
    showOnlinePanel(`Room: ${roomId} — You are ${color === 'w' ? 'White' : 'Black'}`, window.location.origin + '/play/' + roomId);
    render();
  });

  socket.on('moveMade', ({ resolved, state: serverState }) => {
    try { state = hydrateState(serverState); lastMove = { from: (resolved.from||'').toUpperCase(), to: ((resolved.toFinal||resolved.to)||'').toUpperCase() }; } catch (e) { state = serverState; }
    try { playSoundForResolved(resolved, state); } catch (e) {}
    render();
  });

  socket.on('moveRejected', (data) => {
    alert('Move rejected by server');
  });

  socket.on('disconnect', () => { console.log('socket disconnected'); socket = null; onlineRoomId = null; onlineColor = null; hideOnlinePanel(); });

  return socket;
}

function createRoomOnServer() {
  const s = connectSocket();
  if (!s) return;
  s.emit('createRoom', (res) => {
    if (res && res.roomId) {
      onlineRoomId = res.roomId; isHost = true; onlineColor = 'w';
      const link = window.location.origin + '/play/' + res.roomId;
      history.replaceState(null, '', '/'); // keep path clean until user shares link
      showOnlinePanel(`Room created: ${res.roomId} — Share link to invite`, link);
    } else {
      alert('Failed to create room');
    }
  });
}

function joinRoomOnServer(roomId) {
  const s = connectSocket();
  if (!s) return;
  s.emit('joinRoom', { roomId }, (res) => {
    if (res && res.error) {
      alert('Failed to join room: ' + res.error);
    } else {
      onlineRoomId = roomId; isHost = false;
      showOnlinePanel(`Joined room: ${roomId} — waiting for opponent...`, window.location.origin + '/play/' + roomId);
    }
  });
}

// Development helper: expose engine initialState to the window so snippets/tests
// that call `window.initialState()` (e.g., quick dev console tests) work.
// This is intentionally minor and safe: it only provides a reference —
// keep/remove as desired for production.
try {
  if (typeof window !== 'undefined') window.initialState = initialState;
} catch (e) {
  // ignore when environment doesn't allow window assignment
}

// Additional development helpers: expose a few engine functions for quick console testing
// (generatePseudoLegalMoves, isSquareAttacked, applyResolvedMove). These are dev-only
// conveniences to help debug castling/attack checks quickly from DevTools.
try {
  if (typeof window !== 'undefined') {
    window.generatePseudoLegalMoves = generatePseudoLegalMoves;
    window.isSquareAttacked = (state, sq, attacker) => {
      try { return isSquareAttacked(state, sq, attacker); } catch (e) { return !!e; }
    };
    window.applyResolvedMove = applyResolvedMove;
    // Quick browser test for the personal-portal "no-return" rule.
    // Call `runPersonalPortalTest()` from DevTools console.
    window.runPersonalPortalTest = function() {
      try {
        const toIndex = sq => FILES.indexOf(sq[0]) + 8 * RANKS.indexOf(sq[1]);
        let s = initialState();
        // place a white knight on D5
        s.board[toIndex('D5')] = { type: 'N', color: 'w', hasMoved: false };
        const resolvedWhitePortal = {
          from: 'D5', to: 'F5', toFinal: 'F5', kind: 'portal-activation',
          viaPortal: { network: 'exclusive', entry: 'D5', choice: 'F5', swapped: false }
        };
        const afterWhite = applyResolvedMove(s, resolvedWhitePortal);
        console.log('After white portal activation, pendingPersonalNoReturn:', afterWhite.pendingPersonalNoReturn);
        const resolvedBlack = { from: 'E7', to: 'E6', toFinal: 'E6', kind: 'move' };
        const afterBlack = applyResolvedMove(afterWhite, resolvedBlack);
        console.log('After black move, personalNoReturn for white:', afterBlack.personalNoReturn);
        const movesFromF5 = generatePseudoLegalMoves(afterBlack, 'F5');
        console.log('Pseudo-legal moves from F5 (should NOT include return to D5):', movesFromF5.map(m => ({to: m.to, kind: m.kind})));
        const hasReturn = movesFromF5.some(m => m.to === 'D5');
        console.log('Contains forbidden return to D5?', hasReturn ? 'YES - ERROR' : 'NO - OK');
        const otherAllowed = movesFromF5.filter(m => m.to !== 'D5' && m.kind === 'portal-activation').map(m => m.to);
        console.log('Other personal-portal destinations allowed from F5:', otherAllowed);
      } catch (err) { console.error('runPersonalPortalTest failed', err); }
    };
    // Scenario 2: move onto portal then jump in same turn (D4 -> D5 -> F5)
    window.runPersonalPortalScenario2 = function() {
      try {
        const toIndex = sq => FILES.indexOf(sq[0]) + 8 * RANKS.indexOf(sq[1]);
        let s = initialState();
        // place a white knight on D4
        s.board[toIndex('D4')] = { type: 'N', color: 'w', hasMoved: false };
        // Simulate resolved outcome where the piece moves D4 -> D5 (landing) then jumps to F5
        const resolvedJump = {
          from: 'D4', to: 'F5', toFinal: 'F5', kind: 'move',
          viaPortal: { entry: 'D5', network: 'exclusive', choice: 'F5', swapped: false }
        };
        const afterWhite = applyResolvedMove(s, resolvedJump);
        console.log('After white move/jump, pendingPersonalNoReturn:', afterWhite.pendingPersonalNoReturn);
        const afterBlack = applyResolvedMove(afterWhite, { from: 'E7', to: 'E6', toFinal: 'E6', kind: 'move' });
        console.log('After black move, personalNoReturn for white:', afterBlack.personalNoReturn);
        const movesFromF5 = generatePseudoLegalMoves(afterBlack, 'F5');
        console.log('Pseudo-legal moves from F5 (should NOT include return to D5):', movesFromF5.map(m => ({to: m.to, kind: m.kind})));
        const hasReturn = movesFromF5.some(m => m.to === 'D5');
        console.log('Contains forbidden return to D5?', hasReturn ? 'YES - ERROR' : 'NO - OK');
      } catch (err) { console.error('runPersonalPortalScenario2 failed', err); }
    };
  }
} catch (e) {
  // ignore
}

// (debug castling UI removed)