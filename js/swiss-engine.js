/* ============================================================
 * SwissEngine — motor de torneo suizo de dominó
 * Modalidades:
 *   - "individual": mesas de 4 jugadores (2 vs 2, compañeros rotativos)
 *   - "parejas":    mesas de 2 parejas (pareja vs pareja)
 *
 * Motor puro: sin DOM y sin localStorage. Las funciones mutan el
 * estado recibido y devuelven warnings; el llamador persiste/renderiza.
 * Cargable con <script> (window.SwissEngine) y con node (module.exports).
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.SwissEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA_VERSION = 3;
  const STORAGE_KEY = "domino_torneo_v3";
  const TIEBREAK_LABEL = "Ganadas → Buchholz → DIF → Puntos";

  const MODES = {
    individual: { teamSize: 2, unitsPerTable: 4, unitLabel: "jugador", unitLabelPlural: "jugadores" },
    parejas:    { teamSize: 1, unitsPerTable: 2, unitLabel: "pareja",  unitLabelPlural: "parejas" }
  };

  // Pesos de la función de coste del emparejamiento
  const W_PARTNER = 1e6;  // compañero repetido (solo 2ª pasada; en 1ª es inviable)
  const W_RIVAL   = 100;  // cada enfrentamiento repetido
  const W_SPREAD  = 1;    // distancia de ranking dentro de la mesa (carácter Monrad)
  const MAX_NODES = 20000;
  const RANK_WINDOW = 11; // candidatos por nivel en la búsqueda individual

  /* ===================== utilidades ===================== */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  function parseScore(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }

  function tableScored(t) {
    const a = parseScore(t.ptsA), b = parseScore(t.ptsB);
    return a !== null && b !== null && !Number.isNaN(a) && !Number.isNaN(b) && a !== b;
  }

  function roundIsComplete(roundObj) {
    return roundObj.tables.length > 0 && roundObj.tables.every(tableScored);
  }

  /* ===================== estado ===================== */

  function getParticipant(state, id) {
    return state.participants.find(p => p.id === id) || null;
  }

  function nameOf(state, id) {
    const p = getParticipant(state, id);
    return p ? p.name : "(?" + id + ")";
  }

  function activeIds(state) {
    return state.participants.filter(p => p.active).map(p => p.id);
  }

  function allTables(state) {
    const out = [];
    for (const r of state.rounds) for (const t of r.tables) out.push(t);
    if (state.byeRound) for (const t of state.byeRound.tables) out.push(t);
    return out;
  }

  function pairName(members) { return members.map(s => s.trim()).filter(Boolean).join(" & "); }

  function createTournament(opts, rng = Math.random) {
    const { mode, maxRounds, participants } = opts || {};
    if (!MODES[mode]) throw new Error("Modalidad inválida.");
    const cfg = MODES[mode];
    if (!Number.isInteger(maxRounds) || maxRounds < 4 || maxRounds > 50)
      throw new Error("El torneo debe tener entre 4 y 50 rondas.");
    if (!Array.isArray(participants)) throw new Error("Lista de participantes inválida.");

    const state = {
      schemaVersion: SCHEMA_VERSION,
      mode,
      createdAt: new Date().toISOString(),
      maxRounds,
      nextId: 1,
      participants: [],
      rounds: [],
      byeRound: null,
      benchHistory: {},
      benchQueue: []
    };
    for (const p of participants) addParticipant(state, p);
    if (state.participants.length < cfg.unitsPerTable)
      throw new Error(`Necesitas mínimo ${cfg.unitsPerTable} ${cfg.unitLabelPlural}.`);
    state.benchQueue = shuffle(state.participants.map(p => p.id), rng);
    return state;
  }

  /* ===================== validación de carga ===================== */

  function validateState(raw) {
    const errors = [];
    const fail = msg => { errors.push(msg); };
    if (!raw || typeof raw !== "object") return { ok: false, errors: ["No hay datos de torneo."] };
    if (raw.schemaVersion !== SCHEMA_VERSION) fail("Versión de datos incompatible.");
    if (!MODES[raw.mode]) fail("Modalidad desconocida.");
    if (!Number.isInteger(raw.maxRounds) || raw.maxRounds < 1) fail("maxRounds inválido.");
    if (!Array.isArray(raw.participants) || raw.participants.length === 0) fail("Participantes inválidos.");
    if (errors.length) return { ok: false, errors };

    const cfg = MODES[raw.mode];
    const ids = new Set();
    for (const p of raw.participants) {
      if (!p || typeof p.id !== "string" || typeof p.name !== "string" || !p.name.trim() ||
          !Array.isArray(p.members) || typeof p.active !== "boolean") {
        fail("Participante con formato inválido."); break;
      }
      if (ids.has(p.id)) { fail("IDs de participante duplicados."); break; }
      ids.add(p.id);
    }
    if (errors.length) return { ok: false, errors };

    const validTeam = (team) =>
      Array.isArray(team) && team.length === cfg.teamSize &&
      team.every(id => ids.has(id)) && new Set(team).size === team.length;

    const validTable = (t) =>
      t && typeof t === "object" && Number.isInteger(t.table) &&
      validTeam(t.teamA) && validTeam(t.teamB) &&
      t.teamA.every(id => !t.teamB.includes(id)) &&
      !Number.isNaN(parseScore(t.ptsA)) && !Number.isNaN(parseScore(t.ptsB));

    if (!Array.isArray(raw.rounds)) fail("Rondas inválidas.");
    else {
      for (let i = 0; i < raw.rounds.length; i++) {
        const r = raw.rounds[i];
        if (!r || r.round !== i + 1 || !Array.isArray(r.tables) || !r.tables.every(validTable) ||
            !Array.isArray(r.bench) || !r.bench.every(id => ids.has(id)) ||
            !Array.isArray(r.warnings)) {
          fail(`Ronda ${i + 1} con formato inválido.`); break;
        }
      }
    }
    if (raw.byeRound !== null && raw.byeRound !== undefined) {
      const b = raw.byeRound;
      if (!b || typeof b !== "object" || !Array.isArray(b.tables) || !b.tables.every(validTable) ||
          !Array.isArray(b.excluded) || !b.excluded.every(id => ids.has(id)) ||
          !Array.isArray(b.warnings) || b.tables.length === 0)
        fail("Ronda bye con formato inválido.");
    }
    if (errors.length) return { ok: false, errors };

    // Normalización defensiva de banco: todo participante existe en
    // benchHistory y aparece exactamente una vez en benchQueue.
    const state = raw;
    state.byeRound = state.byeRound || null;
    const hist = {};
    for (const p of state.participants) {
      const h = state.benchHistory && state.benchHistory[p.id];
      hist[p.id] = Number.isInteger(h) && h >= 0 ? h : 0;
    }
    state.benchHistory = hist;
    const seen = new Set();
    const queue = [];
    if (Array.isArray(state.benchQueue))
      for (const id of state.benchQueue)
        if (ids.has(id) && !seen.has(id)) { seen.add(id); queue.push(id); }
    for (const p of state.participants)
      if (!seen.has(p.id)) { seen.add(p.id); queue.push(p.id); }
    state.benchQueue = queue;
    if (!Number.isInteger(state.nextId)) {
      state.nextId = 1 + Math.max(0, ...state.participants.map(p => Number(String(p.id).replace(/\D/g, "")) || 0));
    }
    return { ok: true, state, errors: [] };
  }

  /* ===================== clasificación ===================== */

  function computeStandings(state) {
    const stats = new Map(state.participants.map(p => [p.id, {
      id: p.id, name: p.name, retired: !p.active,
      PJ: 0, G: 0, P: 0, PF: 0, PC: 0, DIF: 0, BUC: 0, PTS: 0, _opps: new Set()
    }]));
    for (const t of allTables(state)) {
      if (!tableScored(t)) continue;
      const a = parseScore(t.ptsA), b = parseScore(t.ptsB);
      const [winTeam, losTeam] = a > b ? [t.teamA, t.teamB] : [t.teamB, t.teamA];
      const [winPts, losPts] = a > b ? [a, b] : [b, a];
      for (const id of winTeam) {
        const s = stats.get(id); if (!s) continue;
        s.PJ++; s.G++; s.PTS++; s.PF += winPts; s.PC += losPts;
        for (const opp of losTeam) s._opps.add(opp);
      }
      for (const id of losTeam) {
        const s = stats.get(id); if (!s) continue;
        s.PJ++; s.P++; s.PF += losPts; s.PC += winPts;
        for (const opp of winTeam) s._opps.add(opp);
      }
    }
    for (const s of stats.values()) s.DIF = s.PF - s.PC;
    // Buchholz: victorias de rivales únicos (un rival enfrentado dos veces cuenta una vez)
    for (const s of stats.values()) {
      let buc = 0;
      for (const opp of s._opps) buc += stats.get(opp) ? stats.get(opp).G : 0;
      s.BUC = buc;
    }
    const rows = [...stats.values()];
    rows.sort((x, y) =>
      y.PTS !== x.PTS ? y.PTS - x.PTS :
      y.BUC !== x.BUC ? y.BUC - x.BUC :
      y.DIF !== x.DIF ? y.DIF - x.DIF :
      y.PF  !== x.PF  ? y.PF  - x.PF  :
      x.name.localeCompare(y.name)
    );
    for (const s of rows) delete s._opps;
    return rows;
  }

  /* ===================== historial de emparejamientos ===================== */

  // Derivado siempre de rounds+byeRound: única fuente de verdad,
  // robusto ante ediciones y renombres (todo es por ID).
  function pairingHistory(state) {
    const partnerKeys = new Set();         // individual: parejas de equipo ya usadas
    const rivalCounts = new Map();         // individual: nº de veces enfrentados
    const playedKeys = new Set();          // parejas: cruces ya jugados
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const t of allTables(state)) {
      if (state.mode === "individual") {
        partnerKeys.add(pairKey(t.teamA[0], t.teamA[1]));
        partnerKeys.add(pairKey(t.teamB[0], t.teamB[1]));
        for (const x of t.teamA) for (const y of t.teamB) bump(rivalCounts, pairKey(x, y));
      } else {
        playedKeys.add(pairKey(t.teamA[0], t.teamB[0]));
      }
    }
    return { partnerKeys, rivalCounts, playedKeys };
  }

  /* ===================== banco rotativo ===================== */

  function _selectBench(state, rankedPool) {
    const cfg = MODES[state.mode];
    const k = rankedPool.length % cfg.unitsPerTable;
    if (k === 0) return { bench: [], active: rankedPool.slice() };
    // Cola estabilizada: menos descansos primero; a igualdad, orden de cola (FIFO).
    // Garantiza equidad max−min ≤ 1 incluso tras altas/bajas a mitad de torneo.
    const inPool = new Set(rankedPool);
    const candidates = state.benchQueue.filter(id => inPool.has(id));
    candidates.sort((a, b) => (state.benchHistory[a] || 0) - (state.benchHistory[b] || 0) ||
                              state.benchQueue.indexOf(a) - state.benchQueue.indexOf(b));
    const bench = candidates.slice(0, k);
    for (const id of bench) {
      state.benchHistory[id] = (state.benchHistory[id] || 0) + 1;
      const i = state.benchQueue.indexOf(id);
      if (i >= 0) state.benchQueue.splice(i, 1);
      state.benchQueue.push(id);
    }
    const benchSet = new Set(bench);
    const active = rankedPool.filter(id => !benchSet.has(id));
    if (active.length % cfg.unitsPerTable !== 0)
      throw new Error("Error interno: activos no son múltiplo del tamaño de mesa.");
    return { bench, active };
  }

  /* ===================== emparejamiento: PAREJAS ===================== */

  // Monrad 1º vs 2º con backtracking completo. La 1ª pasada es búsqueda
  // exhaustiva (con presupuesto): si no devuelve solución, el matching
  // perfecto no existe y la 2ª pasada minimiza cruces repetidos.
  function _pairParejas(ids, playedKeys, opts) {
    const maxNodes = (opts && opts.maxNodes) || MAX_NODES;
    let nodes = 0;
    let budgetHit = false;

    function exact(remaining) {
      if (remaining.length === 0) return [];
      if (++nodes > maxNodes) { budgetHit = true; return null; }
      const a = remaining[0];
      for (let j = 1; j < remaining.length; j++) {
        const b = remaining[j];
        if (playedKeys.has(pairKey(a, b))) continue;
        const rest = [];
        for (let k = 1; k < remaining.length; k++) if (k !== j) rest.push(remaining[k]);
        const sub = exact(rest);
        if (sub) return [[a, b], ...sub];
        if (budgetHit) return null;
      }
      return null;
    }

    const perfect = exact(ids);
    if (perfect) return { matches: perfect, warnings: [] };

    // 2ª pasada: minimizar (cruces repetidos, distancia de ranking)
    nodes = 0;
    let best = null, bestCost = Infinity;
    function minimize(remaining, acc, cost) {
      if (cost >= bestCost) return;
      if (remaining.length === 0) { best = acc.slice(); bestCost = cost; return; }
      if (++nodes > maxNodes) return;
      const a = remaining[0];
      for (let j = 1; j < remaining.length; j++) {
        const b = remaining[j];
        const rep = playedKeys.has(pairKey(a, b)) ? W_RIVAL : 0;
        const rest = [];
        for (let k = 1; k < remaining.length; k++) if (k !== j) rest.push(remaining[k]);
        acc.push([a, b]);
        minimize(rest, acc, cost + rep + W_SPREAD * (j - 1));
        acc.pop();
      }
    }
    minimize(ids, [], 0);
    if (!best) throw new Error("Error interno: no se pudo generar el emparejamiento.");
    const repeats = best.filter(([a, b]) => playedKeys.has(pairKey(a, b)));
    const warnings = repeats.length
      ? [{ type: "rematch", pairs: repeats }]
      : [];
    return { matches: best, warnings };
  }

  /* ===================== emparejamiento: INDIVIDUAL ===================== */

  // Grupos de 4 por orden Monrad con backtracking y relajación progresiva:
  //   relax 0: ni compañeros ni rivales repetidos (estricto)
  //   relax 1: compañeros no; rivales repetidos minimizados + warning
  //   relax 2: todo penalizado (último recurso) + warnings
  // Nota: cada ronda consume 3 rivales por jugador, así que con n jugadores
  // solo existen ~(n−1)/3 rondas sin repetir rival; cuando se agotan, el
  // motor avisa y el árbitro confirma — nunca se repite en silencio.
  function _pairIndividual(ids, partnerKeys, rivalCounts, opts) {
    const maxNodes = (opts && opts.maxNodes) || MAX_NODES;
    const rng = (opts && opts.rng) || Math.random;
    const rankOf = new Map(ids.map((id, i) => [id, i]));

    function splitCost(t1a, t1b, t2a, t2b, relax) {
      let partner = 0;
      if (partnerKeys.has(pairKey(t1a, t1b))) partner++;
      if (partnerKeys.has(pairKey(t2a, t2b))) partner++;
      if (partner > 0 && relax < 2) return Infinity;
      let rival = 0;
      for (const x of [t1a, t1b]) for (const y of [t2a, t2b]) rival += rivalCounts.get(pairKey(x, y)) || 0;
      if (rival > 0 && relax < 1) return Infinity;
      return partner * W_PARTNER + rival * W_RIVAL;
    }

    // Mejor partición de equipos (de las 3 posibles) para un grupo de 4
    function bestSplit(g, relax) {
      const [a, b, c, d] = g;
      const splits = [
        [[a, b], [c, d]],
        [[a, c], [b, d]],
        [[a, d], [b, c]]
      ];
      let best = null, bestC = Infinity;
      for (const s of shuffle(splits, rng)) {
        const cst = splitCost(s[0][0], s[0][1], s[1][0], s[1][1], relax);
        if (cst < bestC) { bestC = cst; best = s; }
      }
      return { split: best, cost: bestC };
    }

    function groupCost(anchor, trio, relax) {
      const g = [anchor, ...trio];
      const { split, cost } = bestSplit(g, relax);
      if (cost === Infinity) return { cost: Infinity, split: null };
      let spread = 0;
      const aRank = rankOf.get(anchor);
      for (const id of trio) spread += (rankOf.get(id) - aRank);
      return { cost: cost + W_SPREAD * spread, split };
    }

    function solve(relax, stopAtFirst) {
      let nodes = 0;
      let best = null, bestCost = Infinity;
      function dfs(remaining, acc, cost) {
        if (cost >= bestCost) return;
        if (remaining.length === 0) { best = acc.slice(); bestCost = cost; return; }
        if (++nodes > maxNodes) return;
        const anchor = remaining[0];
        const window = remaining.slice(1, 1 + RANK_WINDOW);
        const candidates = [];
        for (let i = 0; i < window.length - 2; i++)
          for (let j = i + 1; j < window.length - 1; j++)
            for (let k = j + 1; k < window.length; k++) {
              const trio = [window[i], window[j], window[k]];
              const gc = groupCost(anchor, trio, relax);
              if (gc.cost !== Infinity) candidates.push({ trio, ...gc });
            }
        candidates.sort((x, y) => x.cost - y.cost);
        for (const cand of candidates) {
          const used = new Set([anchor, ...cand.trio]);
          const rest = remaining.filter(id => !used.has(id));
          acc.push({ group: [anchor, ...cand.trio], split: cand.split, cost: cand.cost });
          dfs(rest, acc, cost + cand.cost);
          acc.pop();
          if (best && stopAtFirst) return;
          if (nodes > maxNodes) return;
        }
      }
      dfs(ids, [], 0);
      return best;
    }

    // En relax 0 todo coste es solo dispersión Monrad: la primera solución
    // completa (candidatos ya ordenados por coste) es la buscada.
    let solution = solve(0, true);
    let warnings = [];
    if (!solution) solution = solve(1, false);
    if (!solution) {
      solution = solve(2, false);
      if (!solution) throw new Error("Error interno: no se pudo generar el emparejamiento.");
      const repeated = [];
      for (const g of solution) {
        for (const team of g.split)
          if (partnerKeys.has(pairKey(team[0], team[1]))) repeated.push([team[0], team[1]]);
      }
      if (repeated.length) warnings.push({ type: "partner_repeat", pairs: repeated });
    }
    // Rivales repetidos en la solución final (solo posibles con relax ≥ 1)
    const rivalRepeats = [];
    for (const g of solution) {
      const [tA, tB] = g.split;
      for (const x of tA) for (const y of tB)
        if ((rivalCounts.get(pairKey(x, y)) || 0) > 0) rivalRepeats.push([x, y]);
    }
    if (rivalRepeats.length) warnings.push({ type: "rival_repeat", pairs: rivalRepeats });

    const matches = solution.map(g => {
      // Aleatorizar qué equipo es A/B y el orden de asientos (solo presentación)
      let [tA, tB] = g.split;
      if (rng() < 0.5) [tA, tB] = [tB, tA];
      return [shuffle(tA, rng), shuffle(tB, rng)];
    });
    return { matches, warnings };
  }

  /* ===================== generación de rondas ===================== */

  function canGenerateNextRound(state) {
    const cfg = MODES[state.mode];
    const act = activeIds(state);
    if (act.length < cfg.unitsPerTable)
      return { ok: false, reason: `Necesitas mínimo ${cfg.unitsPerTable} ${cfg.unitLabelPlural} activas.` };
    if (state.byeRound !== null)
      return { ok: false, reason: "La ronda bye ya fue generada; el torneo está en su fase final." };
    if (state.rounds.length >= state.maxRounds)
      return { ok: false, reason: "Ya se generaron todas las rondas del torneo." };
    const last = state.rounds[state.rounds.length - 1];
    if (last && !roundIsComplete(last))
      return { ok: false, reason: "Completa los puntos de la ronda actual (sin empates)." };
    return { ok: true, reason: "" };
  }

  function rankedActiveIds(state, rng) {
    const act = new Set(activeIds(state));
    if (state.rounds.length === 0) return shuffle([...act], rng);
    return computeStandings(state).map(r => r.id).filter(id => act.has(id));
  }

  function buildTables(state, orderedIds, history, rng) {
    if (state.mode === "individual") {
      const { matches, warnings } = _pairIndividual(orderedIds, history.partnerKeys, history.rivalCounts, { rng });
      return { tables: matches.map(([tA, tB], i) => ({ table: i + 1, teamA: tA, teamB: tB, ptsA: "", ptsB: "" })), warnings };
    }
    const { matches, warnings } = _pairParejas(orderedIds, history.playedKeys, {});
    return { tables: matches.map(([a, b], i) => ({ table: i + 1, teamA: [a], teamB: [b], ptsA: "", ptsB: "" })), warnings };
  }

  function generateNextRound(state, rng = Math.random) {
    const can = canGenerateNextRound(state);
    if (!can.ok) throw new Error(can.reason);
    const ranked = rankedActiveIds(state, rng);
    const { bench, active } = _selectBench(state, ranked);
    const history = pairingHistory(state);
    const { tables, warnings } = buildTables(state, active, history, rng);
    const round = { round: state.rounds.length + 1, tables, bench, warnings };
    state.rounds.push(round);
    return { round, warnings };
  }

  /* ===================== ronda bye ===================== */

  function restedIds(state) {
    return activeIds(state).filter(id => (state.benchHistory[id] || 0) > 0);
  }

  function canGenerateByeRound(state) {
    const cfg = MODES[state.mode];
    if (state.byeRound !== null) return { ok: false, reason: "La ronda bye ya fue generada." };
    if (state.rounds.length < state.maxRounds)
      return { ok: false, reason: "La ronda bye solo se genera al completar todas las rondas." };
    const last = state.rounds[state.rounds.length - 1];
    if (!last || !roundIsComplete(last))
      return { ok: false, reason: "Completa los puntos de la última ronda primero." };
    if (restedIds(state).length < cfg.unitsPerTable)
      return { ok: false, reason: `No hay suficientes ${MODES[state.mode].unitLabelPlural} con descansos para una mesa.` };
    return { ok: true, reason: "" };
  }

  function generateByeRound(state, rng = Math.random) {
    const can = canGenerateByeRound(state);
    if (!can.ok) throw new Error(can.reason);
    const cfg = MODES[state.mode];
    const standingOrder = new Map(computeStandings(state).map((r, i) => [r.id, i]));
    const rested = restedIds(state).sort((a, b) => standingOrder.get(a) - standingOrder.get(b));

    // Sobrantes: queda fuera el PEOR clasificado de los descansados.
    // La clasificación es por victorias totales, así que perder la partida
    // extra debe caer donde menos afecta el resultado final.
    const excessCount = rested.length % cfg.unitsPerTable;
    const excluded = excessCount ? rested.slice(-excessCount) : [];
    const eligible = rested.slice(0, rested.length - excessCount);

    const history = pairingHistory(state);
    const { tables, warnings } = buildTables(state, eligible, history, rng);
    if (excluded.length) warnings.push({ type: "excluded_bye", ids: excluded });
    state.byeRound = { tables, excluded, warnings };
    return { byeRound: state.byeRound, warnings };
  }

  // Pronóstico de la ronda bye al configurar el torneo: con n participantes
  // y R rondas descansan (n % tamañoMesa) unidades por ronda, todas distintas
  // hasta completar el ciclo de rotación. Permite avisar al organizador si la
  // bye dejará a alguien fuera y sugerir números de rondas que la dejan exacta.
  function byeForecast(mode, n, maxRounds) {
    const cfg = MODES[mode];
    const per = n % cfg.unitsPerTable;
    if (!per || n < cfg.unitsPerTable)
      return { perRound: 0, restedCount: 0, excludedCount: 0, suggestedRounds: [] };
    const restedFor = r => Math.min(per * r, n);
    const rested = restedFor(maxRounds);
    const excludedCount = rested < cfg.unitsPerTable ? rested : rested % cfg.unitsPerTable;
    const suggestedRounds = [];
    if (excludedCount > 0) {
      for (let r = Math.max(4, maxRounds - 3); r <= maxRounds + 4 && suggestedRounds.length < 3; r++) {
        const rr = restedFor(r);
        if (r !== maxRounds && rr >= cfg.unitsPerTable && rr % cfg.unitsPerTable === 0)
          suggestedRounds.push(r);
      }
    }
    return { perRound: per, restedCount: rested, excludedCount, suggestedRounds };
  }

  // Deshacer la última ronda generada (o la bye). Revierte también el banco:
  // historial y posición en la cola vuelven a su estado previo.
  function undoLastRound(state) {
    if (state.byeRound) {
      state.byeRound = null;
      return { undone: "bye" };
    }
    if (state.rounds.length === 0) throw new Error("No hay rondas que deshacer.");
    const round = state.rounds.pop();
    for (const id of [...round.bench].reverse()) {
      if ((state.benchHistory[id] || 0) > 0) state.benchHistory[id]--;
      const i = state.benchQueue.indexOf(id);
      if (i >= 0) state.benchQueue.splice(i, 1);
      state.benchQueue.unshift(id);
    }
    return { undone: round.round };
  }

  /* ===================== resultados ===================== */

  function setResult(state, roundNo, tableNo, ptsA, ptsB) {
    let tables;
    if (roundNo === "bye") {
      if (!state.byeRound) throw new Error("No hay ronda bye.");
      tables = state.byeRound.tables;
    } else {
      const r = state.rounds[roundNo - 1];
      if (!r) throw new Error("Ronda inexistente.");
      tables = r.tables;
    }
    const t = tables.find(x => x.table === tableNo);
    if (!t) throw new Error("Mesa inexistente.");
    const a = parseScore(ptsA), b = parseScore(ptsB);
    if (Number.isNaN(a) || Number.isNaN(b)) throw new Error("Puntos inválidos.");
    if (a !== null && b !== null && a === b) throw new Error("No se permiten empates.");
    t.ptsA = a === null ? "" : a;
    t.ptsB = b === null ? "" : b;
    const warnings = [];
    if (roundNo !== "bye" && roundNo < state.rounds.length)
      warnings.push({ type: "past_edit", round: roundNo });
    return { warnings };
  }

  /* ===================== fases ===================== */

  function tournamentPhase(state) {
    if (state.rounds.length === 0) return "config";
    if (state.byeRound) {
      return state.byeRound.tables.every(tableScored) ? "finished" : "bye_playing";
    }
    const allDone = state.rounds.length >= state.maxRounds &&
                    roundIsComplete(state.rounds[state.rounds.length - 1]);
    if (!allDone) return "playing";
    return canGenerateByeRound(state).ok ? "bye_pending" : "finished";
  }

  /* ===================== participantes ===================== */

  function betweenRounds(state) {
    if (state.byeRound) return false;
    const last = state.rounds[state.rounds.length - 1];
    return !last || roundIsComplete(last);
  }

  function assertNameFree(state, name, exceptId) {
    const lower = name.trim().toLowerCase();
    if (state.participants.some(p => p.id !== exceptId && p.name.trim().toLowerCase() === lower))
      throw new Error("Ya existe un participante con ese nombre.");
  }

  function addParticipant(state, { name, members }) {
    let mem = Array.isArray(members) ? members.map(s => String(s).trim()).filter(Boolean) : [];
    if (state.mode === "parejas") {
      if (mem.length !== 2) throw new Error("Una pareja necesita exactamente 2 nombres.");
    } else {
      if (mem.length === 0 && name) mem = [String(name).trim()];
      if (mem.length !== 1) throw new Error("Falta el nombre del jugador.");
    }
    const finalName = (name && String(name).trim()) || pairName(mem);
    if (!finalName) throw new Error("Nombre vacío.");
    assertNameFree(state, finalName, null);
    if (state.rounds.length > 0 && !betweenRounds(state))
      throw new Error("Solo puedes agregar participantes entre rondas (con la ronda actual completa).");
    const id = "u" + state.nextId++;
    state.participants.push({ id, name: finalName, members: mem, active: true, addedAtRound: state.rounds.length });
    state.benchHistory[id] = 0;
    state.benchQueue.push(id);
    const warnings = state.rounds.length > 0
      ? [{ type: "late_join", ids: [id], round: state.rounds.length + 1 }]
      : [];
    return { id, warnings };
  }

  function renameParticipant(state, id, name, members) {
    const p = getParticipant(state, id);
    if (!p) throw new Error("Participante inexistente.");
    let mem = Array.isArray(members) ? members.map(s => String(s).trim()).filter(Boolean) : p.members;
    if (state.mode === "parejas" && mem.length !== 2) throw new Error("Una pareja necesita exactamente 2 nombres.");
    const finalName = (name && String(name).trim()) || pairName(mem);
    if (!finalName) throw new Error("Nombre vacío.");
    assertNameFree(state, finalName, id);
    p.name = finalName;
    p.members = mem;
  }

  function setParticipantActive(state, id, active) {
    const p = getParticipant(state, id);
    if (!p) throw new Error("Participante inexistente.");
    if (!betweenRounds(state))
      throw new Error("Solo puedes retirar/reactivar entre rondas (con la ronda actual completa).");
    p.active = !!active;
    const warnings = [];
    const cfg = MODES[state.mode];
    if (activeIds(state).length < cfg.unitsPerTable)
      warnings.push({ type: "too_few_active" });
    return { warnings };
  }

  /* ===================== export CSV ===================== */

  function toCSV(state) {
    const q = s => {
      const t = String(s ?? "");
      return /[,"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const teamLabel = team => team.map(id => nameOf(state, id)).join(" + ");
    const lines = [];
    lines.push(["modalidad", state.mode].join(","));
    lines.push(["ronda", "mesa", "equipoA", "equipoB", "ptsA", "ptsB"].join(","));
    for (const r of state.rounds) {
      for (const t of r.tables)
        lines.push([r.round, t.table, q(teamLabel(t.teamA)), q(teamLabel(t.teamB)), t.ptsA ?? "", t.ptsB ?? ""].join(","));
      if (r.bench.length)
        lines.push([r.round, "banco", q(r.bench.map(id => nameOf(state, id)).join(", ")), "", "", ""].join(","));
    }
    if (state.byeRound) {
      lines.push("", "RONDA BYE");
      for (const t of state.byeRound.tables)
        lines.push(["bye", t.table, q(teamLabel(t.teamA)), q(teamLabel(t.teamB)), t.ptsA ?? "", t.ptsB ?? ""].join(","));
    }
    lines.push("", "POSICIONES");
    lines.push(["#", "nombre", "PJ", "G", "P", "PF", "PC", "DIF", "BUC", "PTS"].join(","));
    computeStandings(state).forEach((r, i) =>
      lines.push([i + 1, q(r.name), r.PJ, r.G, r.P, r.PF, r.PC, r.DIF, r.BUC, r.PTS].join(",")));
    return lines.join("\n");
  }

  /* ===================== API pública ===================== */

  return {
    SCHEMA_VERSION, STORAGE_KEY, TIEBREAK_LABEL, MODES,
    createTournament, validateState,
    addParticipant, renameParticipant, setParticipantActive,
    generateNextRound, generateByeRound, undoLastRound, byeForecast,
    canGenerateNextRound, canGenerateByeRound,
    setResult, computeStandings, tournamentPhase, toCSV,
    roundIsComplete, tableScored, parseScore,
    getParticipant, nameOf, activeIds, restedIds, pairingHistory, betweenRounds,
    _selectBench, _pairIndividual, _pairParejas, _mulberry32: mulberry32, _shuffle: shuffle, _pairKey: pairKey
  };
});
