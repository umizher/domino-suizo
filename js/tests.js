/* ============================================================
 * Self-tests del motor SwissEngine.
 * Ejecutar con:  node js/tests.js   (o abrir tests.html)
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    const E = require("./swiss-engine.js");
    module.exports = factory(E);
  } else {
    root.runSwissTests = (log) => factory(root.SwissEngine, log);
  }
})(typeof self !== "undefined" ? self : this, function (E, log) {
  "use strict";
  const out = log || ((msg) => console.log(msg));

  let passed = 0, failed = 0;
  const failures = [];
  function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    failures.push(msg);
    out("  ✗ FALLO: " + msg);
  }
  function section(name) { out("— " + name); }

  const pk = E._pairKey;

  /* ---------- helpers de simulación ---------- */

  function mkParticipants(mode, n) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      if (mode === "parejas") out.push({ name: `P${i}a & P${i}b`, members: [`P${i}a`, `P${i}b`] });
      else out.push({ name: `J${i}`, members: [`J${i}`] });
    }
    return out;
  }

  // Verificador exacto de referencia: ¿existe matching perfecto sin repetir?
  function perfectMatchingExists(ids, playedKeys) {
    function go(rem) {
      if (rem.length === 0) return true;
      const a = rem[0];
      for (let j = 1; j < rem.length; j++) {
        if (playedKeys.has(pk(a, rem[j]))) continue;
        const rest = rem.filter((_, i) => i !== 0 && i !== j);
        if (go(rest)) return true;
      }
      return false;
    }
    return go(ids);
  }

  function scoreAllTables(tables, rng) {
    for (const t of tables) {
      const a = 10 + Math.floor(rng() * 90);
      let b = 10 + Math.floor(rng() * 90);
      if (b === a) b++;
      t.ptsA = a; t.ptsB = b;
    }
  }

  function checkRoundInvariants(state, round, label) {
    const cfg = E.MODES[state.mode];
    const act = E.activeIds(state);
    const seated = [];
    for (const t of round.tables) {
      assert(t.teamA.length === cfg.teamSize && t.teamB.length === cfg.teamSize,
        `${label}: equipos con tamaño incorrecto`);
      for (const id of [...t.teamA, ...t.teamB]) {
        assert(typeof id === "string" && E.getParticipant(state, id),
          `${label}: asiento undefined o participante inexistente`);
        seated.push(id);
      }
    }
    assert(new Set(seated).size === seated.length, `${label}: participante duplicado en mesas`);
    for (const id of round.bench)
      assert(!seated.includes(id), `${label}: participante en banco y en mesa a la vez`);
    assert(seated.length + round.bench.length === act.length,
      `${label}: mesas+banco (${seated.length}+${round.bench.length}) ≠ activos (${act.length})`);
    assert(seated.length % cfg.unitsPerTable === 0, `${label}: nº de sentados no es múltiplo de mesa`);
  }

  function checkNoRepeats(state, label) {
    // Recorre las rondas en orden y comprueba que ninguna repetición
    // ocurre sin warning en su ronda.
    const partnerSeen = new Set();
    const playedSeen = new Set();
    const roundsAll = state.rounds.map(r => ({ tables: r.tables, warnings: r.warnings, tag: `R${r.round}` }));
    if (state.byeRound) roundsAll.push({ tables: state.byeRound.tables, warnings: state.byeRound.warnings, tag: "BYE" });
    for (const r of roundsAll) {
      const hasPartnerWarn = r.warnings.some(w => w.type === "partner_repeat");
      const hasRematchWarn = r.warnings.some(w => w.type === "rematch");
      for (const t of r.tables) {
        if (state.mode === "individual") {
          for (const team of [t.teamA, t.teamB]) {
            const k = pk(team[0], team[1]);
            if (partnerSeen.has(k))
              assert(hasPartnerWarn, `${label} ${r.tag}: compañeros repetidos SIN warning`);
            partnerSeen.add(k);
          }
        } else {
          const k = pk(t.teamA[0], t.teamB[0]);
          if (playedSeen.has(k))
            assert(hasRematchWarn, `${label} ${r.tag}: cruce repetido SIN warning`);
          playedSeen.add(k);
        }
      }
    }
  }

  function checkBenchEquity(state, label) {
    const original = state.participants.filter(p => p.addedAtRound === 0 && p.active).map(p => p.id);
    const counts = original.map(id => state.benchHistory[id] || 0);
    if (counts.length === 0) return;
    const span = Math.max(...counts) - Math.min(...counts);
    assert(span <= 1, `${label}: banco no equitativo (max−min=${span})`);
  }

  function checkStandingsOrder(state, label) {
    const rows = E.computeStandings(state);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const ok = a.PTS > b.PTS ||
        (a.PTS === b.PTS && (a.BUC > b.BUC ||
          (a.BUC === b.BUC && (a.DIF > b.DIF ||
            (a.DIF === b.DIF && (a.PF > b.PF ||
              (a.PF === b.PF && a.name.localeCompare(b.name) <= 0)))))));
      assert(ok, `${label}: orden de standings incorrecto en fila ${i}`);
    }
    for (const r of rows) assert(r.DIF === r.PF - r.PC, `${label}: DIF inconsistente`);
  }

  /* ---------- simulación masiva ---------- */

  function simulate(mode, n, maxRounds, seed) {
    const rng = E._mulberry32(seed);
    const label = `${mode} n=${n} r=${maxRounds} s=${seed}`;
    const state = E.createTournament({ mode, maxRounds, participants: mkParticipants(mode, n) }, rng);

    while (E.canGenerateNextRound(state).ok) {
      const { round, warnings } = E.generateNextRound(state, rng);
      checkRoundInvariants(state, round, label + ` R${round.round}`);

      // En parejas: el warning de rematch solo si de verdad era imposible.
      if (mode === "parejas" && n <= 12) {
        const hasWarn = warnings.some(w => w.type === "rematch");
        // Reconstruir el historial PREVIO a esta ronda
        const prev = new Set();
        for (const r of state.rounds.slice(0, -1))
          for (const t of r.tables) prev.add(pk(t.teamA[0], t.teamB[0]));
        const seatedNow = round.tables.flatMap(t => [t.teamA[0], t.teamB[0]]);
        const possible = perfectMatchingExists(seatedNow, prev);
        if (hasWarn) assert(!possible, `${label} R${round.round}: warning rematch con matching perfecto disponible`);
        else {
          // sin warning → ningún cruce de esta ronda estaba en prev
          for (const t of round.tables)
            assert(!prev.has(pk(t.teamA[0], t.teamB[0])), `${label} R${round.round}: cruce repetido sin warning`);
        }
      }

      scoreAllTables(round.tables, rng);
      checkBenchEquity(state, label + ` R${round.round}`);
      checkStandingsOrder(state, label + ` R${round.round}`);
    }

    assert(state.rounds.length === maxRounds, `${label}: no se generaron todas las rondas (${state.rounds.length}/${maxRounds})`);
    checkNoRepeats(state, label);

    if (E.canGenerateByeRound(state).ok) {
      const { byeRound } = E.generateByeRound(state, rng);
      const cfg = E.MODES[mode];
      assert(byeRound.tables.length >= 1, `${label}: bye sin mesas`);
      const seated = byeRound.tables.flatMap(t => [...t.teamA, ...t.teamB]);
      assert(new Set(seated).size === seated.length, `${label}: bye con duplicados`);
      assert(seated.length % cfg.unitsPerTable === 0, `${label}: bye no múltiplo de mesa`);
      for (const id of seated)
        assert((state.benchHistory[id] || 0) > 0, `${label}: en bye juega alguien que nunca descansó`);
      for (const id of byeRound.excluded)
        assert(!seated.includes(id), `${label}: excluido del bye está sentado`);
      checkNoRepeats(state, label + " (con bye)");
      scoreAllTables(byeRound.tables, rng);
      assert(E.tournamentPhase(state) === "finished", `${label}: fase no es finished tras puntuar bye`);
      checkStandingsOrder(state, label + " final");
    } else {
      assert(E.tournamentPhase(state) === "finished", `${label}: fase no es finished sin bye posible`);
    }

    // La validación acepta el estado que el propio motor produce
    const v = E.validateState(JSON.parse(JSON.stringify(state)));
    assert(v.ok, `${label}: validateState rechaza estado válido: ${v.errors.join("; ")}`);
    return state;
  }

  section("Simulación masiva INDIVIDUAL (n=4..20)");
  for (let n = 4; n <= 20; n++)
    for (const maxRounds of [4, 6])
      for (const seed of [1, 2, 3])
        simulate("individual", n, maxRounds, seed * 1000 + n);

  section("Simulación masiva PAREJAS (n=2..16 parejas)");
  for (let n = 2; n <= 16; n++)
    for (const maxRounds of [4, 6])
      for (const seed of [1, 2, 3])
        simulate("parejas", n, maxRounds, seed * 2000 + n);

  /* ---------- casos dirigidos ---------- */

  section("Parejas: 4 parejas a 4 rondas fuerza rematch avisado en R4");
  {
    const rng = E._mulberry32(42);
    const state = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 4) }, rng);
    let sawWarn = false;
    while (E.canGenerateNextRound(state).ok) {
      const { round, warnings } = E.generateNextRound(state, rng);
      if (round.round <= 3)
        assert(!warnings.some(w => w.type === "rematch"), `4 parejas: rematch prematuro en R${round.round}`);
      if (round.round === 4) {
        sawWarn = warnings.some(w => w.type === "rematch");
        assert(sawWarn, "4 parejas R4: faltó warning de rematch inevitable");
      }
      scoreAllTables(round.tables, rng);
    }
  }

  section("Individual: 4 jugadores a 4 rondas fuerza compañero repetido avisado");
  {
    const rng = E._mulberry32(7);
    const state = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 4) }, rng);
    // 4 jugadores → solo 3 particiones de compañeros posibles; la 4ª ronda repite
    let warned = false;
    while (E.canGenerateNextRound(state).ok) {
      const { round, warnings } = E.generateNextRound(state, rng);
      if (round.round <= 3)
        assert(!warnings.some(w => w.type === "partner_repeat"), `4 jugadores: partner_repeat prematuro en R${round.round}`);
      if (round.round === 4) warned = warnings.some(w => w.type === "partner_repeat");
      scoreAllTables(round.tables, rng);
    }
    assert(warned, "4 jugadores R4: faltó warning partner_repeat");
  }

  section("validateState rechaza estados corruptos");
  {
    assert(!E.validateState(null).ok, "acepta null");
    assert(!E.validateState("hola").ok, "acepta string");
    assert(!E.validateState({ schemaVersion: 2 }).ok, "acepta versión vieja");
    const rng = E._mulberry32(5);
    const good = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 4) }, rng);
    E.generateNextRound(good, rng);
    const c1 = JSON.parse(JSON.stringify(good)); c1.byeRound = "invalid";
    assert(!E.validateState(c1).ok, "acepta byeRound string");
    const c2 = JSON.parse(JSON.stringify(good)); c2.rounds[0].tables[0].teamA = ["uXX"];
    assert(!E.validateState(c2).ok, "acepta ID inexistente en mesa");
    const c3 = JSON.parse(JSON.stringify(good)); c3.maxRounds = null;
    assert(!E.validateState(c3).ok, "acepta maxRounds null");
    // Normaliza benchQueue incompleta sin rechazar
    const c4 = JSON.parse(JSON.stringify(good)); c4.benchQueue = [];
    const v4 = E.validateState(c4);
    assert(v4.ok && v4.state.benchQueue.length === good.participants.length, "no reconstruye benchQueue vacía");
  }

  section("Renombrar no altera standings ni emparejamientos");
  {
    const rng = E._mulberry32(11);
    const state = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 8) }, rng);
    const { round } = E.generateNextRound(state, rng);
    scoreAllTables(round.tables, rng);
    const snap = s => JSON.stringify(E.computeStandings(s)
      .map(r => ({ id: r.id, PTS: r.PTS, BUC: r.BUC, DIF: r.DIF, PJ: r.PJ }))
      .sort((a, b) => a.id.localeCompare(b.id)));
    const before = snap(state);
    E.renameParticipant(state, "u1", "NombreNuevo");
    const after = snap(state);
    assert(before === after, "renombrar cambió estadísticas");
    assert(E.nameOf(state, "u1") === "NombreNuevo", "renombrar no aplicó el nombre");
    let dup = false;
    try { E.renameParticipant(state, "u2", "NombreNuevo"); } catch { dup = true; }
    assert(dup, "permitió nombre duplicado");
  }

  section("Añadir participante a mitad de torneo");
  {
    const rng = E._mulberry32(13);
    const state = E.createTournament({ mode: "parejas", maxRounds: 6, participants: mkParticipants("parejas", 5) }, rng);
    let r = E.generateNextRound(state, rng); scoreAllTables(r.round.tables, rng);
    // En medio de una ronda sin puntuar debe fallar
    r = E.generateNextRound(state, rng);
    let blocked = false;
    try { E.addParticipant(state, { name: "Nueva & Pareja", members: ["Nueva", "Pareja"] }); } catch { blocked = true; }
    assert(blocked, "permitió añadir con ronda sin puntuar");
    scoreAllTables(r.round.tables, rng);
    const { id, warnings } = E.addParticipant(state, { name: "Nueva & Pareja", members: ["Nueva", "Pareja"] });
    assert(warnings.some(w => w.type === "late_join"), "faltó warning late_join");
    assert(state.benchQueue.includes(id), "nuevo participante fuera de la cola de banco");
    r = E.generateNextRound(state, rng);
    const seated = r.round.tables.flatMap(t => [...t.teamA, ...t.teamB]);
    assert(seated.includes(id) || r.round.bench.includes(id), "nuevo participante no participa");
    scoreAllTables(r.round.tables, rng);
    // Retirar
    E.setParticipantActive(state, id, false);
    r = E.generateNextRound(state, rng);
    const seated2 = r.round.tables.flatMap(t => [...t.teamA, ...t.teamB]);
    assert(!seated2.includes(id) && !r.round.bench.includes(id), "retirado sigue participando");
  }

  section("setResult: validaciones y aviso de edición pasada");
  {
    const rng = E._mulberry32(17);
    const state = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 4) }, rng);
    let r = E.generateNextRound(state, rng);
    let err = false;
    try { E.setResult(state, 1, 1, 50, 50); } catch { err = true; }
    assert(err, "permitió empate");
    err = false;
    try { E.setResult(state, 1, 1, "abc", 10); } catch { err = true; }
    assert(err, "permitió puntos no numéricos");
    E.setResult(state, 1, 1, 70, 50);
    E.setResult(state, 1, 2, 70, 30);
    r = E.generateNextRound(state, rng);
    const { warnings } = E.setResult(state, 1, 1, 50, 70);
    assert(warnings.some(w => w.type === "past_edit"), "faltó warning past_edit");
  }

  section("Fases del torneo");
  {
    const rng = E._mulberry32(23);
    const state = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 5) }, rng);
    assert(E.tournamentPhase(state) === "config", "fase inicial ≠ config");
    while (E.canGenerateNextRound(state).ok) {
      const { round } = E.generateNextRound(state, rng);
      assert(E.tournamentPhase(state) === "playing", "fase ≠ playing con ronda abierta");
      scoreAllTables(round.tables, rng);
    }
    assert(E.tournamentPhase(state) === "bye_pending", "5 parejas con banco: fase ≠ bye_pending");
    E.generateByeRound(state, rng);
    assert(E.tournamentPhase(state) === "bye_playing", "fase ≠ bye_playing");
    scoreAllTables(state.byeRound.tables, rng);
    assert(E.tournamentPhase(state) === "finished", "fase ≠ finished");
    // Sin banco no hay bye: 4 parejas exactas
    const s2 = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 4) }, rng);
    while (E.canGenerateNextRound(s2).ok) {
      const { round } = E.generateNextRound(s2, rng);
      scoreAllTables(round.tables, rng);
    }
    assert(E.tournamentPhase(s2) === "finished", "sin descansados: fase ≠ finished");
  }

  section("CSV");
  {
    const rng = E._mulberry32(29);
    const state = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 9) }, rng);
    E.renameParticipant(state, "u1", 'Juan "El Coma," García');
    const { round } = E.generateNextRound(state, rng);
    scoreAllTables(round.tables, rng);
    const csv = E.toCSV(state);
    assert(csv.includes('"Juan ""El Coma,"" García'), "CSV no escapa comillas/comas");
    assert(csv.includes("POSICIONES"), "CSV sin posiciones");
    assert(csv.split("\n").some(l => l.includes("banco")), "CSV sin fila de banco");
  }

  /* ---------- resumen ---------- */
  out("");
  out(`RESULTADO: ${passed} OK, ${failed} fallos`);
  if (failed > 0) out("Fallos:\n - " + failures.slice(0, 30).join("\n - "));
  if (typeof process !== "undefined") process.exitCode = failed ? 1 : 0;
  return { passed, failed, failures };
});
