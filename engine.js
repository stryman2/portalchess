// engine.js
// Portal Chess Engine (pure JS, no DOM) — MVP oriented
// Includes neutral-portal "cooldown" rule for neutral swap victims

const FILES = "ABCDEFGH".split("");
const RANKS = "12345678".split("");

// Portals (current settings)
const WHITE_PORTALS_SQS = ["D5", "F5", "E3", "B3"]; // Central Pressure
const BLACK_PORTALS_SQS = ["C4", "E4", "D6", "G6"]; // Counter-Attack
const NEUTRAL_PAIRS_SQS = [["B5", "G4"]];           // unchanged

function sqToIndex(sqRaw) {
  const sq = sqRaw.toUpperCase();
  const f = FILES.indexOf(sq[0]);
  const r = RANKS.indexOf(sq[1]);
  if (f < 0 || r < 0) throw new Error(`Bad square: ${sqRaw}`);
  return r * 8 + f;
}
function indexToSq(i) {
  const f = i % 8; const r = Math.floor(i / 8);
  return `${FILES[f]}${RANKS[r]}`;
}

// Build portal sets and helpers
function buildSet(arr) { return new Set(arr.map(s => s.toUpperCase())); }
const PORTALS = Object.freeze({
  white: buildSet(WHITE_PORTALS_SQS),
  black: buildSet(BLACK_PORTALS_SQS),
  neutralPairs: Object.freeze(NEUTRAL_PAIRS_SQS.map(([a,b]) => [a.toUpperCase(), b.toUpperCase()])),
  // Derived arrays for consumers that want indices/exits
  indices: Object.freeze({
    white: Object.freeze(WHITE_PORTALS_SQS.map(sq => sqToIndex(sq))),
    black: Object.freeze(BLACK_PORTALS_SQS.map(sq => sqToIndex(sq))),
    neutralPairs: Object.freeze(NEUTRAL_PAIRS_SQS.map(([a,b]) => [sqToIndex(a), sqToIndex(b)])),
  }),
  exits: (function buildExits() {
    const out = {};
    for (const s of WHITE_PORTALS_SQS) out[s.toUpperCase()] = WHITE_PORTALS_SQS.filter(x => x.toUpperCase() !== s.toUpperCase()).map(x => x.toUpperCase());
    for (const s of BLACK_PORTALS_SQS) out[s.toUpperCase()] = BLACK_PORTALS_SQS.filter(x => x.toUpperCase() !== s.toUpperCase()).map(x => x.toUpperCase());
    out["B5"] = ["G4"]; out["G4"] = ["B5"];
    return Object.freeze(out);
  })(),
});

// Initial board setup
function initialBoard() {
  const board = new Array(64).fill(null);
  const place = (sq, type, color) => board[sqToIndex(sq)] = { type, color, hasMoved: false };

  // Pawns
  for (let f of FILES) { place(`${f}2`, 'P', 'w'); place(`${f}7`, 'P', 'b'); }
  // Rooks
  place("A1",'R','w'); place("H1",'R','w'); place("A8",'R','b'); place("H8",'R','b');
  // Knights
  place("B1",'N','w'); place("G1",'N','w'); place("B8",'N','b'); place("G8",'N','b');
  // Bishops
  place("C1",'B','w'); place("F1",'B','w'); place("C8",'B','b'); place("F8",'B','b');
  // Queens
  place("D1",'Q','w'); place("D8",'Q','b');
  // Kings
  place("E1",'K','w'); place("E8",'K','b');

  return board;
}

export function initialState() {
  return {
    board: initialBoard(),
    turn: 'w',
    moveNumber: 1,
    enPassantTarget: null,
    castleRights: { K: true, Q: true, k: true, q: true },
    halfmoveClock: 0,
    portals: PORTALS,
    // NEW: neutral swap cooldown flags for each player.
    // If true for a color, that color may NOT use the neutral portal network on their next turn.
    neutralSwapCooldown: { w: false, b: false },
    // NEW: personal portal "no-return" mappings.
    // - `pendingPersonalNoReturn`: entries created when a piece uses an exclusive personal portal; they become active
    //   at the start of that owner's next turn (after the opponent moves).
    // - `personalNoReturn`: active one-turn restrictions for the side to move; keyed by landingSquare -> originSquare
    pendingPersonalNoReturn: { w: {}, b: {} },
    personalNoReturn: { w: {}, b: {} },
    history: [],
  };
}

// basic helpers
export function pieceToGlyph(p) {
  if (!p) return "";
  const map = {
    w: { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙" },
    b: { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" },
  };
  return map[p.color][p.type];
}
function pieceAt(state, sq) { return state.board[sqToIndex(sq)]; }
function setPiece(state, sq, pieceOrNull) { state.board[sqToIndex(sq)] = pieceOrNull; }

// Portal helpers that accept engine's PORTALS
function isPortalFor(color, sqRaw) {
  const sq = sqRaw.toUpperCase();
  if (PORTALS.white.has(sq)) return color === 'w' ? 'exclusive' : null;
  if (PORTALS.black.has(sq)) return color === 'b' ? 'exclusive' : null;
  for (const [a,b] of PORTALS.neutralPairs) {
    if (sq === a || sq === b) return 'neutral';
  }
  return null;
}
function neutralMate(sqRaw) {
  const sq = sqRaw.toUpperCase();
  for (const [a,b] of PORTALS.neutralPairs) {
    if (sq === a) return b;
    if (sq === b) return a;
  }
  return null;
}

// -------------------------
// Attack detection (non-recursive)
// -------------------------
// Returns true if `attackerColor` attacks square `sq` in `state`.
// This function deliberately avoids calling `generatePseudoLegalMoves` to
// prevent recursion when used during king/castle legality checks.
// It uses direct geometric checks for pawns/knights/kings/sliders and
// additionally scans portal-resolved outcomes for non-king attackers so
// that portal swaps which could capture the king are counted as attacks.
export function isSquareAttacked(state, sqRaw, attackerColor) {
  const target = sqRaw.toUpperCase();
  const tf = FILES.indexOf(target[0]);
  const tr = RANKS.indexOf(target[1]);
  if (tf < 0 || tr < 0) return false;

  const opponent = attackerColor;

  // Pawn attacks (direction depends on attacker color)
  const pawnDir = opponent === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const f = tf + df, r = tr - pawnDir; // attacker pawn sits one rank behind target
    if (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = `${FILES[f]}${RANKS[r]}`;
      const p = pieceAt(state, sq);
      if (p && p.color === opponent && p.type === 'P') return true;
    }
  }

  // Knight attacks
  const knightD = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  for (const [df, dr] of knightD) {
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = `${FILES[f]}${RANKS[r]}`;
      const p = pieceAt(state, sq);
      if (p && p.color === opponent && p.type === 'N') return true;
    }
  }

  // King adjacency (opponent king attacking)
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (df === 0 && dr === 0) continue;
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = `${FILES[f]}${RANKS[r]}`;
      const p = pieceAt(state, sq);
      if (p && p.color === opponent && p.type === 'K') return true;
    }
  }

  // Sliding pieces (rook/bishop/queen)
  const rayDirs = {
    rook: [[1,0],[-1,0],[0,1],[0,-1]],
    bishop: [[1,1],[1,-1],[-1,1],[-1,-1]]
  };
  // rook/queen
  for (const [df, dr] of rayDirs.rook) {
    let f = tf + df, r = tr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = `${FILES[f]}${RANKS[r]}`;
      const p = pieceAt(state, sq);
      if (p) {
        if (p.color === opponent && (p.type === 'R' || p.type === 'Q')) return true;
        break;
      }
      f += df; r += dr;
    }
  }
  // bishop/queen
  for (const [df, dr] of rayDirs.bishop) {
    let f = tf + df, r = tr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = `${FILES[f]}${RANKS[r]}`;
      const p = pieceAt(state, sq);
      if (p) {
        if (p.color === opponent && (p.type === 'B' || p.type === 'Q')) return true;
        break;
      }
      f += df; r += dr;
    }
  }

  // Portal scan: for each non-king attacker, see if any portal-resolved outcome can reach target
  // Build list of portal squares to consider (union of all known portal squares)
  const portalSquares = new Set([...PORTALS.white, ...PORTALS.black]);
  for (const [a,b] of PORTALS.neutralPairs) { portalSquares.add(a); portalSquares.add(b); }

  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p || p.color !== opponent) continue;
    if (p.type === 'K') continue; // king portal-activation cannot produce a swap-capture for castling checks

    const fromSq = `${FILES[i % 8]}${RANKS[Math.floor(i / 8)]}`;

    // 1) If attacker sits on a portal, consider portal-activation base moves (to each network destination)
    if (isPortalFor(p.color, fromSq)) {
      // derive possible activation destinations similar to generatePseudoLegalMoves
      const portalType = isPortalFor(p.color, fromSq);
      if (portalType === 'exclusive') {
        const network = p.color === 'w' ? PORTALS.white : PORTALS.black;
        for (const dest of network) {
          if (dest === fromSq) continue;
          const bm = { from: fromSq, to: dest, kind: 'portal-activation' };
          const outcomes = expandWithPortalOutcomes(state, bm);
          for (const o of outcomes) if ((o.toFinal || o.to).toUpperCase() === target) return true;
        }
      } else if (portalType === 'neutral') {
        const mate = neutralMate(fromSq);
        if (mate) {
          const bm = { from: fromSq, to: mate, kind: 'portal-activation' };
          const outcomes = expandWithPortalOutcomes(state, bm);
          for (const o of outcomes) if ((o.toFinal || o.to).toUpperCase() === target) return true;
        }
      }
    }

    // 2) For portal landing that an attacker could normally move onto, craft a base move to that portal square
    // Check movement reachability for this piece to each portal square without calling generatePseudoLegalMoves
    for (const destSq of portalSquares) {
      const dest = destSq.toUpperCase();
      const df = FILES.indexOf(dest[0]) - FILES.indexOf(fromSq[0]);
      const dr = RANKS.indexOf(dest[1]) - RANKS.indexOf(fromSq[1]);
      // Basic reach checks per piece type
      let canReach = false;
      switch (p.type) {
        case 'N': {
          const ok = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]].some(([a,b]) => a === df && b === dr);
          canReach = ok;
          break;
        }
        case 'K': {
          canReach = Math.abs(df) <= 1 && Math.abs(dr) <= 1;
          break;
        }
        case 'P': {
          const dir = p.color === 'w' ? 1 : -1;
          // pawn captures diagonally
          if (dr === dir && Math.abs(df) === 1) canReach = true;
          // forward moves to portal won't capture - they could land on a portal square if empty
          if (df === 0 && dr === dir) {
            // ensure square is empty
            if (!pieceAt(state, dest)) canReach = true;
          }
          break;
        }
        case 'B': {
          if (Math.abs(df) === Math.abs(dr) && df !== 0) {
            // ensure no blockers between
            const stepF = df / Math.abs(df), stepR = dr / Math.abs(dr);
            let f = FILES.indexOf(fromSq[0]) + stepF, r = RANKS.indexOf(fromSq[1]) + stepR;
            let blocked = false;
            while (`${FILES[f]}${RANKS[r]}` !== dest) {
              if (pieceAt(state, `${FILES[f]}${RANKS[r]}`)) { blocked = true; break; }
              f += stepF; r += stepR;
            }
            canReach = !blocked;
          }
          break;
        }
        case 'R': {
          if ((df === 0 && dr !== 0) || (dr === 0 && df !== 0)) {
            const stepF = df === 0 ? 0 : df / Math.abs(df);
            const stepR = dr === 0 ? 0 : dr / Math.abs(dr);
            let f = FILES.indexOf(fromSq[0]) + stepF, r = RANKS.indexOf(fromSq[1]) + stepR;
            let blocked = false;
            while (`${FILES[f]}${RANKS[r]}` !== dest) {
              if (pieceAt(state, `${FILES[f]}${RANKS[r]}`)) { blocked = true; break; }
              f += stepF; r += stepR;
            }
            canReach = !blocked;
          }
          break;
        }
        case 'Q': {
          if ((Math.abs(df) === Math.abs(dr) && df !== 0) || (df === 0 && dr !== 0) || (dr === 0 && df !== 0)) {
            const stepF = df === 0 ? 0 : df / Math.abs(df);
            const stepR = dr === 0 ? 0 : dr / Math.abs(dr);
            let f = FILES.indexOf(fromSq[0]) + stepF, r = RANKS.indexOf(fromSq[1]) + stepR;
            let blocked = false;
            while (`${FILES[f]}${RANKS[r]}` !== dest) {
              if (pieceAt(state, `${FILES[f]}${RANKS[r]}`)) { blocked = true; break; }
              f += stepF; r += stepR;
            }
            canReach = !blocked;
          }
          break;
        }
      }

      if (!canReach) continue;
      // craft a base move and expand
      const occupant = pieceAt(state, dest);
      const kind = occupant && occupant.color !== p.color ? 'capture' : 'move';
      const bm = { from: fromSq, to: dest, kind };
      try {
        const outcomes = expandWithPortalOutcomes(state, bm);
        for (const o of outcomes) if ((o.toFinal || o.to).toUpperCase() === target) return true;
      } catch (e) {
        // ignore expansion error
      }
    }
  }

  return false;
}

// Move generation (basic): knights, bishops, rooks, queens, king, pawns (no castling/ep/promo)
export function generatePseudoLegalMoves(state, fromSqRaw) {
  const fromSq = fromSqRaw.toUpperCase();
  const p = pieceAt(state, fromSq);
  if (!p || p.color !== state.turn) return [];

  const out = [];
  const add = (toRaw, kind="move") => {
    const to = toRaw.toUpperCase();
    const tf = FILES.indexOf(to[0]);
    const tr = RANKS.indexOf(to[1]);
    if (tf < 0 || tr < 0) return;
    const tgt = pieceAt(state, to);
    let k = kind;
    if (tgt && tgt.color === p.color) return;
    if (tgt && tgt.color !== p.color && k === "move") k = "capture";
    out.push({ from: fromSq, to, kind: k });
  };

  const f0 = FILES.indexOf(fromSq[0]), r0 = RANKS.indexOf(fromSq[1]);

  const addRays = (deltas) => {
    for (const [df, dr] of deltas) {
      let f = f0 + df, r = r0 + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const s = `${FILES[f]}${RANKS[r]}`;
        const tgt = pieceAt(state, s);
        if (!tgt) {
          add(s, "move");
        } else {
          if (tgt.color !== p.color) add(s, "capture");
          break;
        }
        f += df; r += dr;
      }
    }
  };

  switch (p.type) {
    case 'N': {
      const deltas = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
      for (const [df, dr] of deltas) {
        const f = f0 + df, r = r0 + dr;
        if (f>=0 && f<8 && r>=0 && r<8) add(`${FILES[f]}${RANKS[r]}`);
      }
      break;
    }
    case 'B': addRays([[1,1],[1,-1],[-1,1],[-1,-1]]); break;
    case 'R': addRays([[1,0],[-1,0],[0,1],[0,-1]]); break;
    case 'Q': addRays([[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]); break;
    case 'K': {
      const deltas = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [df, dr] of deltas) {
        const f = f0 + df, r = r0 + dr;
        if (f>=0 && f<8 && r>=0 && r<8) add(`${FILES[f]}${RANKS[r]}`);
      }
      // ---- Castling (pseudo-legal) ----
      // Conditions enforced here:
      // - king and rook haven't moved (and castleRights permit),
      // - squares between are empty,
      // - king not currently in check,
      // - origin, via, and destination squares are not attacked by opponent.
      try {
        if (!p.hasMoved) {
          const color = p.color;
          const opp = color === 'w' ? 'b' : 'w';
          const rank = color === 'w' ? '1' : '8';
          const origin = fromSq.toUpperCase();

          // Kingside
          const ksRight = color === 'w' ? state.castleRights && state.castleRights.K : state.castleRights && state.castleRights.k;
          if (ksRight) {
            const fSq = `F${rank}`;
            const gSq = `G${rank}`;
            const rookSq = `H${rank}`;
            const rook = pieceAt(state, rookSq);
            if (!pieceAt(state, fSq) && !pieceAt(state, gSq) && rook && rook.type === 'R' && rook.color === color && !rook.hasMoved) {
              if (!isSquareAttacked(state, origin, opp) && !isSquareAttacked(state, fSq, opp) && !isSquareAttacked(state, gSq, opp)) {
                out.push({ from: fromSq, to: gSq, kind: 'castle', meta: { castle: 'K' } });
              }
            }
          }

          // Queenside
          const qsRight = color === 'w' ? state.castleRights && state.castleRights.Q : state.castleRights && state.castleRights.q;
          if (qsRight) {
            const bSq = `B${rank}`;
            const cSq = `C${rank}`;
            const dSq = `D${rank}`;
            const rookSq = `A${rank}`;
            const rook = pieceAt(state, rookSq);
            // require b,c,d empty (conservative as requested)
            if (!pieceAt(state, bSq) && !pieceAt(state, cSq) && !pieceAt(state, dSq) && rook && rook.type === 'R' && rook.color === color && !rook.hasMoved) {
              // origin (E), via (D), dest (C) must not be attacked
              const viaSq = dSq;
              const destSq = cSq;
              if (!isSquareAttacked(state, origin, opp) && !isSquareAttacked(state, viaSq, opp) && !isSquareAttacked(state, destSq, opp)) {
                out.push({ from: fromSq, to: destSq, kind: 'castle', meta: { castle: 'Q' } });
              }
            }
          }
        }
      } catch (e) {
        // if attack checks fail for any reason, don't add castle moves
      }
      break;
    }
    case 'P': {
      const dir = p.color === 'w' ? 1 : -1;
      const startRank = p.color === 'w' ? 1 : 6;
      const finalRank = p.color === 'w' ? 7 : 0;
      const r1 = r0 + dir;
      // Forward one
      if (r1 >= 0 && r1 < 8) {
        const one = `${FILES[f0]}${RANKS[r1]}`;
        // If this forward move lands on the final rank, generate promotion pseudo-moves
        if (!pieceAt(state, one)) {
          if (r1 === finalRank) {
            // Generate one pseudo-move per promotion type. These are of kind 'promotion'
            // and carry meta.promo so the UI/expander can resolve them immediately.
            ['Q','R','B','N'].forEach(pt => out.push({ from: fromSq, to: one, kind: 'promotion', meta: { promo: pt } }));
          } else {
            add(one, "move");
            const r2 = r0 + 2*dir;
            if (r0 === startRank && r2 >= 0 && r2 < 8) {
              const two = `${FILES[f0]}${RANKS[r2]}`;
              if (!pieceAt(state, two)) add(two, "move");
            }
          }
        }
      }

      // Captures (including promotion-captures when landing on final rank)
      for (const df of [-1, 1]) {
        const f = f0 + df, r = r0 + dir;
        if (f>=0 && f<8 && r>=0 && r<8) {
          const diag = `${FILES[f]}${RANKS[r]}`;
          const tgt = pieceAt(state, diag);
          if (tgt && tgt.color !== p.color) {
            if (r === finalRank) {
              // capture that lands on final rank -> promotions
              ['Q','R','B','N'].forEach(pt => out.push({ from: fromSq, to: diag, kind: 'promotion', meta: { promo: pt } }));
            } else {
              add(diag, "capture");
            }
          }
        }
      }
      break;
    }
  }

  // ---- Portal-activation moves when the piece starts on a portal ----
  const portalType = isPortalFor(p.color, fromSq); // 'exclusive' | 'neutral' | null
  if (portalType === 'exclusive') {
    // For exclusive networks, allow teleport to any other portal in the same network
    const network = p.color === 'w' ? PORTALS.white : PORTALS.black;
    for (const dest of network) {
      if (dest === fromSq) continue;
      const occupant = pieceAt(state, dest);
      if (occupant && occupant.color === p.color) continue; // cannot jump onto own piece
      // Respect personal portal "no-return" restriction: if this piece (on `fromSq`) has an
      // active personalNoReturn mapping, it may not jump back to the origin it came from for this turn.
      const forbidden = (state.personalNoReturn && state.personalNoReturn[p.color]) ? state.personalNoReturn[p.color][fromSq] : undefined;
      if (forbidden && forbidden === dest) continue;
      out.push({ from: fromSq, to: dest, kind: "portal-activation" });
    }
  } else if (portalType === 'neutral') {
    // NEW: respect neutral swap cooldown: if this player's neutralSwapCooldown is true,
    // they are not allowed to use the neutral portal on this turn.
    // (This enforces the "victim can't use the neutral portal on their very next turn" rule.)
    const cooldown = state.neutralSwapCooldown && state.neutralSwapCooldown[p.color];
    if (!cooldown) {
      const mate = neutralMate(fromSq);
      if (mate) {
        const occupant = pieceAt(state, mate);
        if (!(occupant && occupant.color === p.color)) {
          out.push({ from: fromSq, to: mate, kind: "portal-activation" });
        }
      }
    } else {
      // cooldown true: skip adding neutral portal activation for this piece
    }
  }

  return out;
}

// Portal resolution rules
export function expandWithPortalOutcomes(state, baseMove) {
  // If this is a promotion base move, resolve it immediately and DO NOT
  // branch into portal outcomes. Promotion is triggered only when the pawn
  // physically lands on the final rank by its normal move/capture path.
  // Therefore portal-activation or portal-redirects must not create
  // additional promotion variants.
  if (baseMove.kind === 'promotion') {
    const landingSq = (baseMove.to || '').toUpperCase();
    // Carry through any declared promo metadata so the resolver/UI can use it.
    const promoType = baseMove.meta?.promo || baseMove.promo || baseMove.promotion;
    return [{ ...baseMove, toFinal: landingSq, kind: 'promotion', promo: promoType }];
  }

  // Immediate portal-activation resolution
  if (baseMove.kind === "portal-activation") {
    const mover = pieceAt(state, baseMove.from);
    const entry = baseMove.from.toUpperCase();
    const landingSq = baseMove.to.toUpperCase();
    const occupant = pieceAt(state, landingSq);
    if (occupant && occupant.color === mover.color) return [];
    if (!occupant) {
      return [{ ...baseMove, toFinal: landingSq, viaPortal: { entry, network: isPortalFor(mover.color, entry) || 'neutral', choice: landingSq, swapped: false } }];
    } else {
      return [{ ...baseMove, toFinal: landingSq, viaPortal: { entry, network: isPortalFor(mover.color, entry) || 'neutral', choice: landingSq, swapped: true } }];
    }
  }

  const mover = pieceAt(state, baseMove.from);
  const landingSq = baseMove.to.toUpperCase();
  const portalType = isPortalFor(mover.color, landingSq);

  // Capture on a portal does NOT activate it (incl. en passant)
  const isCaptureOnPortal = (baseMove.kind === "capture" || baseMove.kind === "enpassant") && portalType;
  if (isCaptureOnPortal) {
    return [{ ...baseMove, toFinal: landingSq, viaPortal: undefined }];
  }

  // Not a portal
  if (!portalType) return [{ ...baseMove, toFinal: landingSq }];

  // Exclusive network: Stay or jump to other network portals; swap on enemy destination
  if (portalType === 'exclusive') {
    const network = mover.color === 'w' ? PORTALS.white : PORTALS.black;
    const choices = [...network].filter(sq => sq !== landingSq);
    const outcomes = [{ ...baseMove, toFinal: landingSq, viaPortal: { entry: landingSq, network: 'exclusive', choice: "STAY", swapped: false } }];
    for (const dest of choices) {
      const occupant = pieceAt(state, dest);
      if (!occupant) {
        outcomes.push({ ...baseMove, toFinal: dest, viaPortal: { entry: landingSq, network: 'exclusive', choice: dest, swapped: false } });
      } else if (occupant.color !== mover.color) {
        outcomes.push({ ...baseMove, toFinal: dest, viaPortal: { entry: landingSq, network: 'exclusive', choice: dest, swapped: true } });
      }
    }
    return outcomes;
  }

  // Neutral pair: Stay or jump to mate; swap on enemy at mate
  if (portalType === 'neutral') {
    const mate = neutralMate(landingSq);
    const outcomes = [{ ...baseMove, toFinal: landingSq, viaPortal: { entry: landingSq, network: 'neutral', choice: "STAY", swapped: false } }];
    const occupant = pieceAt(state, mate);
    if (!occupant) {
      outcomes.push({ ...baseMove, toFinal: mate, viaPortal: { entry: landingSq, network: 'neutral', choice: mate, swapped: false } });
    } else if (occupant?.color !== mover.color) {
      outcomes.push({ ...baseMove, toFinal: mate, viaPortal: { entry: landingSq, network: 'neutral', choice: mate, swapped: true } });
    }
    return outcomes;
  }

  return [{ ...baseMove, toFinal: landingSq }];
}

// Apply a resolved move and return a new state (does not mutate original state)
export function applyResolvedMove(state, resolved) {
  const next = typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  // ensure castleRights is copied into next for conservative updates
  next.castleRights = next.castleRights || (state.castleRights ? { ...state.castleRights } : { K: true, Q: true, k: true, q: true });
  // Use the cloned 'next' board pieces where possible so we don't mutate the
  // original `state`'s piece objects (which previously caused hasMoved flags
  // to leak into the live state and accidentally disable castling).
  const mover = next.board[sqToIndex(resolved.from)] || state.board[sqToIndex(resolved.from)];
  if (!mover) throw new Error("No moving piece");

  // Clear en passant target by default
  next.enPassantTarget = null;
  // Handle castle specially
  if (resolved.kind === 'castle') {
    const color = mover.color;
    const rank = color === 'w' ? '1' : '8';
    const originIdx = sqToIndex(resolved.from);
    const kingDest = (resolved.to || resolved.toFinal).toUpperCase();

    // clear origin
    next.board[originIdx] = null;
    // place king at destination
    next.board[sqToIndex(kingDest)] = mover;

    // Determine rook movement
    const castleType = resolved.meta && resolved.meta.castle;
    let rookFrom = null, rookTo = null;
    if (castleType === 'K') { rookFrom = `H${rank}`; rookTo = `F${rank}`; }
    else { rookFrom = `A${rank}`; rookTo = `D${rank}`; }

    // Prefer the rook object from the cloned next board to avoid mutating the
    // original state objects.
    const rook = next.board[sqToIndex(rookFrom)] || state.board[sqToIndex(rookFrom)];
    if (rook && rook.type === 'R' && rook.color === color) {
      // clear rook origin and place at target on the cloned board
      next.board[sqToIndex(rookFrom)] = null;
      next.board[sqToIndex(rookTo)] = rook;
      rook.hasMoved = true;
    }

    // Mark the king as moved on the cloned object
    mover.hasMoved = true;

    // Clear both castle rights for this color
    if (color === 'w') { next.castleRights.K = false; next.castleRights.Q = false; }
    else { next.castleRights.k = false; next.castleRights.q = false; }

    // consume mover's neutralSwapCooldown for the moving side
    next.neutralSwapCooldown = next.neutralSwapCooldown || { w: false, b: false };
    next.neutralSwapCooldown[mover.color] = false;

    // Switch turn and record
    next.turn = state.turn === 'w' ? 'b' : 'w';
    if (next.turn === 'w') next.moveNumber += 1;
    next.history = next.history || [];
    next.history.push(resolved);
    return next;
  }

  // --- PROMOTION handling ---
  // Promotions must be applied immediately: the pawn is replaced by the chosen
  // piece on the destination square. Promotions do not branch into portal
  // outcomes — promo only happens when the pawn physically lands on the final
  // rank by its normal move/capture, and thus are resolved here.
  if (resolved.kind === 'promotion') {
    const destSq = (resolved.toFinal || resolved.to).toUpperCase();
    const destIdx = sqToIndex(destSq);

    // If there's an opponent piece on the target, capture it
    const cap = next.board[destIdx];
    if (cap && cap.color !== mover.color) {
      next.board[destIdx] = null;
      // Clear castle rights if a rook was captured on its original square
      const capSq = destSq;
      if (capSq === 'A1') next.castleRights.Q = false;
      if (capSq === 'H1') next.castleRights.K = false;
      if (capSq === 'A8') next.castleRights.q = false;
      if (capSq === 'H8') next.castleRights.k = false;
    }

    // Clear origin and place the promoted piece
    next.board[sqToIndex(resolved.from)] = null;
    const promoType = (resolved.meta && resolved.meta.promo) || resolved.promo || resolved.promotion;
    if (!promoType) throw new Error('Promotion missing promo type');
    next.board[destIdx] = { type: promoType, color: mover.color, hasMoved: true };

    // Pawn move resets halfmove clock
    next.halfmoveClock = 0;

    // Consume mover's neutral-swap cooldown flag (non-critical)
    next.neutralSwapCooldown = next.neutralSwapCooldown || { w: false, b: false };
    try { next.neutralSwapCooldown[mover.color] = false; } catch (e) {}

    // Switch turn and record
    next.turn = state.turn === 'w' ? 'b' : 'w';
    if (next.turn === 'w') next.moveNumber += 1;
    next.history = next.history || [];
    next.history.push(resolved);

    // Promote any pending personal-no-return mappings for the side about to move
    next.pendingPersonalNoReturn = next.pendingPersonalNoReturn || { w: {}, b: {} };
    next.personalNoReturn = next.personalNoReturn || { w: {}, b: {} };
    try {
      const upcoming = next.turn;
      if (next.pendingPersonalNoReturn && next.pendingPersonalNoReturn[upcoming] && Object.keys(next.pendingPersonalNoReturn[upcoming]).length > 0) {
        next.personalNoReturn[upcoming] = { ...next.pendingPersonalNoReturn[upcoming] };
        next.pendingPersonalNoReturn[upcoming] = {};
      }
    } catch (e) { }

    // Consume any active personalNoReturn for the mover (they've just moved)
    try { next.personalNoReturn[mover.color] = {}; } catch (e) {}

    return next;
  }

  // Remove captured piece on landing square (non-EP)
  if (resolved.kind === "capture") {
    next.board[sqToIndex(resolved.to)] = null;
    // If a rook on its original square was captured, clear corresponding rights
    const cap = (resolved.to || '').toUpperCase();
    if (cap === 'A1') next.castleRights.Q = false;
    if (cap === 'H1') next.castleRights.K = false;
    if (cap === 'A8') next.castleRights.q = false;
    if (cap === 'H8') next.castleRights.k = false;
  }

  // Move the piece from 'from' (clear origin)
  next.board[sqToIndex(resolved.from)] = null;

  // If swap via portal (swapped), do the swap: mover -> dest, opponent -> entry
  if (resolved.viaPortal?.swapped) {
    const entry = resolved.viaPortal.entry; // entry square (where mover jumped from)
    const dest = resolved.toFinal;
    const opponent = next.board[sqToIndex(dest)]; // in next (cloned) board, dest still holds opponent
    // place mover at dest, place opponent at entry
    next.board[sqToIndex(dest)] = mover;
    next.board[sqToIndex(entry)] = opponent;

    // NEW: If this swap involved the NEUTRAL network, set cooldown for the victim (opponent)
    try {
      if (resolved.viaPortal.network === 'neutral' || isPortalFor(null, resolved.viaPortal.entry) === 'neutral' || isPortalFor(null, dest) === 'neutral') {
        const victimColor = mover.color === 'w' ? 'b' : 'w';
        // Set cooldown on the victim so they cannot use the neutral portal on their next turn
        next.neutralSwapCooldown = next.neutralSwapCooldown || { w: false, b: false };
        next.neutralSwapCooldown[victimColor] = true;
      }
    } catch (e) {
      // ignore if any lookup fails; cooldown not critical
    }
  } else {
    // No swap: mover simply ends at toFinal on the cloned board
    next.board[sqToIndex(resolved.toFinal)] = mover;
  }

  // Mark mover as moved (on the cloned object)
  mover.hasMoved = true;

  // If this move was a portal activation on an exclusive (personal) network,
  // schedule a pending one-turn no-return mapping so it becomes active
  // at the start of the mover's next turn (after the opponent moves).
  try {
    const net = resolved.viaPortal && resolved.viaPortal.network;
    const destSq = (resolved.toFinal || resolved.to).toUpperCase();
    // Prefer the portal entry as the origin when available (covers move->portal->jump cases).
    const originSq = (resolved.viaPortal && resolved.viaPortal.entry ? resolved.viaPortal.entry.toUpperCase() : (resolved.from || '').toUpperCase());
    // Only schedule when this resolved outcome actually used the portal network to jump (choice !== 'STAY')
    const usedPortalJump = resolved.viaPortal && resolved.viaPortal.choice && resolved.viaPortal.choice !== 'STAY';
    if (net === 'exclusive' && usedPortalJump) {
      next.pendingPersonalNoReturn = next.pendingPersonalNoReturn || { w: {}, b: {} };
      next.pendingPersonalNoReturn[mover.color] = next.pendingPersonalNoReturn[mover.color] || {};
      next.pendingPersonalNoReturn[mover.color][destSq] = originSq;
    }
  } catch (e) {
    // non-critical
  }

  // If a king moved, clear castle rights for that color. If a rook moved from an original square, clear that side.
  try {
    if (mover.type === 'K') {
      if (mover.color === 'w') { next.castleRights.K = false; next.castleRights.Q = false; }
      else { next.castleRights.k = false; next.castleRights.q = false; }
    } else if (mover.type === 'R') {
      const from = (resolved.from || '').toUpperCase();
      if (from === 'A1') next.castleRights.Q = false;
      if (from === 'H1') next.castleRights.K = false;
      if (from === 'A8') next.castleRights.q = false;
      if (from === 'H8') next.castleRights.k = false;
    }
  } catch (e) {
    // ignore
  }

  // NEW: After the mover completes their move, clear THAT mover's cooldown flag (the one-time prohibition is consumed)
  next.neutralSwapCooldown = next.neutralSwapCooldown || { w: false, b: false };
  try { next.neutralSwapCooldown[mover.color] = false; } catch (e) {}

  // Switch turn and record
  next.turn = state.turn === 'w' ? 'b' : 'w';
  if (next.turn === 'w') next.moveNumber += 1;
  next.history = next.history || [];
  next.history.push(resolved);

  // Promote any pending personal-no-return mappings for the side about to move into active restrictions.
  // This makes a restriction (created when a player used a portal) become active at the start of their next turn.
  next.pendingPersonalNoReturn = next.pendingPersonalNoReturn || { w: {}, b: {} };
  next.personalNoReturn = next.personalNoReturn || { w: {}, b: {} };
  try {
    const upcoming = next.turn; // side who will now move
    // If there's a pending restriction for the upcoming side, promote it into personalNoReturn and clear pending
    if (next.pendingPersonalNoReturn && next.pendingPersonalNoReturn[upcoming] && Object.keys(next.pendingPersonalNoReturn[upcoming]).length > 0) {
      next.personalNoReturn[upcoming] = { ...next.pendingPersonalNoReturn[upcoming] };
      next.pendingPersonalNoReturn[upcoming] = {};
    }
  } catch (e) {
    // ignore
  }

  // Consume any active personalNoReturn for the mover (they've just moved, so the one-turn restriction is finished)
  try { next.personalNoReturn[mover.color] = {}; } catch (e) {}

  return next;
}

// --- NEW: Check detection and legal move filtering (unchanged) ---

// Return true if `color`'s king is attacked in `state`
export function inCheck(state, color) {
  // find king square
  let kingSq = null;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.type === 'K' && p.color === color) {
      kingSq = `${FILES[i % 8]}${RANKS[Math.floor(i / 8)]}`;
      break;
    }
  }
  if (!kingSq) return false;

  const opponent = color === 'w' ? 'b' : 'w';
  const tmp = typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  tmp.turn = opponent;

  for (let i = 0; i < 64; i++) {
    const p = tmp.board[i];
    if (!p || p.color !== opponent) continue;
    const fromSq = `${FILES[i % 8]}${RANKS[Math.floor(i / 8)]}`;
    const baseMoves = generatePseudoLegalMoves(tmp, fromSq);
    for (const bm of baseMoves) {
      const outcomes = expandWithPortalOutcomes(tmp, bm);
      for (const o of outcomes) {
        const dest = (o.toFinal || o.to).toUpperCase();
        if (dest === kingSq.toUpperCase()) return true;
      }
    }
  }
  return false;
}

// Filter an array of resolved moves, keeping only those that do not leave the mover in check
export function filterLegalByCheck(state, resolvedMoves) {
  const legal = [];
  for (const m of resolvedMoves) {
    try {
      const after = applyResolvedMove(state, m);
      const moverColor = state.turn;
      if (!inCheck(after, moverColor)) legal.push(m);
    } catch (err) {
      // ignore invalid/applied moves that error
    }
  }
  return legal;
}
// --- Sample-based audio loader ---
export const SOUND_FILES = {
  move: '/sounds/move.mp3',
  capture: '/sounds/capture.mp3',
  portal: '/sounds/portal.mp3',
  promotion: '/sounds/promotion.mp3',
  check: '/sounds/check.mp3',
  castle: '/sounds/castle.mp3'
};
