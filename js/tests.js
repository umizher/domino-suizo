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

  // Verificador exacto de referencia (individual, n pequeño): ¿existe una
  // partición en mesas de 4 sin repetir NI compañeros NI rivales?
  function strictIndividualPossible(ids, partnerKeys, rivalCounts) {
    function splitOk(g) {
      const splits = [
        [[g[0], g[1]], [g[2], g[3]]],
        [[g[0], g[2]], [g[1], g[3]]],
        [[g[0], g[3]], [g[1], g[2]]]
      ];
      return splits.some(([tA, tB]) =>
        !partnerKeys.has(pk(tA[0], tA[1])) && !partnerKeys.has(pk(tB[0], tB[1])) &&
        tA.every(x => tB.every(y => !((rivalCounts.get(pk(x, y)) || 0) > 0))));
    }
    function go(rem) {
      if (rem.length === 0) return true;
      const a = rem[0], rest = rem.slice(1);
      for (let i = 0; i < rest.length - 2; i++)
        for (let j = i + 1; j < rest.length - 1; j++)
          for (let k = j + 1; k < rest.length; k++) {
            const g = [a, rest[i], rest[j], rest[k]];
            if (!splitOk(g)) continue;
            const used = new Set(g);
            if (go(rem.filter(x => !used.has(x)))) return true;
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
    const rivalSeen = new Set();
    const playedSeen = new Set();
    const roundsAll = state.rounds.map(r => ({ tables: r.tables, warnings: r.warnings, tag: `R${r.round}` }));
    if (state.byeRound) roundsAll.push({ tables: state.byeRound.tables, warnings: state.byeRound.warnings, tag: "BYE" });
    for (const r of roundsAll) {
      const hasPartnerWarn = r.warnings.some(w => w.type === "partner_repeat");
      const hasRivalWarn = r.warnings.some(w => w.type === "rival_repeat");
      const hasRematchWarn = r.warnings.some(w => w.type === "rematch");
      for (const t of r.tables) {
        if (state.mode === "individual") {
          for (const team of [t.teamA, t.teamB]) {
            const k = pk(team[0], team[1]);
            if (partnerSeen.has(k))
              assert(hasPartnerWarn, `${label} ${r.tag}: compañeros repetidos SIN warning`);
            partnerSeen.add(k);
          }
          for (const x of t.teamA) for (const y of t.teamB) {
            const k = pk(x, y);
            if (rivalSeen.has(k))
              assert(hasRivalWarn, `${label} ${r.tag}: rivales repetidos SIN warning`);
            rivalSeen.add(k);
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
      const prevHist = (mode === "individual" && n <= 8) ? E.pairingHistory(state) : null;
      const { round, warnings } = E.generateNextRound(state, rng);
      checkRoundInvariants(state, round, label + ` R${round.round}`);

      // En individual pequeño: el warning de repetición solo si era imposible evitarla.
      if (prevHist) {
        const seated = round.tables.flatMap(t => [...t.teamA, ...t.teamB]);
        const hasRepeatWarn = warnings.some(w => w.type === "rival_repeat" || w.type === "partner_repeat");
        if (hasRepeatWarn)
          assert(!strictIndividualPossible(seated, prevHist.partnerKeys, prevHist.rivalCounts),
            `${label} R${round.round}: warning de repetición con solución estricta disponible`);
      }

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
      const restedBefore = E.restedIds(state);
      const { byeRound } = E.generateByeRound(state, rng);
      const cfg = E.MODES[mode];
      assert(byeRound.tables.length >= 1, `${label}: bye sin mesas`);
      const seated = byeRound.tables.flatMap(t => [...t.teamA, ...t.teamB]);
      assert(new Set(seated).size === seated.length, `${label}: bye con duplicados`);
      assert(seated.length % cfg.unitsPerTable === 0, `${label}: bye no múltiplo de mesa`);
      // Regla del usuario: NADIE queda fuera — todos los descansados juegan,
      // y la mesa incompleta se rellena con invitados A/B/C
      for (const id of restedBefore)
        assert(seated.includes(id), `${label}: descansado fuera de la bye`);
      const ghosts = state.participants.filter(p => p.ghost).map(p => p.id);
      const expectedGhosts = (cfg.unitsPerTable - (restedBefore.length % cfg.unitsPerTable)) % cfg.unitsPerTable;
      assert(ghosts.length === expectedGhosts, `${label}: nº de invitados incorrecto (${ghosts.length} vs ${expectedGhosts})`);
      for (const id of ghosts)
        assert(seated.includes(id), `${label}: invitado creado pero no sentado`);
      assert(seated.length === restedBefore.length + ghosts.length, `${label}: en la bye juega alguien que no descansó`);
      assert(!E.computeStandings(state).some(r => ghosts.includes(r.id)), `${label}: invitado aparece en standings`);
      if (ghosts.length)
        assert(byeRound.warnings.some(w => w.type === "ghost_fill"), `${label}: faltó warning ghost_fill`);
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

  section("byeForecast: pronóstico de invitados y sugerencias");
  {
    let f = E.byeForecast("individual", 25, 5);
    assert(f.perRound === 1 && f.restedCount === 5 && f.ghostCount === 3, "25j/5r: pronóstico incorrecto");
    assert(f.suggestedRounds.includes(4) && f.suggestedRounds.includes(8), "25j/5r: sugerencias deben incluir 4 y 8");
    f = E.byeForecast("individual", 25, 4);
    assert(f.ghostCount === 0 && f.restedCount === 4, "25j/4r: la bye debería ser exacta");
    f = E.byeForecast("individual", 24, 6);
    assert(f.perRound === 0 && f.ghostCount === 0, "24j: sin banco no hay bye");
    // 5 parejas: a partir de la R5 todas han descansado (5, impar), así que
    // solo 4 rondas dejan la bye exacta — 6+ rondas no ayudan.
    f = E.byeForecast("parejas", 5, 5);
    assert(f.ghostCount === 1 && f.suggestedRounds.length === 1 && f.suggestedRounds[0] === 4,
      "5 parejas/5r: pronóstico incorrecto");
  }

  section("Bye con invitados A/B/C: nombres, conflicto y limpieza al deshacer");
  {
    // individual 9 jugadores a 5 rondas → 5 descansados → 3 invitados (A, B, C)
    const rng = E._mulberry32(41);
    const state = E.createTournament({ mode: "individual", maxRounds: 5, participants: mkParticipants("individual", 9) }, rng);
    while (E.canGenerateNextRound(state).ok) {
      const { round } = E.generateNextRound(state, rng);
      scoreAllTables(round.tables, rng);
    }
    E.generateByeRound(state, rng);
    const ghostNames = state.participants.filter(p => p.ghost).map(p => p.name).sort();
    assert(JSON.stringify(ghostNames) === JSON.stringify(["A", "B", "C"]), `invitados mal nombrados: ${ghostNames}`);
    assert(state.byeRound.tables.length === 2, "9j/5r: la bye debería tener 2 mesas");
    assert(E.computeStandings(state).length === 9, "standings deben tener solo los 9 reales");
    // deshacer la bye elimina a los invitados
    E.undoLastRound(state);
    assert(!state.participants.some(p => p.ghost), "deshacer la bye no eliminó a los invitados");
    assert(E.canGenerateByeRound(state).ok, "tras deshacer no se puede regenerar la bye");
    // conflicto de nombre: jugador real llamado "A"
    const rng2 = E._mulberry32(43);
    const parts = mkParticipants("individual", 9);
    parts[0] = { name: "A", members: ["A"] };
    const s2 = E.createTournament({ mode: "individual", maxRounds: 5, participants: parts }, rng2);
    while (E.canGenerateNextRound(s2).ok) {
      const { round } = E.generateNextRound(s2, rng2);
      scoreAllTables(round.tables, rng2);
    }
    E.generateByeRound(s2, rng2);
    const names2 = s2.participants.filter(p => p.ghost).map(p => p.name);
    assert(names2.includes("Invitado A") && !names2.filter(n => n === "A").length,
      `conflicto de nombre no resuelto: ${names2}`);
    // parejas: 5 parejas a 5 rondas → 5 descansadas → 1 pareja invitada "A"
    const rng3 = E._mulberry32(47);
    const s3 = E.createTournament({ mode: "parejas", maxRounds: 5, participants: mkParticipants("parejas", 5) }, rng3);
    while (E.canGenerateNextRound(s3).ok) {
      const { round } = E.generateNextRound(s3, rng3);
      scoreAllTables(round.tables, rng3);
    }
    E.generateByeRound(s3, rng3);
    const g3 = s3.participants.filter(p => p.ghost);
    assert(g3.length === 1 && g3[0].name === "A", "parejas: invitada única 'A' esperada");
    assert(s3.byeRound.tables.length === 3, "5 parejas/5r: la bye debería tener 3 mesas");
  }

  section("createTournament: mínimo 4 rondas, acepta impares");
  {
    let err = false;
    try { E.createTournament({ mode: "individual", maxRounds: 3, participants: mkParticipants("individual", 8) }); }
    catch { err = true; }
    assert(err, "aceptó 3 rondas");
    for (const r of [4, 5, 7]) {
      const st = E.createTournament({ mode: "individual", maxRounds: r, participants: mkParticipants("individual", 8) });
      assert(st.maxRounds === r, `no aceptó ${r} rondas`);
    }
  }

  section("undoLastRound: revierte ronda, banco y bye");
  {
    const rng = E._mulberry32(31);
    const state = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 9) }, rng);
    let r = E.generateNextRound(state, rng); scoreAllTables(r.round.tables, rng);
    const snap = () => JSON.stringify({ h: state.benchHistory, q: state.benchQueue, n: state.rounds.length });
    const before = snap();
    E.generateNextRound(state, rng);
    E.undoLastRound(state);
    assert(snap() === before, "undo no restauró ronda/banco/cola");
    r = E.generateNextRound(state, rng);
    checkRoundInvariants(state, r.round, "regenerar tras undo");
    scoreAllTables(r.round.tables, rng);
    while (E.canGenerateNextRound(state).ok) {
      const x = E.generateNextRound(state, rng);
      scoreAllTables(x.round.tables, rng);
    }
    if (E.canGenerateByeRound(state).ok) {
      E.generateByeRound(state, rng);
      E.undoLastRound(state);
      assert(state.byeRound === null, "undo de bye no la eliminó");
      assert(E.canGenerateByeRound(state).ok, "tras undo de bye no se puede regenerar");
    }
    while (state.rounds.length) E.undoLastRound(state);
    assert(Object.values(state.benchHistory).every(c => c === 0), "historial de banco no quedó en cero al deshacer todo");
    r = E.generateNextRound(state, rng);
    checkRoundInvariants(state, r.round, "regenerar R1 tras deshacer todo");
    let err = false;
    const s2 = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 4) }, rng);
    try { E.undoLastRound(s2); } catch { err = true; }
    assert(err, "permitió deshacer sin rondas");
  }

  section("Escenarios difíciles: rondas impares, 25+ participantes, agotamiento de cruces");
  {
    const hard = [
      ["individual", 5, 7], ["individual", 7, 7], ["individual", 9, 9], ["individual", 13, 9],
      ["individual", 25, 4], ["individual", 25, 5], ["individual", 25, 7],
      ["individual", 26, 5], ["individual", 27, 6],
      ["parejas", 3, 7], ["parejas", 5, 7], ["parejas", 7, 9], ["parejas", 25, 5]
    ];
    for (const [mode, n, r] of hard)
      for (const seed of [1, 2])
        simulate(mode, n, r, seed * 7777 + n * 31 + r);
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

  section("Config: puntos por partida y reloj (v4)");
  {
    const rng = E._mulberry32(31);
    const s1 = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 8) }, rng);
    assert(s1.schemaVersion === 4, "schemaVersion debe ser 4");
    assert(s1.config.targetPoints === 200, "targetPoints default debe ser 200");
    assert(s1.config.timerMinutes === null, "timerMinutes default debe ser null");
    const s2 = E.createTournament({ mode: "parejas", maxRounds: 4, targetPoints: 150, timerMinutes: 40, participants: mkParticipants("parejas", 4) }, rng);
    assert(s2.config.targetPoints === 150 && s2.config.timerMinutes === 40, "config personalizada no respetada");
    // strings de inputs HTML también valen
    const s3 = E.createTournament({ mode: "individual", maxRounds: 4, targetPoints: "200", timerMinutes: "", participants: mkParticipants("individual", 8) }, rng);
    assert(s3.config.targetPoints === 200 && s3.config.timerMinutes === null, "config desde strings no normalizada");
    for (const bad of [{ targetPoints: 10 }, { targetPoints: 5000 }, { targetPoints: 100.5 }, { timerMinutes: 2 }, { timerMinutes: 999 }]) {
      let err = false;
      try { E.createTournament({ mode: "individual", maxRounds: 4, ...bad, participants: mkParticipants("individual", 8) }, rng); }
      catch { err = true; }
      assert(err, "aceptó config inválida: " + JSON.stringify(bad));
    }
  }

  section("Migración v3 → v4 en validateState");
  {
    const rng = E._mulberry32(33);
    const st = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 9) }, rng);
    const { round } = E.generateNextRound(st, rng);
    scoreAllTables(round.tables, rng);
    const raw = JSON.parse(JSON.stringify(st));
    raw.schemaVersion = 3;
    delete raw.config;
    for (const r of raw.rounds) delete r.timer;
    const v = E.validateState(raw);
    assert(v.ok, "estado v3 debe migrar: " + (v.errors || []).join(" "));
    assert(v.state.schemaVersion === 4, "migración no actualizó schemaVersion");
    assert(v.state.config && v.state.config.targetPoints === 200 && v.state.config.timerMinutes === null,
      "migración sin config default");
    assert(v.state.rounds[0].timer === null, "migración sin timer null en rondas");
    assert(v.state.rounds.length === 1 && E.computeStandings(v.state).length === 9,
      "migración perdió rondas o participantes");
    // config corrupta guardada → defaults, no fallo
    const raw2 = JSON.parse(JSON.stringify(st));
    raw2.config = { targetPoints: -5, timerMinutes: "x" };
    const v2 = E.validateState(raw2);
    assert(v2.ok && v2.state.config.targetPoints === 200, "config corrupta no cayó a defaults");
    // v2 sigue rechazado
    const raw3 = JSON.parse(JSON.stringify(st));
    raw3.schemaVersion = 2;
    assert(!E.validateState(raw3).ok, "aceptó schemaVersion 2");
  }

  section("Temporizador de ronda");
  {
    const rng = E._mulberry32(35);
    const T0 = 1000000;
    const st = E.createTournament({ mode: "individual", maxRounds: 4, timerMinutes: 10, participants: mkParticipants("individual", 8) }, rng);
    const { round } = E.generateNextRound(st, rng, T0);
    assert(round.timer && round.timer.startedAt === T0 && round.timer.pausedAt === null,
      "la ronda no arrancó con reloj");
    assert(E.timerRemaining(st, round, T0 + 60000) === 9 * 60000, "restante incorrecto tras 1 min");
    assert(!E.timerPaused(round), "no debería estar pausado");
    E.timerPause(round, T0 + 120000);
    assert(E.timerPaused(round), "pausa no aplicada");
    assert(E.timerRemaining(st, round, T0 + 300000) === 8 * 60000, "el reloj avanzó estando pausado");
    E.timerResume(round, T0 + 300000);
    assert(!E.timerPaused(round), "reanudar no aplicado");
    assert(E.timerRemaining(st, round, T0 + 300000) === 8 * 60000, "reanudar alteró el restante");
    E.timerRestart(st, round, T0 + 400000);
    assert(E.timerRemaining(st, round, T0 + 400000) === 10 * 60000, "reiniciar no devolvió el tiempo completo");
    assert(E.timerRemaining(st, round, T0 + 60 * 60000) < 0, "agotado debe ser negativo");
    // deshacer ronda con timer no rompe
    E.undoLastRound(st);
    assert(st.rounds.length === 0, "undo con timer falló");
    // sin timerMinutes: rondas sin reloj y remaining null
    const st2 = E.createTournament({ mode: "individual", maxRounds: 4, participants: mkParticipants("individual", 8) }, rng);
    const r2 = E.generateNextRound(st2, rng).round;
    assert(r2.timer === null, "ronda con reloj sin configurarlo");
    assert(E.timerRemaining(st2, r2) === null, "remaining debe ser null sin reloj");
  }

  section("scoreStatus: meta 200, pasarse anota completo, fin por tiempo");
  {
    const rng = E._mulberry32(37);
    const st = E.createTournament({ mode: "parejas", maxRounds: 4, participants: mkParticipants("parejas", 4) }, rng);
    E.generateNextRound(st, rng);
    const t = st.rounds[0].tables[0];
    assert(E.scoreStatus(st, t) === "pending", "mesa sin puntos debe ser pending");
    E.setResult(st, 1, t.table, 200, 180);
    assert(E.scoreStatus(st, t) === "complete", "200 exacto debe ser complete");
    E.setResult(st, 1, t.table, 220, 195);
    assert(t.ptsA === 220, "pasarse de 200 debe anotarse completo (220)");
    assert(E.scoreStatus(st, t) === "complete", "220 debe ser complete");
    E.setResult(st, 1, t.table, 150, 120);
    assert(E.scoreStatus(st, t) === "time_win", "ganador con 150 debe ser time_win");
    let err = false;
    try { E.setResult(st, 1, t.table, 150, 150); } catch { err = true; }
    assert(err, "el empate debe seguir bloqueado");
    // meta personalizada
    const st2 = E.createTournament({ mode: "parejas", maxRounds: 4, targetPoints: 100, participants: mkParticipants("parejas", 4) }, rng);
    E.generateNextRound(st2, rng);
    const t2 = st2.rounds[0].tables[0];
    E.setResult(st2, 1, t2.table, 110, 80);
    assert(E.scoreStatus(st2, t2) === "complete", "meta 100: 110 debe ser complete");
  }

  /* ---------- resumen ---------- */
  out("");
  out(`RESULTADO: ${passed} OK, ${failed} fallos`);
  if (failed > 0) out("Fallos:\n - " + failures.slice(0, 30).join("\n - "));
  if (typeof process !== "undefined") process.exitCode = failed ? 1 : 0;
  return { passed, failed, failures };
});
