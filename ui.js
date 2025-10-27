import {
  initialState,
  pieceToGlyph,
  generatePseudoLegalMoves,
  expandWithPortalOutcomes,
  applyResolvedMove,
  isSquareAttacked,
  filterLegalByCheck,
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
const aiColorLabel = document.getElementById("aiColorLabel");
const aiDepthLabel = document.getElementById("aiDepthLabel");

const FILES = "ABCDEFGH".split("");
const RANKS = "12345678".split("");
// Path to local SVG piece set. Place cburnett SVGs under this folder with names like 'wP.svg', 'bK.svg', etc.
const PIECE_IMG_PATH = "pieces/cburnett";

let state = initialState();
let selectedSq = null;
let legalTargets = new Set();
let suggestion = null; // suggested resolved move (not applied)
let mode = modeSelect.value; // 'hotseat' | 'vs-ai' | 'analyze'
let aiColor = aiColorSelect.value; // 'w'|'b'
let aiDepth = parseInt(aiDepthInput.value, 10) || 3;

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
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) {
      const s = sq(f, r);
      const su = s.toUpperCase();
      const div = document.createElement("div");
      div.className = `square ${isLight(f,r) ? "light" : "dark"}`;

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

      // show suggestion target highlight
      if (suggestion) {
        const dest = (suggestion.toFinal || suggestion.to).toUpperCase();
        if (dest === su) div.classList.add("suggest");
      }

      // Draw piece
      if (piece) {
        // Use an <img> pointing at the cburnett SVG set. If the image fails to load (missing files),
        // fall back to the text glyph so the UI remains functional.
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
          // Preserve the coords/overlay stacking by inserting before coords element if present
          const coordsEl = div.querySelector('.coords');
          if (coordsEl) div.insertBefore(span, coordsEl);
          else div.appendChild(span);
          img.remove();
        });

        div.appendChild(img);
      }

      const coords = document.createElement("div");
      coords.className = "coords";
      coords.textContent = s.toLowerCase();
      div.appendChild(coords);

      div.addEventListener("click", () => onSquareClick(s));
      boardEl.appendChild(div);
    }
  }
  statusEl.textContent = `Mode: ${mode} | Turn: ${state.turn === 'w' ? 'White' : 'Black'} | Move: ${state.moveNumber}`;
}

function onSquareClick(s) {
  // If vs-AI and it's AI's turn, ignore clicks
  if (mode === "vs-ai" && state.turn === aiColor) return;

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

  // If multiple outcomes (portal choices), ask via prompt (MVP-friendly)
  let chosen = null;
  if (outcomes.length === 1) {
    chosen = outcomes[0];
  } else {
    const options = outcomes.map(o => {
      const swapTag = o.viaPortal?.swapped ? " (SWAP)" : "";
      const choice = o.viaPortal?.choice ?? "STAY";
      return `${o.toFinal}${o.viaPortal ? ` via ${choice}${swapTag}` : ""}`;
    });
    const input = prompt(`Portal choice:\n${options.map((x,i)=>`${i+1}. ${x}`).join("\n")}\nEnter number:`);
    const choiceIdx = parseInt(input, 10) - 1;
    if (!Number.isFinite(choiceIdx) || choiceIdx < 0 || choiceIdx >= outcomes.length) {
      alert("Invalid choice. Move canceled.");
      selectedSq = null; legalTargets.clear(); render(); return;
    }
    chosen = outcomes[choiceIdx];
  }

  // If the chosen resolved outcome is a promotion, prompt the user for the
  // desired piece (Q/R/B/N) and attach it to the resolved object before
  // applying. We prompt here in the UI because the engine expects the
  // resolved move to carry the promo metadata (e.g., resolved.promo or
  // resolved.meta.promo). This keeps promotion resolution immediate and
  // avoids involving portal branching.
  if (chosen.kind === 'promotion') {
    let promo = prompt('Promote pawn to (Q/R/B/N):', (chosen.meta && chosen.meta.promo) || 'Q');
    if (!promo) {
      alert('Promotion canceled. Move aborted.');
      selectedSq = null; legalTargets.clear(); render(); return;
    }
    promo = promo.trim().toUpperCase();
    if (!['Q','R','B','N'].includes(promo)) {
      alert('Invalid promotion piece. Move canceled.');
      selectedSq = null; legalTargets.clear(); render(); return;
    }
    chosen.promo = promo;
    chosen.meta = chosen.meta || {};
    chosen.meta.promo = promo;
  }

  // Apply human move
  state = applyResolvedMove(state, chosen);
  selectedSq = null; legalTargets.clear(); suggestion = null; render();

  // After human move:
  if (mode === "vs-ai" && state.turn === aiColor) {
    // schedule AI move
    setTimeout(() => {
      try {
        const aiMove = getBestMove(state, aiDepth, aiColor);
        if (aiMove) {
          state = applyResolvedMove(state, aiMove);
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
  } else {
    // In analyze/hotseat mode, no automatic AI move; suggestion cleared
    suggestion = null;
    render();
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
      if (aiMove) { state = applyResolvedMove(state, aiMove); render(); }
    }, 40);
  }
  render();
});

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
  render();
});

// initial UI setup: show/hide correct controls
(function initUI() {
  aiColorLabel.style.display = (mode === "vs-ai") ? "inline-block" : "none";
  aiDepthLabel.style.display = (mode === "vs-ai") ? "inline-block" : "none";
  suggestBtn.style.display = (mode === "analyze" || mode === "vs-ai") ? "inline-block" : "none";
  applySuggestionBtn.style.display = (mode === "analyze") ? "inline-block" : "none";
  render();
})();

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