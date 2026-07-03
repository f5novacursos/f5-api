const router = require('express').Router();
const db = require('../db');

// Cria tabela se não existir
async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_resultados (
      id            SERIAL PRIMARY KEY,
      event_id      VARCHAR(40) NOT NULL UNIQUE,
      liga          VARCHAR(30) NOT NULL,
      hora          INTEGER NOT NULL,
      slot          INTEGER NOT NULL,
      slot_min      INTEGER NOT NULL,
      team_a        VARCHAR(60),
      team_b        VARCHAR(60),
      ft_a          INTEGER NOT NULL,
      ft_b          INTEGER NOT NULL,
      ht_a          INTEGER,
      ht_b          INTEGER,
      ft_str        VARCHAR(10),
      ht_str        VARCHAR(10),
      gols_total    INTEGER,
      is_btts       BOOLEAN,
      casa_ganha    BOOLEAN,
      visit_ganha   BOOLEAN,
      empate        BOOLEAN,
      ht_atipico    BOOLEAN,
      start_time    BIGINT,
      coletado_em   TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vr_event_id ON virturia_resultados(event_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_liga ON virturia_resultados(liga)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_hora_slot ON virturia_resultados(hora, slot_min)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_coletado ON virturia_resultados(coletado_em)`);
}
initTable().catch(e => console.error('[virturia] init table error:', e.message));

// POST /api/virturia/salvar — recebe lote de resultados do Worker
router.post('/salvar', async (req, res, next) => {
  try {
    const { resultados, chave } = req.body;

    if (!Array.isArray(resultados) || resultados.length === 0) {
      return res.json({ ok: true, salvos: 0 });
    }

    let salvos = 0;
    for (const r of resultados) {
      // Calcula campos derivados
      const ftA = Number(r.scoreA) || 0;
      const ftB = Number(r.scoreB) || 0;
      const htA = r.htA != null ? Number(r.htA) : null;
      const htB = r.htB != null ? Number(r.htB) : null;
      const golsTotal = ftA + ftB;

      // Calcula hora e slot a partir do startTime
      if (!r.startTime) continue;
      const d = new Date(r.startTime);
      const dBRT = new Date(d.getTime() - 3 * 3600000);
      const hora = dBRT.getUTCHours();
      const minuto = dBRT.getUTCMinutes();
      const dataBRT = dBRT.toISOString().slice(0, 10); // "2026-06-05"

      // Mapa de slots por liga (minutos de cada slot)
      const SLOTS = {
        brasileirao:     [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
        classicos:       [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
        copa_america:    [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
        euro:            [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
        italiano:        [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
        copa_estrelas:   [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
        british_derbies: [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58], // grade real Betano conferida 02/07
        scudetto:        [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
        liga_espanhola:  [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59], // grade real Betano conferida 02/07
      };

      const ligaSlots = SLOTS[r.liga] || SLOTS['brasileirao'];
      // Encontra o slot mais próximo do minuto
      let slotIdx = 0;
      let minDiff = 99;
      for (let i = 0; i < ligaSlots.length; i++) {
        const diff = Math.abs(ligaSlots[i] - minuto);
        if (diff < minDiff) { minDiff = diff; slotIdx = i; }
      }
      const slotMin = ligaSlots[slotIdx];
      // Chave única por liga+dia+hora+slot — Betano reutiliza event_ids a cada hora
      const eventIdComData = `${r.liga}_${dataBRT}_${hora}_${slotMin}`;

      try {
        const result = await db.query(`
          INSERT INTO virturia_resultados
            (event_id, liga, hora, slot, slot_min, team_a, team_b,
             ft_a, ft_b, ht_a, ht_b, ft_str, ht_str,
             gols_total, is_btts, casa_ganha, visit_ganha, empate, ht_atipico, start_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (event_id) DO NOTHING
        `, [
          eventIdComData, r.liga, hora, slotIdx, slotMin,
          r.teamA, r.teamB,
          ftA, ftB, htA, htB,
          `${ftA}-${ftB}`,
          htA != null ? `${htA}-${htB}` : null,
          golsTotal,
          ftA > 0 && ftB > 0,
          ftA > ftB,
          ftB > ftA,
          ftA === ftB,
          htA != null ? (htA + htB >= 3) : false,
          r.startTime
        ]);
        // rowCount=1 = INSERT real (novo slot), rowCount=0 = conflito (já existia)
        if (result.rowCount === 1) salvos++;
      } catch(e) {
        // Conflito de event_id = já existe, ignora
      }
    }

    res.json({ ok: true, salvos, recebidos: resultados.length });
  } catch(e) {
    next(e);
  }
});

// GET /api/virturia/stats — estatísticas gerais do banco
router.get('/stats', async (req, res, next) => {
  try {
    const r = await db.query(`
      SELECT
        liga,
        COUNT(*) as total,
        MIN(coletado_em) as primeiro,
        MAX(coletado_em) as ultimo
      FROM virturia_resultados
      GROUP BY liga
      ORDER BY liga
    `);
    const total = await db.query('SELECT COUNT(*) as total FROM virturia_resultados');
    res.json({ ok: true, total: Number(total.rows[0].total), por_liga: r.rows });
  } catch(e) {
    next(e);
  }
});

// GET /api/virturia/padroes?liga=brasileirao&slot_min=0&horas=168
// Retorna o que saiu após determinado placar numa posição
router.get('/padroes', async (req, res, next) => {
  try {
    const { liga, slot_min, ft_str, horas = 168 } = req.query;
    if (!liga || !ft_str) return res.status(400).json({ error: 'liga e ft_str obrigatorios' });

    const cutoff = new Date(Date.now() - Number(horas) * 3600000);

    // O que saiu NA PRÓXIMA HORA no mesmo slot após ft_str
    const r = await db.query(`
      SELECT b.ft_str, b.ht_str, COUNT(*) as vezes
      FROM virturia_resultados a
      JOIN virturia_resultados b
        ON b.liga = a.liga
        AND b.slot_min = a.slot_min
        AND b.hora = a.hora + 1
      WHERE a.liga = $1
        AND a.ft_str = $2
        AND ($3::integer IS NULL OR a.slot_min = $3)
        AND a.coletado_em > $4
      GROUP BY b.ft_str, b.ht_str
      ORDER BY vezes DESC
      LIMIT 10
    `, [liga, ft_str, slot_min || null, cutoff]);

    res.json({ ok: true, apos: ft_str, resultados: r.rows });
  } catch(e) {
    next(e);
  }
});

// GET /api/virturia/resultados?liga=brasileirao&horas=6
// Substitui o KV do Worker — frontend chama isso diretamente
router.get('/resultados', async (req, res, next) => {
  try {
    const { liga, horas = 6 } = req.query;
    // Filtra por start_time (ms) — event_ids se repetem entre dias,
    // coletado_em ficaria desatualizado via ON CONFLICT DO UPDATE
    const cutoffMs = Date.now() - Number(horas) * 3600000;

    const params = [cutoffMs];
    let ligaFilter = '';
    if (liga) { ligaFilter = 'AND liga = $2'; params.push(liga); }

    const r = await db.query(`
      SELECT
        event_id  AS id,
        liga,
        slot_min,
        team_a    AS "teamA",
        team_b    AS "teamB",
        ft_a::text AS "scoreA",
        ft_b::text AS "scoreB",
        ht_a::text AS "htA",
        ht_b::text AS "htB",
        start_time  AS "startTime",
        start_time  AS "endedAt",
        true        AS "isEnded"
      FROM virturia_resultados
      WHERE start_time > $1
      ${ligaFilter}
      ORDER BY start_time DESC
      LIMIT 2000
    `, params);

    const totalR = await db.query('SELECT COUNT(*) as t FROM virturia_resultados WHERE start_time > $1', [cutoffMs]);

    res.json({
      ok: true,
      total: r.rows.length,
      hist: Number(totalR.rows[0].t),
      results: r.rows
    });
  } catch(e) {
    next(e);
  }
});


// GET /api/virturia/padroes-auto
router.get('/padroes-auto', async (req, res, next) => {
  try {
    const { liga, horas = 168, min_ocorrencias = 7, min_confianca = 60 } = req.query;
    const cutoffMs = Date.now() - Number(horas) * 3600000;
    const ligaParam = liga ? [cutoffMs, liga] : [cutoffMs];
    const ligaFilter = liga ? `AND liga = $2` : '';

    const r = await db.query(`
      SELECT liga, hora, slot_min, ft_str, ht_str, ft_a, ft_b, ht_a, ht_b, gols_total, is_btts,
             casa_ganha, visit_ganha, empate, start_time,
             DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
      FROM virturia_resultados
      WHERE start_time > $1 ${ligaFilter}
      ORDER BY liga, start_time ASC
    `, ligaParam);

    if (r.rows.length < 10) return res.json({ ok: true, total: 0, padroes: [] });

    // Agrupa por liga+dia+hora
    const linhaMap = {};
    for (const j of r.rows) {
      const k = `${j.liga}|${j.dia}|${j.hora}`;
      if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, ts: Number(j.start_time), slots: [] };
      if (Number(j.start_time) < linhaMap[k].ts) linhaMap[k].ts = Number(j.start_time);
      linhaMap[k].slots.push(j);
    }

    // Por liga, ordena linhas por tempo
    const ligaLinhas = {};
    for (const v of Object.values(linhaMap)) {
      if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
      v.slots.sort((a, b) => a.slot_min - b.slot_min);
      ligaLinhas[v.liga].push(v);
    }
    for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

    const padroes = [];
    const minOcorr = Number(min_ocorrencias);
    const minConf = Number(min_confianca);

    function tagPrincipal(j) {
      if (j.gols_total === 0) return '0-0';
      if (j.gols_total >= 4) return 'OVER 3.5';
      if (j.gols_total >= 3) return 'OVER 2.5';
      if (j.gols_total >= 2) return 'OVER 1.5';
      return 'UNDER 1.5';
    }

    // ── BASE RATE: frequência natural de cada resultado por liga ──
    // Sem isso "70% OVER 1.5" engana: se OVER 1.5 já sai 72% sozinho,
    // o padrão é PIOR que o acaso. O que vale é o EDGE = conf - base.
    const baseCount = {};
    for (const j of r.rows) {
      const tg = tagPrincipal(j);
      if (!baseCount[j.liga]) baseCount[j.liga] = { __total: 0 };
      baseCount[j.liga][tg] = (baseCount[j.liga][tg] || 0) + 1;
      baseCount[j.liga].__total++;
    }
    function baseRate(liga, tag) {
      const b = baseCount[liga];
      if (!b || !b.__total) return 0;
      return Math.round((b[tag] || 0) / b.__total * 100);
    }

    // PADRÃO VERTICAL: mesmo slot em horas seguidas
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
        if (seq.length < minOcorr + 1) continue;
        const acc = {};
        for (let i = 0; i < seq.length - 1; i++) {
          const cond = seq[i].ft_str;
          const prox = seq[i + 1];
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          const tag = tagPrincipal(prox);
          acc[cond].res[tag] = (acc[cond].res[tag] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < minOcorr) continue;
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          const baseV = baseRate(ligaKey, res);
          padroes.push({
            id: `v_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'),
            tipo: 'vertical', liga: ligaKey, slot_min: slotMin,
            condicao: [cond], resultado: res,
            ocorrencias: v.total, acertos: cnt, confianca: conf,
            base_rate: baseV, edge: conf - baseV,
            descricao: `Slot ${slotMin}': saiu ${cond} → próxima hora: ${res}`
          });
        }
      }
    }

    // PADRÃO HORIZONTAL: slots seguidos na mesma hora
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const acc = {};
      for (const linha of linhas) {
        const slots = linha.slots;
        for (let i = 0; i < slots.length - 1; i++) {
          const cond = slots[i].ft_str;
          const prox = slots[i + 1];
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          const tag = tagPrincipal(prox);
          acc[cond].res[tag] = (acc[cond].res[tag] || 0) + 1;
        }
      }
      for (const [cond, v] of Object.entries(acc)) {
        if (v.total < minOcorr) continue;
        const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
        if (!melhor) continue;
        const [res, cnt] = melhor;
        const conf = Math.round(cnt / v.total * 100);
        if (conf < minConf) continue;
        const baseH = baseRate(ligaKey, res);
        padroes.push({
          id: `h_${ligaKey}_${cond}_${res}`.replace(/\W/g,'_'),
          tipo: 'horizontal', liga: ligaKey, slot_min: null,
          condicao: [cond], resultado: res,
          ocorrencias: v.total, acertos: cnt, confianca: conf,
          base_rate: baseH, edge: conf - baseH,
          descricao: `Mesma hora: depois de ${cond} → próximo slot: ${res}`
        });
      }
    }

    // PADRÃO VERTICAL CATEGORIA: tagPrincipal(hora N) → tagPrincipal(hora N+1)
    // Agrupa por OVER/UNDER em vez de placar exato → mais amostras, padrões macro
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
        if (seq.length < minOcorr + 1) continue;
        const acc = {};
        for (let i = 0; i < seq.length - 1; i++) {
          const cond = tagPrincipal(seq[i]);
          const prox = tagPrincipal(seq[i + 1]);
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          acc[cond].res[prox] = (acc[cond].res[prox] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < minOcorr) continue;
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          const baseV = baseRate(ligaKey, res);
          const edge = conf - baseV;
          if (edge < 5) continue; // só padrões com edge real
          padroes.push({
            id: `vc_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'),
            tipo: 'vertical-cat', liga: ligaKey, slot_min: slotMin,
            condicao: [cond], resultado: res,
            ocorrencias: v.total, acertos: cnt, confianca: conf,
            base_rate: baseV, edge,
            descricao: `Slot ${slotMin}': saiu ${cond} → próxima hora: ${res}`
          });
        }
      }
    }

    // PADRÃO HT → FT: intervalo do jogo prediz resultado final
    // "Quando HT é 0-0 neste slot → FT tende a ser UNDER 1.5 com X%"
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const jogos = linhas.flatMap(l => l.slots.filter(s => s.slot_min === slotMin && s.ht_str));
        if (jogos.length < minOcorr) continue;
        const acc = {};
        for (const j of jogos) {
          const cond = j.ht_str;
          const res  = tagPrincipal(j);
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          acc[cond].res[res] = (acc[cond].res[res] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < minOcorr) continue;
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          const baseV = baseRate(ligaKey, res);
          const edge = conf - baseV;
          if (edge < 5) continue;
          padroes.push({
            id: `ht_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'),
            tipo: 'ht-ft', liga: ligaKey, slot_min: slotMin,
            condicao: [cond], resultado: res,
            ocorrencias: v.total, acertos: cnt, confianca: conf,
            base_rate: baseV, edge,
            descricao: `Slot ${slotMin}': HT ${cond} → FT ${res}`
          });
        }
      }
    }

    // PADRÃO VERTICAL 2 HORAS: [hora N-1, hora N] → hora N+1
    // Detecta oscilação: OVER → UNDER → OVER, repetições em blocos, etc.
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
        if (seq.length < minOcorr + 2) continue;
        const acc = {};
        for (let i = 0; i < seq.length - 2; i++) {
          const cond = `${tagPrincipal(seq[i])} → ${tagPrincipal(seq[i+1])}`;
          const prox = tagPrincipal(seq[i+2]);
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          acc[cond].res[prox] = (acc[cond].res[prox] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < minOcorr) continue;
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          const baseV = baseRate(ligaKey, res);
          const edge = conf - baseV;
          if (edge < 8) continue; // exige edge maior pois condição é mais específica
          padroes.push({
            id: `v2_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'),
            tipo: 'vertical-2h', liga: ligaKey, slot_min: slotMin,
            condicao: cond.split(' → '), resultado: res,
            ocorrencias: v.total, acertos: cnt, confianca: conf,
            base_rate: baseV, edge,
            descricao: `Slot ${slotMin}': ${cond} → próxima hora: ${res}`
          });
        }
      }
    }

    // PADRÃO ATÍPICO VERTICAL: quando slot X teve evento raro → próxima hora
    // Detecta: 0-0, 5+ gols, virada, HT 3+ gols, placares como 3-2 / 3-3
    function labelAtipico(j) {
      const g = j.gols_total;
      const htA = parseInt(j.ht_a)||0, htB = parseInt(j.ht_b)||0;
      const ftA = parseInt(j.ft_a)||0, ftB = parseInt(j.ft_b)||0;
      if (g === 0) return '0-0 ⚫';
      if (g >= 5)  return '5+ GOLS 🔥';
      if (htA < htB && ftA > ftB) return 'VIRADA CASA 🔄';
      if (htA > htB && ftA < ftB) return 'VIRADA VISIT 🔄';
      if (htA + htB >= 3) return `HT ALTO ${j.ht_str}`;
      if (g >= 4 && (ftA >= 3 || ftB >= 3)) return `PLACAR ${j.ft_str}`;
      return null;
    }

    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
        if (seq.length < minOcorr + 1) continue;
        const acc = {};
        for (let i = 0; i < seq.length - 1; i++) {
          const label = labelAtipico(seq[i]);
          if (!label) continue;
          const prox = tagPrincipal(seq[i + 1]);
          if (!acc[label]) acc[label] = { total: 0, res: {} };
          acc[label].total++;
          acc[label].res[prox] = (acc[label].res[prox] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < Math.max(3, Math.floor(minOcorr / 2))) continue; // atípicos são raros, exige menos
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          const baseV = baseRate(ligaKey, res);
          const edge = conf - baseV;
          if (edge < 5) continue;
          padroes.push({
            id: `at_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'),
            tipo: 'atipico', liga: ligaKey, slot_min: slotMin,
            condicao: [cond], resultado: res,
            ocorrencias: v.total, acertos: cnt, confianca: conf,
            base_rate: baseV, edge,
            descricao: `Slot ${slotMin}': após ${cond} → próxima hora: ${res}`
          });
        }
      }
    }

    // PADRÃO HT ATÍPICO → FT: quando HT tem 3+ gols ou é virada, o que vira no FT?
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const jogos = linhas.flatMap(l => l.slots.filter(s => s.slot_min === slotMin));
        if (jogos.length < minOcorr) continue;
        const acc = {};
        for (const j of jogos) {
          const htA = parseInt(j.ht_a)||0, htB = parseInt(j.ht_b)||0;
          if (htA + htB < 3) continue; // só HT com 3+ gols
          const cond = `HT ${j.ht_str}`;
          const res  = tagPrincipal(j);
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          acc[cond].res[res] = (acc[cond].res[res] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < 3) continue;
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          const baseV = baseRate(ligaKey, res);
          const edge = conf - baseV;
          if (edge < 5) continue;
          padroes.push({
            id: `htat_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'),
            tipo: 'ht-atipico', liga: ligaKey, slot_min: slotMin,
            condicao: [cond], resultado: res,
            ocorrencias: v.total, acertos: cnt, confianca: conf,
            base_rate: baseV, edge,
            descricao: `Slot ${slotMin}': ${cond} (3+ gols HT) → FT ${res}`
          });
        }
      }
    }

    // PADRÃO HORIZONTAL CATEGORIA: tagPrincipal(slot[i]) → tagPrincipal(slot[i+1]) na mesma hora
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const acc = {};
      for (const linha of linhas) {
        const slots = linha.slots;
        for (let i = 0; i < slots.length - 1; i++) {
          const cond = tagPrincipal(slots[i]);
          const prox = tagPrincipal(slots[i + 1]);
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          acc[cond].res[prox] = (acc[cond].res[prox] || 0) + 1;
        }
      }
      for (const [cond, v] of Object.entries(acc)) {
        if (v.total < minOcorr) continue;
        const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
        if (!melhor) continue;
        const [res, cnt] = melhor;
        const conf = Math.round(cnt / v.total * 100);
        if (conf < minConf) continue;
        const baseH = baseRate(ligaKey, res);
        const edge = conf - baseH;
        if (edge < 5) continue;
        padroes.push({
          id: `hc_${ligaKey}_${cond}_${res}`.replace(/\W/g,'_'),
          tipo: 'horizontal-cat', liga: ligaKey, slot_min: null,
          condicao: [cond], resultado: res,
          ocorrencias: v.total, acertos: cnt, confianca: conf,
          base_rate: baseH, edge,
          descricao: `Mesma hora: depois de ${cond} → próximo slot: ${res}`
        });
      }
    }

    const vistos = new Set();
    const final = padroes
      .filter(p => { if (vistos.has(p.id)) return false; vistos.add(p.id); return true; })
      .sort((a, b) => (b.edge - a.edge) || (b.confianca - a.confianca) || (b.ocorrencias - a.ocorrencias))
      .slice(0, 150);

    res.json({ ok: true, total: final.length, horas: Number(horas), padroes: final });
  } catch(e) { next(e); }
});

// GET /api/virturia/padroes-live — ONDE JOGAR AGORA
// Minerador compartilhado (8 geometrias × 3 leituras) — ver lib/padroes-live.js
router.get('/padroes-live', require('../lib/padroes-live')(db, 'virturia_resultados'));

// GET /api/virturia/padroes-confronto — previsão por teamA × teamB × slot
router.get('/padroes-confronto', require('../lib/padroes-confronto')(db, 'virturia_resultados', [
  { sub: 'brasileirao-betano',   liga: 'brasileirao',   provider: 'betano' },
  { sub: 'copa-america',         liga: 'copa_america',  provider: 'betano' },
  { sub: 'euro',                 liga: 'euro',          provider: 'betano' },
  { sub: 'italiano',             liga: 'italiano',      provider: 'betano' },
  { sub: 'classicos-da-america', liga: 'classicos',     provider: 'betano' },
  { sub: 'copa-das-estrelas',    liga: 'copa_estrelas', provider: 'betano' },
]));

// 🔮 GET /api/virturia/previsao — jogos futuros × histórico do confronto
// (motor compartilhado com a Bet365 — ver lib/previsao.js)
router.get('/previsao', require('../lib/previsao')(db, 'virturia_resultados', {
  provider: 'betano',
  ligas: [
    { sub: 'brasil',              liga: 'brasileirao' },
    { sub: 'copa-america',        liga: 'copa_america' },
    { sub: 'euro',                liga: 'euro' },
    { sub: 'campeonato-italiano', liga: 'italiano' },
    { sub: 'copa-das-estrelas',   liga: 'copa_estrelas' },
    { sub: 'ligas-america',       liga: 'classicos' },
    { sub: 'british-derbies',     liga: 'british_derbies' },
    { sub: 'liga-espanhola',      liga: 'liga_espanhola' },
    { sub: 'scudetto-italiano',   liga: 'scudetto' },
  ],
  slots: {
    brasileirao:   [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
    classicos:     [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    copa_america:  [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
    euro:          [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    italiano:      [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
    copa_estrelas: [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
  },
  slotsFallback: [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
  toRealUtcMs: 3 * 3600000,    // EasyCo grava BRT rotulado como UTC
  clockFromRealMs: -3 * 3600000 // relógio da Betano = BRT
}));

// Coleta direto da Betano pelo VPS (IP fixo, sem Cloudflare)
const BETANO = 'https://www.betano.bet.br';
const LIGA_MAP = {
  '204676': 'brasileirao',
  '199959': 'classicos',
  '203063': 'copa_america',
  '203064': 'euro',
  '199961': 'italiano',
  '199960': 'copa_estrelas'
};
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.betano.bet.br/virtuals/futebol/'
};

router.get('/coletar', async (req, res) => {
  try {
    const r = await fetch('https://betano-proxy.f5novacursos.workers.dev/run');
    if (!r.ok) throw new Error('Worker HTTP ' + r.status);
    const data = await r.json();
    res.json({ ok: true, source: 'worker-proxy', worker: data });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/virturia/limpar — limpa registros por data (requer chave)
router.post('/limpar', async (req, res, next) => {
  try {
    const { chave, data, liga } = req.body;
    if (chave !== 'virturia2026secret') return res.status(403).json({ ok: false, error: 'chave invalida' });
    // Modo liga: apaga TODOS os registros de uma liga (p/ recoletar após corrigir a grade de slots)
    if (liga) {
      const r = await db.query(`DELETE FROM virturia_resultados WHERE liga = $1`, [liga]);
      return res.json({ ok: true, deletados: r.rowCount, liga });
    }
    if (!data) return res.status(400).json({ ok: false, error: 'data ou liga obrigatoria' });
    const r = await db.query(
      `DELETE FROM virturia_resultados WHERE coletado_em >= $1::date AND coletado_em < ($1::date + interval '1 day')`,
      [data]
    );
    res.json({ ok: true, deletados: r.rowCount, data });
  } catch(e) { next(e); }
});

// Trigger legado (mantido para compatibilidade)
router.get('/trigger', async (req, res) => {
  try {
    const r = await fetch('https://betano-proxy.f5novacursos.workers.dev/run');
    const data = await r.json();
    res.json({ ok: true, worker: data });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 🧠 GET /api/virturia/previsao-proxima-hora
// Motor dinâmico Betano — analisa TODO o histórico, encontra QUALQUER padrão
// que se repete (janelas 1-3 linhas), prioriza atípicos (0-0, 5+, espelhos).
// Timezone: BRT (UTC-3). min_ocorrencias padrão: 7.
router.get('/previsao-proxima-hora', async (req, res, next) => {
  try {
    const { min_confianca = 60, min_ocorrencias = 7 } = req.query;
    const minConf  = parseInt(min_confianca) || 60;
    const minOcorr = parseInt(min_ocorrencias) || 7;

    // Taxa base estrutural por "principal" neste motor (calibrado 25/06/2026).
    const BASE_RATE_PPH = { 'UNDER 1.5': 28, 'OVER 1.5': 72, 'OVER 2.5': 41, 'OVER 3.5': 18, 'OVER 4.5': 8, '0-0': 8 };
    const MIN_EDGE_PPH  = 10; // edge mínimo sobre a base
    const MAX_POR_LIGA  =  3; // cap por liga — mesma filosofia do top=3 da Especial
    // Piso por liga+mercado — portado da aba Especial (25/06/2026).
    const PISO_LM_PPH = {
      'brasileirao|OVER 2.5':  999,
      'copa_america|OVER 2.5': 999,
    };

    // Hora BRT atual
    const agoraBRT    = new Date(Date.now() - 10800000); // UTC-3
    const horaBRT     = agoraBRT.getUTCHours();
    const proxHoraBRT = (horaBRT + 1) % 24;

    // ── 1. Busca TODO o histórico ──
    const rHist = await db.query(`
      SELECT liga, hora, slot_min, ft_str, ft_a, ft_b, gols_total,
             is_btts, empate, start_time,
             DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
      FROM virturia_resultados
      ORDER BY liga, start_time ASC
    `);

    if (rHist.rows.length < 20) {
      return res.json({ ok: true, total: 0, hora_brt: proxHoraBRT, previsoes: [] });
    }

    // ── 2. Classifica cada resultado ──
    function classificar(r) {
      const g = r.gols_total; const a = r.ft_a, b = r.ft_b;
      let principal;
      if (g === 0)       principal = '0-0';
      else if (g >= 5)   principal = 'OVER 4.5';
      else if (g >= 4)   principal = 'OVER 3.5';
      else if (g >= 3)   principal = 'OVER 2.5';
      else if (g >= 2)   principal = 'OVER 1.5';
      else               principal = 'UNDER 1.5';
      const atipico = g === 0 || g >= 5 || (a === b && g >= 2);
      return { principal, atipico, ft: r.ft_str };
    }

    // ── 3. Organiza por liga → lista de linhas (hora × slots) ──
    const linhaMap = {};
    for (const j of rHist.rows) {
      const k = `${j.liga}|${j.dia}|${j.hora}`;
      if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), slots: [] };
      linhaMap[k].slots.push({ ...j, ...classificar(j) });
    }
    const ligaLinhas = {};
    for (const v of Object.values(linhaMap)) {
      if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
      v.slots.sort((a, b) => a.slot_min - b.slot_min);
      ligaLinhas[v.liga].push(v);
    }
    for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

    // ── 4. Motor de padrões — janelas 1, 2, 3 consecutivas → próximo ──
    const padraoMap = {};
    for (const [liga, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
        if (seq.length < minOcorr + 1) continue;
        for (let janela = 1; janela <= 3; janela++) {
          const acc = {};
          for (let i = 0; i <= seq.length - janela - 1; i++) {
            const conds = seq.slice(i, i + janela);
            const prox  = seq[i + janela];
            const condKey    = conds.map(c => c.principal).join(' → ');
            const temAtipico = conds.some(c => c.atipico);
            if (!acc[condKey]) acc[condKey] = { total: 0, res: {}, atipico: temAtipico, janela };
            acc[condKey].total++;
            acc[condKey].res[prox.principal] = (acc[condKey].res[prox.principal] || 0) + 1;
            if (temAtipico) acc[condKey].atipico = true;
          }
          for (const [condKey, v] of Object.entries(acc)) {
            if (v.total < minOcorr) continue;
            const melhor = Object.entries(v.res).sort((a, b) => b[1] - a[1])[0];
            if (!melhor) continue;
            const [res, cnt] = melhor;
            const conf = Math.round(cnt / v.total * 100);
            if (conf < minConf) continue;
            const base = BASE_RATE_PPH[res] || 50;
            const edge = conf - base;
            if (edge < MIN_EDGE_PPH) continue; // sem edge real — mata OVER 1.5 de base 72%
            const pisoLM = PISO_LM_PPH[`${liga}|${res}`] || 0;
            if (conf < pisoLM) continue; // veto/piso por liga+mercado
            const chave = `${liga}|${slotMin}`;
            if (!padraoMap[chave]) padraoMap[chave] = [];
            padraoMap[chave].push({ liga, slot_min: slotMin, condicao: condKey, resultado: res, confianca: conf, edge, ocorrencias: v.total, acertos: cnt, atipico: v.atipico, janela: v.janela });
          }
        }
      }
    }

    // ── 5. Melhor padrão por slot — atípico > edge > confiança > janela maior ──
    const previsoes = [];
    for (const [chave, candidatos] of Object.entries(padraoMap)) {
      candidatos.sort((a, b) => {
        if (a.atipico !== b.atipico) return b.atipico - a.atipico;
        if ((b.edge || 0) !== (a.edge || 0)) return (b.edge || 0) - (a.edge || 0);
        if (b.confianca !== a.confianca) return b.confianca - a.confianca;
        return b.janela - a.janela;
      });
      const melhor = candidatos[0];
      previsoes.push({
        ...melhor,
        hora_alvo_brt: proxHoraBRT,
        historico_recente: (() => {
          const [liga2, slot2] = chave.split('|');
          const seqSlot = (ligaLinhas[liga2] || [])
            .map(l => (l.slots || []).find(s => s.slot_min === parseInt(slot2)))
            .filter(Boolean).slice(-5);
          return seqSlot.map(s => ({ ft: s.ft, gols: s.gols_total, atipico: s.atipico }));
        })(),
      });
    }

    // Ordena por atípico > edge > confiança e aplica cap por liga (MAX_POR_LIGA)
    previsoes.sort((a, b) => {
      if (a.atipico !== b.atipico) return b.atipico - a.atipico;
      if ((b.edge || 0) !== (a.edge || 0)) return (b.edge || 0) - (a.edge || 0);
      return b.confianca - a.confianca;
    });
    const contLiga = {};
    const previsoesFinal = previsoes.filter(p => {
      contLiga[p.liga] = (contLiga[p.liga] || 0) + 1;
      return contLiga[p.liga] <= MAX_POR_LIGA;
    });

    res.json({
      ok: true,
      hora_brt: proxHoraBRT,
      hora_brt_atual: horaBRT,
      total: previsoesFinal.length,
      total_atipicos: previsoesFinal.filter(p => p.atipico).length,
      previsoes: previsoesFinal,
    });
  } catch(e) { next(e); }
});

// GET /api/virturia/historico-acertos
// Roda o motor retroativamente nas últimas N horas e verifica acertos reais.
router.get('/historico-acertos', async (req, res, next) => {
  try {
    const { horas_atras = 4, min_confianca = 60 } = req.query;
    const minConf   = parseInt(min_confianca) || 60;
    const minOcorr  = 7;
    const horasAtras = parseInt(horas_atras) || 4;

    function classificar(r) {
      const g = r.gols_total; const a = r.ft_a, b = r.ft_b;
      let principal;
      if (g === 0)       principal = '0-0';
      else if (g >= 5)   principal = 'OVER 4.5';
      else if (g >= 4)   principal = 'OVER 3.5';
      else if (g >= 3)   principal = 'OVER 2.5';
      else if (g >= 2)   principal = 'OVER 1.5';
      else               principal = 'UNDER 1.5';
      const atipico = g === 0 || g >= 5 || (a === b && g >= 2);
      return { principal, atipico };
    }

    async function gerarPrevisoesPara(corteMs) {
      const rHist = await db.query(`
        SELECT liga, hora, slot_min, ft_str, ft_a, ft_b, gols_total,
               is_btts, empate, start_time,
               DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
        FROM virturia_resultados
        WHERE start_time < $1
        ORDER BY liga, start_time ASC
      `, [corteMs]);
      if (rHist.rows.length < 20) return [];
      const linhaMap = {};
      for (const j of rHist.rows) {
        const k = `${j.liga}|${j.dia}|${j.hora}`;
        if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), slots: [] };
        linhaMap[k].slots.push({ ...j, ...classificar(j) });
      }
      const ligaLinhas = {};
      for (const v of Object.values(linhaMap)) {
        if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
        v.slots.sort((a, b) => a.slot_min - b.slot_min);
        ligaLinhas[v.liga].push(v);
      }
      for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);
      const padraoMap = {};
      for (const [liga, linhas] of Object.entries(ligaLinhas)) {
        const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
        for (const slotMin of todosSlots) {
          const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
          if (seq.length < minOcorr + 1) continue;
          for (let janela = 1; janela <= 3; janela++) {
            const acc = {};
            for (let i = 0; i <= seq.length - janela - 1; i++) {
              const conds = seq.slice(i, i + janela);
              const prox  = seq[i + janela];
              const condKey = conds.map(c => c.principal).join(' → ');
              const temAtipico = conds.some(c => c.atipico);
              if (!acc[condKey]) acc[condKey] = { total: 0, res: {}, atipico: temAtipico, janela };
              acc[condKey].total++;
              acc[condKey].res[prox.principal] = (acc[condKey].res[prox.principal] || 0) + 1;
            }
            for (const [condKey, v] of Object.entries(acc)) {
              if (v.total < minOcorr) continue;
              const melhor = Object.entries(v.res).sort((a, b) => b[1] - a[1])[0];
              if (!melhor) continue;
              const [resul, cnt] = melhor;
              const conf = Math.round(cnt / v.total * 100);
              if (conf < minConf) continue;
              const chave = `${liga}|${slotMin}`;
              if (!padraoMap[chave]) padraoMap[chave] = [];
              padraoMap[chave].push({ liga, slot_min: slotMin, resultado: resul, confianca: conf, ocorrencias: v.total, atipico: v.atipico, janela: v.janela });
            }
          }
        }
      }
      const previsoes = [];
      for (const [, candidatos] of Object.entries(padraoMap)) {
        candidatos.sort((a, b) => (a.atipico !== b.atipico ? b.atipico - a.atipico : b.confianca !== a.confianca ? b.confianca - a.confianca : b.janela - a.janela));
        previsoes.push(candidatos[0]);
      }
      return previsoes;
    }

    function bateu(previsto, gols, is_btts) {
      if (previsto === '0-0')       return gols === 0;
      if (previsto === 'OVER 1.5')  return gols >= 2;
      if (previsto === 'UNDER 1.5') return gols <= 1;
      if (previsto === 'OVER 2.5')  return gols >= 3;
      if (previsto === 'UNDER 2.5') return gols <= 2;
      if (previsto === 'OVER 3.5')  return gols >= 4;
      if (previsto === 'OVER 4.5')  return gols >= 5;
      if (previsto === 'AMBAS SIM') return is_btts;
      return false;
    }

    const horas = [];
    for (let i = horasAtras; i >= 1; i--) {
      // Hora BRT = UTC - 3h
      const inicioBRT = new Date(Date.now() - 10800000 - i * 3600000);
      inicioBRT.setUTCMinutes(0, 0, 0);
      const fimBRT    = new Date(inicioBRT.getTime() + 3600000);
      const horaBRT   = inicioBRT.getUTCHours();
      const dataBRT   = inicioBRT.toISOString().slice(0, 10);
      const inicioMs  = inicioBRT.getTime() + 10800000; // volta para UTC real
      const fimMs     = fimBRT.getTime()    + 10800000;

      const previsoes = await gerarPrevisoesPara(inicioMs);
      const prevMap   = {};
      for (const p of previsoes) prevMap[`${p.liga}|${p.slot_min}`] = p;

      const rReal = await db.query(`
        SELECT liga, slot_min, ft_str, ft_a, ft_b, gols_total, is_btts, start_time
        FROM virturia_resultados
        WHERE start_time >= $1 AND start_time < $2
        ORDER BY liga, slot_min ASC
      `, [inicioMs, fimMs]);

      const entradas = [];
      for (const r of rReal.rows) {
        const chave = `${r.liga}|${r.slot_min}`;
        const prev  = prevMap[chave];
        if (!prev) continue;
        const acertou = bateu(prev.resultado, r.gols_total, r.is_btts);
        entradas.push({ liga: r.liga, slot_min: r.slot_min, previsto: prev.resultado, confianca: prev.confianca, ocorrencias: prev.ocorrencias, ft_real: r.ft_str, gols_real: r.gols_total, status: acertou ? 'green' : 'red' });
      }
      const greens = entradas.filter(e => e.status === 'green').length;
      const reds   = entradas.filter(e => e.status === 'red').length;
      const total  = greens + reds;
      horas.push({ hora_brt: horaBRT, data_brt: dataBRT, resumo: { greens, reds, total, pct: total > 0 ? Math.round(greens / total * 100) : null }, entradas });
    }
    res.json({ ok: true, horas });
  } catch(e) { next(e); }
});

// GET /api/virturia/odds-altas — entradas diamante (0-0, 5+, total exato)
router.get('/odds-altas', require('../lib/odds-altas')(db, 'virturia_resultados', [
  { sub: 'brasil',              liga: 'brasileirao',   provider: 'betano' },
  { sub: 'copa-america',        liga: 'copa_america',  provider: 'betano' },
  { sub: 'euro',                liga: 'euro',          provider: 'betano' },
  { sub: 'campeonato-italiano', liga: 'italiano',      provider: 'betano' },
  { sub: 'ligas-america',       liga: 'classicos',     provider: 'betano' },
  { sub: 'copa-das-estrelas',   liga: 'copa_estrelas', provider: 'betano' },
]));

// GET /api/virturia/betano-fetch?leagueId=204676&last=20
// Proxy: Worker chama esta rota → VPS busca na Betano → devolve JSON
// Resolve o bloqueio 403 da Betano contra IPs de datacenter Cloudflare
router.get(`/betano-fetch`, async (req, res) => {
  try {
    const { leagueId, last = 20 } = req.query;
    if (!leagueId) return res.status(400).json({ ok: false, error: `leagueId obrigatorio` });
    const url = `https://betano.bet.br/api/virtuals/resultsdata/?leagueId=${leagueId}&last=${last}&_t=${Date.now()}`;
    const r = await fetch(url, { headers: HDR });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Betano HTTP ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
