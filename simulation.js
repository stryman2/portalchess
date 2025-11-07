#!/usr/bin/env node
/*
  simulation.js
  Run AI-vs-AI simulations to gather win/draw statistics and log openings.

  Usage:
    node simulation.js [GAMES] [DEPTH] [OPENINGS_LOG]
  Examples:
    node simulation.js 100 3 openings.log

  This script intentionally runs without any UI or browser.
*/

import fs from 'fs/promises';
import path from 'path';

import { initialState, applyResolvedMove, gameResult, generatePseudoLegalMoves, expandWithPortalOutcomes, filterLegalByCheck } from './engine.js';
import { getBestMove as calculateBestMove, clearTranspositionTable } from './ai.js';

const GAMES_TO_RUN = Number(process.argv[2] || process.env.GAMES_TO_RUN || 1000);
const AI_DEPTH = Number(process.argv[3] || process.env.AI_DEPTH || 3);
const OPENINGS_LOG = process.argv[4] || process.env.OPENINGS_LOG || path.join(process.cwd(), 'openings.log');
// Probability (0..1) to pick a random legal move instead of the calculated best move
const RANDOM_MOVE_PROB = Number(process.argv[5] || process.env.RANDOM_MOVE_PROB || 0);
// Top-k weighted opening selection: pick among top K candidate moves with probability
// proportional to a lightweight heuristic score. Useful to diversify openings while
// remaining biased toward stronger moves.
const TOP_K = Number(process.argv[6] || process.env.TOP_K || 0); // 0 = disabled
const OPENING_PLY_LIMIT = Number(process.argv[7] || process.env.OPENING_PLY_LIMIT || 8); // only use top-k for first N ply
const SOFTMAX_T = Number(process.argv[8] || process.env.SOFTMAX_T || 1.0); // temperature for softmax weighting

async function appendLine(filePath, line) {
  await fs.appendFile(filePath, line + '\n', 'utf8');
}

function moveToString(mv) {
  if (!mv) return '';
  const from = (mv.from || '').toUpperCase();
  const to = ((mv.toFinal || mv.to) || '').toUpperCase();
  return `${from}->${to}`;
}

async function runSimulation() {
  // Truncate/open the openings log
  await fs.writeFile(OPENINGS_LOG, `Simulation openings log\nGenerated: ${new Date().toISOString()}\n\n`, 'utf8');

  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;

  console.log(`Starting simulation: ${GAMES_TO_RUN} games, AI depth ${AI_DEPTH}`);

  // debug log for suspicious games
  const DEBUG_LOG = path.join(process.cwd(), 'debug_games.log');
  await fs.writeFile(DEBUG_LOG, `Debug games log\nGenerated: ${new Date().toISOString()}\n\n`, 'utf8');

  function sqToIndex(sqRaw) {
    if (!sqRaw) return -1;
    const sq = sqRaw.toUpperCase();
    const FILES = 'ABCDEFGH';
    const RANKS = '12345678';
    const f = FILES.indexOf(sq[0]);
    const r = RANKS.indexOf(sq[1]);
    if (f < 0 || r < 0) return -1;
    return r * 8 + f;
  }

  async function appendDebug(gi, header, lines) {
    const pre = `--- Game ${gi} DEBUG: ${header} (${new Date().toISOString()})\n`;
    await appendLine(DEBUG_LOG, pre + lines.join('\n') + '\n');
  }

  for (let gi = 1; gi <= GAMES_TO_RUN; gi++) {
    // Clear AI's transposition table at the start of each game so the table
    // can be reused across successive getBestMove calls within the same game
    // (this significantly speeds up multi-ply searches). Clearing per game
    // avoids unbounded cross-game pollution.
    try { clearTranspositionTable(); } catch (e) {}
    let state = initialState();
    const openingPly = []; // record moves as ply (each move by either side)
    let turns = 0;
    let lastMv = null;
    let lastCapturedDesc = null;

    // Play until gameResult says it's finished
    while (true) {
      const resNow = gameResult(state);
      if (resNow && resNow.result && resNow.result !== 'ongoing') break;

      const color = state.turn; // 'w' or 'b'
      // Ask AI for a move for the current side
      let mv = null;
      // Selection strategy precedence (per ply):
      // 1) If TOP_K>0 and openingPly.length < OPENING_PLY_LIMIT: select among top-K weighted candidates
      // 2) Else if RANDOM_MOVE_PROB > 0 and Math.random()<RANDOM_MOVE_PROB: pick a uniformly random legal candidate
      // 3) Else: deterministic AI best move
      const useTopK = TOP_K > 0 && openingPly.length < OPENING_PLY_LIMIT;

      if (useTopK) {
        // build legal resolved outcomes for all pieces of the current side
        const candidates = [];
        try {
          for (let i = 0; i < 64; i++) {
            const p = state.board[i];
            if (!p || p.color !== color) continue;
            const fromSq = `${'ABCDEFGH'[i%8]}${'12345678'[Math.floor(i/8)]}`;
            const base = generatePseudoLegalMoves(state, fromSq);
            for (const bm of base) {
              const outcomes = expandWithPortalOutcomes(state, bm);
              const legalOutcomes = filterLegalByCheck(state, outcomes);
              for (const o of legalOutcomes) candidates.push(o);
            }
          }
        } catch (e) {
          candidates.length = 0;
        }

        if (candidates.length === 0) {
          try { mv = calculateBestMove(state, AI_DEPTH, color); } catch (err) { console.error('AI failed to produce a move, aborting game', err && err.message); break; }
        } else {
          // Score candidates using a lightweight heuristic
          const PIECE_VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
          const CENTER_SQS = new Set(['D4','D5','E4','E5']);
          function sqToIndexLocal(sqRaw) {
            if (!sqRaw) return -1;
            const sq = sqRaw.toUpperCase();
            const FILES = 'ABCDEFGH';
            const RANKS = '12345678';
            const f = FILES.indexOf(sq[0]);
            const r = RANKS.indexOf(sq[1]);
            if (f < 0 || r < 0) return -1;
            return r * 8 + f;
          }

          function scoreCandidate(st, cand) {
            let score = 0;
            // capture value
            const dest = (cand.toFinal || cand.to || '').toUpperCase();
            const destIdx = sqToIndexLocal(dest);
            const captured = (destIdx >= 0 && st.board[destIdx]) ? st.board[destIdx] : null;
            if (captured) score += (PIECE_VALUE[captured.type] || 0) * 10; // scale captures
            // portal swap bonus
            if (cand.viaPortal && cand.viaPortal.swapped) score += 8;
            // center control bonus
            if (CENTER_SQS.has(dest)) score += 1;
            // small bias by move ordering heuristics (captures/portal first)
            if (cand.kind === 'capture') score += 5;
            return score;
          }

          // compute scores
          const scored = candidates.map(c => ({ move: c, score: scoreCandidate(state, c) }));
          // sort desc and take top-K
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, Math.max(1, TOP_K));

          // softmax sampling with temperature
          const maxS = Math.max(...top.map(t => t.score));
          // shift scores to be >=0
          const exps = top.map(t => Math.exp(((t.score - maxS) / Math.max(0.0001, SOFTMAX_T))));
          const sumExp = exps.reduce((s, x) => s + x, 0) || 1;
          const probs = exps.map(e => e / sumExp);
          // sample
          let r = Math.random();
          let acc = 0;
          let chosen = top[0].move;
          for (let i = 0; i < top.length; i++) {
            acc += probs[i];
            if (r <= acc) { chosen = top[i].move; break; }
          }
          mv = chosen;
        }
      } else if (RANDOM_MOVE_PROB > 0 && Math.random() < RANDOM_MOVE_PROB) {
        // uniform random candidate (legacy behavior)
        const candidates = [];
        try {
          for (let i = 0; i < 64; i++) {
            const p = state.board[i];
            if (!p || p.color !== color) continue;
            const fromSq = `${'ABCDEFGH'[i%8]}${'12345678'[Math.floor(i/8)]}`;
            const base = generatePseudoLegalMoves(state, fromSq);
            for (const bm of base) {
              const outcomes = expandWithPortalOutcomes(state, bm);
              const legalOutcomes = filterLegalByCheck(state, outcomes);
              for (const o of legalOutcomes) candidates.push(o);
            }
          }
        } catch (e) { candidates.length = 0; }

        if (candidates.length > 0) mv = candidates[Math.floor(Math.random() * candidates.length)];
        else {
          try { mv = calculateBestMove(state, AI_DEPTH, color); } catch (err) { console.error('AI failed to produce a move, aborting game', err && err.message); break; }
        }
      } else {
        try {
          mv = calculateBestMove(state, AI_DEPTH, color);
        } catch (err) {
          console.error('AI failed to produce a move, aborting game', err && err.message);
          break;
        }
      }

      if (!mv) {
        // No move returned: treat as terminal and break
        break;
      }

  // Inspect target square to see what (if anything) is being captured
      const destSq = (mv.toFinal || mv.to || '').toUpperCase();
      const destIdx = sqToIndex(destSq);
      const capturedPiece = (destIdx >= 0 && state.board[destIdx]) ? state.board[destIdx] : null;
      let capturedDesc = capturedPiece ? `${capturedPiece.color}${capturedPiece.type}` : null;
  // stash last move info for post-game debugging
  lastMv = mv;
  lastCapturedDesc = capturedDesc;
      try {
        state = applyResolvedMove(state, mv);
      } catch (err) {
        console.error('Failed to apply move returned by AI, aborting game', err && err.message);
        break;
      }

      // Record opening ply up to first 10 ply (5 full moves)
      if (openingPly.length < 10) {
        openingPly.push(moveToString(mv));
      }

      turns += 1;
      // Safety cap for absurdly long games (shouldn't happen) -> force draw after 1000 plies
      if (turns > 2000) {
        console.warn(`Game ${gi} exceeded ply cap; declaring draw`);
        break;
      }
    }

    const final = gameResult(state) || { result: 'stalemate', winner: null };
    let lineResult = '';
    if (final.result === 'checkmate') {
      const winner = final.winner === 'w' ? 'White' : (final.winner === 'b' ? 'Black' : String(final.winner));
      lineResult = `${winner} Win`;
      if (final.winner === 'w') whiteWins++; else if (final.winner === 'b') blackWins++;
    } else if (final.result === 'stalemate') {
      lineResult = 'Draw';
      draws++;
    } else {
      lineResult = 'Draw';
      draws++;
    }

    // Write openings line: include first up to 10 ply (comma separated)
    const openingStr = openingPly.length > 0 ? openingPly.join(', ') : '(no moves)';
    const logLine = `Game ${gi} (${lineResult}): ${openingStr}`;
    await appendLine(OPENINGS_LOG, logLine);

    // If the game ended as checkmate but the last captured piece was not a king,
    // log a detailed debug snapshot to help investigate false positives.
    if (final.result === 'checkmate' && lastCapturedDesc && !lastCapturedDesc.toUpperCase().includes('K')) {
      // Build a board ASCII dump and list legal moves for side to move
      const boardLines = [];
      for (let r = 7; r >= 0; r--) {
        let row = '';
        for (let f = 0; f < 8; f++) {
          const idx = r * 8 + f;
          const p = state.board[idx];
          row += p ? `${p.color}${p.type}`.padEnd(3) : ' . '.padEnd(3);
        }
        boardLines.push(row.trim());
      }

      // Generate legal moves for the side to move (pseudo-legal expanded & filtered)
      const legalMoves = [];
      try {
        for (let i = 0; i < 64; i++) {
          const p = state.board[i];
          if (!p) continue;
          const fromSq = `${'ABCDEFGH'[i%8]}${'12345678'[Math.floor(i/8)]}`;
          const base = generatePseudoLegalMoves(state, fromSq);
          for (const bm of base) {
            const outcomes = expandWithPortalOutcomes(state, bm);
            const legalOutcomes = filterLegalByCheck(state, outcomes);
            for (const o of legalOutcomes) legalMoves.push(`${fromSq}->${(o.toFinal||o.to)}`);
          }
        }
      } catch (e) { legalMoves.push('legal-move-generation-failed'); }

      const debugLines = [];
      debugLines.push(`Final result: ${JSON.stringify(final)}`);
      debugLines.push(`Last move: ${moveToString(lastMv)} (captured=${lastCapturedDesc})`);
      debugLines.push('Board (top->bottom):');
      debugLines.push(...boardLines);
      debugLines.push('Legal moves for side to move:');
      debugLines.push(legalMoves.slice(0,200).join(', ') || '(none)');

      await appendDebug(gi, 'suspicious-checkmate', debugLines);
      console.warn('Suspicious checkmate logged for game', gi);
    }

    // Periodic progress log
    if (gi % Math.max(1, Math.floor(GAMES_TO_RUN / 20)) === 0) {
      console.log(`Progress: ${gi}/${GAMES_TO_RUN} — W:${whiteWins} B:${blackWins} D:${draws}`);
    }
  }

  // Summary
  const total = whiteWins + blackWins + draws;
  const pct = n => total ? ((n / total) * 100).toFixed(1) : '0.0';

  console.log('\nSIMULATION COMPLETE\n====================');
  console.log(`Total Games: ${total}`);
  console.log(`- White Wins: ${whiteWins} (${pct(whiteWins)}%)`);
  console.log(`- Black Wins: ${blackWins} (${pct(blackWins)}%)`);
  console.log(`- Draws: ${draws} (${pct(draws)}%)`);
  console.log(`Openings logged to: ${OPENINGS_LOG}`);
}

// Run
runSimulation().catch(err => {
  console.error('Simulation failed', err && err.stack ? err.stack : err && err.message ? err.message : err);
  process.exit(2);
});
