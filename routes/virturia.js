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
        brasileirao:   [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
        classicos:     [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
        copa_america:  [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
        euro:          [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
        italiano:      [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
        copa_estrelas: [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
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
    const { liga, horas = 168, min_ocorrencias = 3, min_confianca = 60 } = req.query;
    const cutoffMs = Date.now() - Number(horas) * 3600000;
    const ligaParam = liga ? [cutoffMs, liga] : [cutoffMs];
    const ligaFilter = liga ? `AND liga = $2` : '';

    const r = await db.query(`
      SELECT liga, hora, slot_min, ft_str, gols_total, is_btts,
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

    const vistos = new Set();
    const final = padroes
      .filter(p => { if (vistos.has(p.id)) return false; vistos.add(p.id); return true; })
      .sort((a, b) => (b.edge - a.edge) || (b.confianca - a.confianca) || (b.ocorrencias - a.ocorrencias))
      .slice(0, 100);

    res.json({ ok: true, total: final.length, horas: Number(horas), padroes: final });
  } catch(e) { next(e); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/virturia/padroes-live — ONDE JOGAR AGORA
// Minera o histórico em várias geometrias (vertical, torre 2/3,
// horizontal, seq. horizontal, diagonais, cruzamento) × 3 leituras
// (placar exato, total de gols, over/under) e cruza com o estado
// ATUAL da matrix. Saída: liga + hora alvo + slot alvo + previsão
// + probabilidade + amostra + edge. Cache 60s.
// ════════════════════════════════════════════════════════════════
let _liveCache = { key: '', ts: 0, data: null };

router.get('/padroes-live', async (req, res, next) => {
  try {
    const { liga, horas = 168, min_conf = 70, min_amostra = 5 } = req.query;
    const cacheKey = `${liga || 'all'}|${horas}|${min_conf}|${min_amostra}`;
    if (_liveCache.key === cacheKey && Date.now() - _liveCache.ts < 60000) {
      return res.json(_liveCache.data);
    }

    const cutoffMs = Date.now() - Number(horas) * 3600000;
    const params = liga ? [cutoffMs, liga] : [cutoffMs];
    const ligaFilter = liga ? 'AND liga = $2' : '';
    const r = await db.query(`
      SELECT liga, hora, slot_min, ft_str, gols_total, is_btts, start_time,
             DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
      FROM virturia_resultados
      WHERE start_time > $1 ${ligaFilter}
      ORDER BY liga, start_time ASC
    `, params);
    if (r.rows.length < 50) {
      return res.json({ ok: true, total: 0, previsoes: [], aviso: 'Dados insuficientes' });
    }

    const HORA_MS = 3600000;
    const agora = Date.now();
    const consecutivo = (a, b) => { const d = b - a; return d > HORA_MS * 0.5 && d < HORA_MS * 1.5; };

    // Mercados apostáveis (o que pode sair na célula alvo)
    const MARKETS = {
      '0-0':       g => g.gols_total === 0,
      'OVER 1.5':  g => g.gols_total >= 2,
      'UNDER 1.5': g => g.gols_total <= 1,
      'OVER 2.5':  g => g.gols_total >= 3,
      'UNDER 2.5': g => g.gols_total <= 2,
      'OVER 3.5':  g => g.gols_total >= 4,
      'AMBAS SIM': g => g.is_btts,
    };
    // Leituras da célula condição
    const CONDS = {
      placar: g => g.ft_str,
      gols:   g => `${g.gols_total} GOL`,
      ou:     g => (g.gols_total >= 3 ? 'OVER 2.5' : 'UNDER 2.5'),
    };

    // ── monta linhas (liga|dia|hora) e células por slot ──
    const linhaMap = {};
    for (const j of r.rows) {
      const k = `${j.liga}|${j.dia}|${j.hora}`;
      if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), cells: {} };
      if (Number(j.start_time) < linhaMap[k].ts) linhaMap[k].ts = Number(j.start_time);
      linhaMap[k].cells[j.slot_min] = j;
    }
    const ligaLinhas = {};
    for (const v of Object.values(linhaMap)) {
      (ligaLinhas[v.liga] = ligaLinhas[v.liga] || []).push(v);
    }
    for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

    const previsoes = [];

    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const slotList = [...new Set(linhas.flatMap(l => Object.keys(l.cells).map(Number)))].sort((a, b) => a - b);

      // taxa base por mercado (frequência natural na liga)
      const baseN = {}; let baseT = 0;
      for (const l of linhas) for (const s in l.cells) {
        const g = l.cells[s]; baseT++;
        for (const [m, fn] of Object.entries(MARKETS)) if (fn(g)) baseN[m] = (baseN[m] || 0) + 1;
      }
      const base = m => baseT ? Math.round((baseN[m] || 0) / baseT * 100) : 0;

      const cell = (li, si) => {
        if (li < 0 || li >= linhas.length || si < 0 || si >= slotList.length) return null;
        return linhas[li].cells[slotList[si]] || null;
      };
      const consecLinhas = (a, b) => a >= 0 && b < linhas.length && consecutivo(linhas[a].ts, linhas[b].ts);

      // ── GEOMETRIAS: células condição → célula alvo ──
      const GEOMS = {
        vertical:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si }),         check: li => true },
        torre2:     { cond: (li, si) => [cell(li - 1, si), cell(li, si)],                      alvo: (li, si) => ({ li: li + 1, si }),         check: li => consecLinhas(li - 1, li) },
        torre3:     { cond: (li, si) => [cell(li - 2, si), cell(li - 1, si), cell(li, si)],    alvo: (li, si) => ({ li: li + 1, si }),         check: li => consecLinhas(li - 2, li - 1) && consecLinhas(li - 1, li) },
        horizontal: { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li, si: si + 1 }),         check: li => true },
        seq_horiz:  { cond: (li, si) => [cell(li, si - 1), cell(li, si)],                      alvo: (li, si) => ({ li, si: si + 1 }),         check: li => true },
        diag_dir:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si: si + 1 }), check: li => true },
        diag_esq:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si: si - 1 }), check: li => true },
        cruzamento: { cond: (li, si) => [cell(li, si - 1), cell(li, si + 1)],                  alvo: (li, si) => ({ li: li + 1, si }),         check: li => true },
      };

      // ── MINERAÇÃO: conta o que saiu no alvo após cada condição ──
      const acc = {}; // `${geom}|${dim}|${condKey}` → { total, out: {mercado: count} }
      for (let li = 0; li < linhas.length; li++) {
        for (let si = 0; si < slotList.length; si++) {
          for (const [gName, G] of Object.entries(GEOMS)) {
            if (!G.check(li)) continue;
            const condCells = G.cond(li, si);
            if (condCells.some(c => !c)) continue;
            const ap = G.alvo(li, si);
            if (ap.li !== li && !consecLinhas(li, ap.li)) continue; // hora alvo precisa ser a seguinte
            const tCell = cell(ap.li, ap.si);
            if (!tCell) continue;
            for (const [dim, fn] of Object.entries(CONDS)) {
              const condKey = condCells.map(fn).join(',');
              // conta em dobro: específico do slot (fiel) + geral da liga (mais amostra)
              for (const key of [`${gName}|${dim}|${slotList[si]}|${condKey}`, `${gName}|${dim}|*|${condKey}`]) {
                if (!acc[key]) acc[key] = { total: 0, out: {} };
                acc[key].total++;
                for (const [m, mfn] of Object.entries(MARKETS)) {
                  if (mfn(tCell)) acc[key].out[m] = (acc[key].out[m] || 0) + 1;
                }
              }
            }
          }
        }
      }

      // ── ESTADO ATUAL: condições satisfeitas com alvo ainda em aberto ──
      for (let li = Math.max(0, linhas.length - 2); li < linhas.length; li++) {
        for (let si = 0; si < slotList.length; si++) {
          for (const [gName, G] of Object.entries(GEOMS)) {
            if (!G.check(li)) continue;
            const condCells = G.cond(li, si);
            if (condCells.some(c => !c)) continue;
            const ap = G.alvo(li, si);
            if (ap.si < 0 || ap.si >= slotList.length) continue;
            if (cell(ap.li, ap.si)) continue; // alvo já saiu → não é previsão

            const lastCell = condCells[condCells.length - 1];
            const condTs = Number(lastCell.start_time);
            let alvoTs, alvoHora;
            if (ap.li === li) { // mesma hora, slot seguinte
              alvoTs = condTs + (slotList[ap.si] - lastCell.slot_min) * 60000;
              alvoHora = linhas[li].hora;
            } else {            // próxima hora
              alvoTs = condTs + HORA_MS + (slotList[ap.si] - lastCell.slot_min) * 60000;
              alvoHora = (linhas[li].hora + 1) % 24;
            }
            if (alvoTs < agora - 10 * 60000) continue; // já era pra ter saído → stale
            if (alvoTs > agora + 75 * 60000) continue; // longe demais

            for (const [dim, fn] of Object.entries(CONDS)) {
              const condKey = condCells.map(fn).join(',');
              // prefere estatística do PRÓPRIO slot; sem amostra, cai pra geral da liga
              let st = acc[`${gName}|${dim}|${slotList[si]}|${condKey}`];
              let slotEspecifico = true;
              if (!st || st.total < Number(min_amostra)) {
                st = acc[`${gName}|${dim}|*|${condKey}`];
                slotEspecifico = false;
              }
              if (!st || st.total < Number(min_amostra)) continue;
              // melhor mercado deste padrão (maior edge acima da confiança mínima)
              let best = null;
              for (const [m, cnt] of Object.entries(st.out)) {
                const conf = Math.round(cnt / st.total * 100);
                if (conf < Number(min_conf)) continue;
                const edge = conf - base(m);
                if (!best || edge > best.edge) best = { m, conf, cnt, edge };
              }
              if (!best || best.edge <= 0) continue;
              previsoes.push({
                liga: ligaKey,
                geometria: gName,
                dimensao: dim,
                condicao: condCells.map(c => ({ hora: c.hora, slot_min: c.slot_min, ft: c.ft_str, leitura: fn(c) })),
                alvo: { hora: alvoHora, slot_min: slotList[ap.si], ts: alvoTs },
                previsao: best.m,
                prob: best.conf,
                amostra: st.total,
                acertos: best.cnt,
                base_rate: base(best.m),
                edge: best.edge,
                slot_especifico: slotEspecifico
              });
            }
          }
        }
      }
    }

    // dedupe: mesma liga+alvo+previsão → mantém a maior probabilidade/amostra
    const byKey = {};
    for (const p of previsoes) {
      const k = `${p.liga}|${p.alvo.hora}|${p.alvo.slot_min}|${p.previsao}`;
      if (!byKey[k] || p.prob > byKey[k].prob || (p.prob === byKey[k].prob && p.amostra > byKey[k].amostra)) byKey[k] = p;
    }
    const final = Object.values(byKey)
      .sort((a, b) => (b.prob - a.prob) || (b.edge - a.edge) || (b.amostra - a.amostra))
      .slice(0, 80);

    const payload = { ok: true, total: final.length, horas: Number(horas), gerado_em: new Date().toISOString(), previsoes: final };
    _liveCache = { key: cacheKey, ts: Date.now(), data: payload };
    res.json(payload);
  } catch (e) { next(e); }
});

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

module.exports = router;
