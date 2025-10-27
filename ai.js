// ai.js
// Optimized Level 1 Minimax AI for Portal Chess (MVP)
// Exports: getBestMove(state, depth=3, color)
//
// Optimizations:
// - avoids JSON cloning in move generation (temporarily sets state.turn)
// - limits moves per node (beam pruning) to reduce branching
// - limits swap-scan in evaluation to a small number of moves
// - uses simple ordering (captures / swaps first)

import {
  generatePseudoLegalMoves,
  expandWithPortalOutcomes,
  applyResolvedMove,
  filterLegalByCheck,
  inCheck,
} from "./engine.js";

// Piece values
const PIECE_VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

// Board helpers (must match engine's FILES/RANKS)
const FILES = "ABCDEFGH".split("");
const RANKS = "12345678".split("");
function indexToSq(i) { const f = i % 8; const r = Math.floor(i / 8); return `${FILES[f]}${RANKS[r]}`; }

// Evaluation weights (tuneable)
const WEIGHTS = {
  portalControl: 0.25,
  centerControl: 0.12,
  swapOpportunityBase: 3.0,
  materialScale: 1.0
};
const CENTER_SQS = new Set(["D4","D5","E4","E5"]);

// Performance tuning knobs (change to taste)
export const MAX_MOVES_PER_NODE = 24;    // beam width (best candidates per node)
export const MAX_SWAP_SCAN_IN_EVAL = 12; // how many legal moves to consider when searching for swap opportunities in evaluateState

// Robust portal presence helper used by evaluation (works with engine state)
function portalHas(state, sq) {
  if (!state.portals) return false;
  const S = sq.toUpperCase();
  const white = state.portals.white;
  if (white) {
    if (typeof white.has === "function") {
      if (white.has(S)) return true;
    } else if (Array.isArray(white) && white.includes(S)) return true;
  }
  const black = state.portals.black;
  if (black) {
    if (typeof black.has === "function") {
      if (black.has(S)) return true;
    } else if (Array.isArray(black) && black.includes(S)) return true;
  }
  const neutral = state.portals.neutralPairs;
  if (neutral && Array.isArray(neutral)) {
    for (const pair of neutral) {
      if (!pair) continue;
      if (pair[0] === S || pair[1] === S) return true;
    }
  }
  return false;
}

// Helper: generate resolved legal moves for color.
// Important optimization: we DO NOT clone state here. We set state.turn temporarily,
// generate moves using engine functions, then restore the previous value.
// Accepts an optional limit param to return only the top N moves ordered by heuristic.
function getAllResolvedMovesForColor(state, color, limit = Infinity) {
  const prevTurn = state.turn;
  state.turn = color; // temporarily set; engine functions reference state.turn
  const moves = [];
  // iterate all squares
  for (let i = 0; i < 64; i++) {
    const sq = indexToSq(i);
    const p = state.board[i];
    if (!p || p.color !== color) continue;
    const baseMoves = generatePseudoLegalMoves(state, sq);
    for (const bm of baseMoves) {
      const outcomes = expandWithPortalOutcomes(state, bm);
      if (!outcomes || outcomes.length === 0) continue;
      const legal = filterLegalByCheck(state, outcomes);
      for (const o of legal) moves.push(o);
    }
  }
  state.turn = prevTurn; // restore
  // Order and limit
  moves.sort((a, b) => moveScoreForOrdering(state, b) - moveScoreForOrdering(state, a));
  if (moves.length > limit) moves.length = limit;
  return moves;
}

// Lightweight ordering function (captures and portal-swaps first)
function moveScoreForOrdering(state, move) {
  let score = 0;
  if (move.kind === "capture") score += 200;
  if (move.viaPortal?.swapped) score += 300;
  const dest = (move.toFinal || move.to);
  if (CENTER_SQS.has(dest.toUpperCase())) score += 10;
  return score;
}

// Evaluation of state for `color`
function evaluateState(state, color) {
  let material = 0;
  let portalControl = 0;
  let centerControl = 0;

  // Material + simple bonuses
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece) continue;
    const sq = indexToSq(i);
    const val = PIECE_VALUE[piece.type] || 0;
    const sign = piece.color === color ? 1 : -1;
    material += val * sign;
    if (portalHas(state, sq)) portalControl += WEIGHTS.portalControl * sign;
    if (CENTER_SQS.has(sq.toUpperCase())) centerControl += WEIGHTS.centerControl * sign;
  }

  // Swap-opportunity detection: limited scan to avoid heavy cost
  let swapBonus = 0;
  const candidateMoves = getAllResolvedMovesForColor(state, color, MAX_SWAP_SCAN_IN_EVAL);
  for (const m of candidateMoves) {
    if (m.viaPortal && m.viaPortal.swapped) {
      const fromSq = m.from.toUpperCase();
      const destSq = (m.toFinal || m.to).toUpperCase();
      const mover = state.board[RANKS.indexOf(fromSq[1]) * 8 + FILES.indexOf(fromSq[0])];
      const opp = state.board[RANKS.indexOf(destSq[1]) * 8 + FILES.indexOf(destSq[0])];
      if (mover && opp && mover.color !== opp.color) {
        const diff = (PIECE_VALUE[opp.type] || 0) - (PIECE_VALUE[mover.type] || 0);
        if (diff > 0) swapBonus = Math.max(swapBonus, WEIGHTS.swapOpportunityBase * diff);
      }
    }
  }

  let score = material * WEIGHTS.materialScale + portalControl + centerControl + swapBonus;

  // King safety: penalty/bonus for checks (small)
  try {
    if (inCheck(state, color)) score -= 6;
    if (inCheck(state, color === 'w' ? 'b' : 'w')) score += 6;
  } catch (e) {
    // ignore detection errors
  }

  return score;
}

// Minimax + alpha-beta with beam limiting (MAX_MOVES_PER_NODE applied at each node)
function minimax(state, depth, alpha, beta, maximizingPlayerColor, currentPlayerColor) {
  if (depth === 0) {
    return { value: evaluateState(state, maximizingPlayerColor), move: null };
  }

  // Limit branching: request only top candidates for this node
  const moves = getAllResolvedMovesForColor(state, currentPlayerColor, MAX_MOVES_PER_NODE);

  if (moves.length === 0) {
    // no legal moves -> mate or stalemate
    if (inCheck(state, currentPlayerColor)) {
      const mateValue = currentPlayerColor === maximizingPlayerColor ? -1e6 : 1e6;
      return { value: mateValue, move: null };
    }
    return { value: 0, move: null }; // stalemate
  }

  // moves are already ordered and limited
  let bestMove = null;

  if (currentPlayerColor === maximizingPlayerColor) {
    let maxEval = -Infinity;
    for (const m of moves) {
      const nextState = applyResolvedMove(state, m);
      const res = minimax(nextState, depth - 1, alpha, beta, maximizingPlayerColor, currentPlayerColor === 'w' ? 'b' : 'w');
      if (res.value > maxEval) { maxEval = res.value; bestMove = m; }
      alpha = Math.max(alpha, res.value);
      if (beta <= alpha) break;
    }
    return { value: maxEval, move: bestMove };
  } else {
    let minEval = Infinity;
    for (const m of moves) {
      const nextState = applyResolvedMove(state, m);
      const res = minimax(nextState, depth - 1, alpha, beta, maximizingPlayerColor, currentPlayerColor === 'w' ? 'b' : 'w');
      if (res.value < minEval) { minEval = res.value; bestMove = m; }
      beta = Math.min(beta, res.value);
      if (beta <= alpha) break;
    }
    return { value: minEval, move: bestMove };
  }
}

// Public API
export function getBestMove(state, depth = 3, color = 'b') {
  // If depth is small, this will be fast. For larger depth, prefer a web worker.
  const res = minimax(state, depth, -Infinity, Infinity, color, color);
  return res.move;
}