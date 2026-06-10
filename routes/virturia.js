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
// GET /api/virturia/padroes-live — TORRES ATIVAS AGORA
// Detecta sequências em formação (vertical = mesmo slot em horas
// seguidas, horizontal = slots seguidos na hora atual) e calcula
// pela história quantas vezes a sequência REPETIU ou QUEBROU.
// É o que o Eduardo fazia manualmente na planilha ("torre em bloco").
// ════════════════════════════════════════════════════════════════
let _liveCache = { key: '', ts: 0, data: null };

router.get('/padroes-live', async (req, res, next) => {
  try {
    const { liga, horas = 168, min_torre = 3, min_amostra = 5 } = req.query;
    const cacheKey = `${liga || 'all'}|${horas}|${min_torre}`;
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

    if (r.rows.length < 30) {
      return res.json({ ok: true, total: 0, ativos: [], aviso: 'Dados insuficientes' });
    }

    // ── Dimensões de mercado (o que o Eduardo marca na planilha) ──
    const DIMS = {
      over_under: { tag: j => (j.gols_total >= 3 ? 'OVER 2.5' : 'UNDER 2.5'), minTorre: Math.max(3, Number(min_torre)) },
      ambas:      { tag: j => (j.is_btts ? 'AMBAS' : 'AMBAS NÃO'),            minTorre: Math.max(3, Number(min_torre)) },
      gols:       { tag: j => `${j.gols_total} GOL`,                          minTorre: Math.max(3, Number(min_torre)) },
      placar:     { tag: j => j.ft_str,                                       minTorre: 2 },
    };
    const HORA_MS = 3600000;
    const consecutivo = (tsA, tsB) => { const d = tsB - tsA; return d > HORA_MS * 0.5 && d < HORA_MS * 1.5; };

    // ── Monta linhas (liga|dia|hora) ──
    const linhaMap = {};
    for (const j of r.rows) {
      const k = `${j.liga}|${j.dia}|${j.hora}`;
      if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), slots: [] };
      if (Number(j.start_time) < linhaMap[k].ts) linhaMap[k].ts = Number(j.start_time);
      linhaMap[k].slots.push(j);
    }
    const ligaLinhas = {};
    for (const v of Object.values(linhaMap)) {
      if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
      v.slots.sort((a, b) => a.slot_min - b.slot_min);
      ligaLinhas[v.liga].push(v);
    }
    for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

    // ── Estatística histórica POOLED por (dim, tag, k) ──
    // seqs = lista de sequências [{tag, ts}] em ordem cronológica.
    // Conta: janelas onde os últimos k são iguais a tag e existe próximo
    // consecutivo → repetiu (mesmo tag) ou quebrou.
    function histRepete(seqs, tag, k) {
      let amostra = 0, repetiu = 0;
      for (const seq of seqs) {
        for (let i = k - 1; i < seq.length - 1; i++) {
          // janela seq[i-k+1 .. i]: todos com o tag e horas consecutivas
          let ok = true;
          for (let w = i - k + 1; w <= i; w++) {
            if (seq[w].tag !== tag) { ok = false; break; }
            if (w > i - k + 1 && !consecutivo(seq[w - 1].ts, seq[w].ts)) { ok = false; break; }
          }
          if (!ok) continue;
          if (!consecutivo(seq[i].ts, seq[i + 1].ts)) continue; // próximo precisa ser a hora seguinte
          amostra++;
          if (seq[i + 1].tag === tag) repetiu++;
        }
      }
      return { amostra, repetiu };
    }

    const ativos = [];
    const agora = Date.now();

    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      // ── VERTICAL: por slot, sequência através das horas ──
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))].sort((a, b) => a - b);
      for (const [dimKey, dim] of Object.entries(DIMS)) {
        // sequências verticais (uma por slot) — usadas tanto p/ detectar quanto p/ histórico pooled
        const seqsVert = todosSlots.map(sm =>
          linhas.map(l => {
            const g = l.slots.find(s => s.slot_min === sm);
            return g ? { tag: dim.tag(g), ts: l.ts, hora: l.hora, ft: g.ft_str, gols: g.gols_total } : null;
          }).filter(Boolean)
        );

        for (let si = 0; si < todosSlots.length; si++) {
          const seq = seqsVert[si];
          if (seq.length < 2) continue;
          const last = seq[seq.length - 1];
          // só é "ativo" se o último jogo é recente (até 2h atrás)
          if (agora - last.ts > 2 * HORA_MS) continue;
          // torre terminando no último jogo
          let torre = 1;
          while (torre < seq.length) {
            const a = seq[seq.length - 1 - torre], b = seq[seq.length - torre];
            if (a.tag === last.tag && consecutivo(a.ts, b.ts)) torre++; else break;
          }
          if (torre < dim.minTorre) continue;

          // histórico: tenta k=torre, desce até achar amostra suficiente
          let k = torre, hist = { amostra: 0, repetiu: 0 };
          while (k >= dim.minTorre) {
            hist = histRepete(seqsVert, last.tag, k);
            if (hist.amostra >= Number(min_amostra)) break;
            k--;
          }
          if (hist.amostra < 1) continue;
          const pct = Math.round(hist.repetiu / hist.amostra * 100);

          ativos.push({
            id: `lv_${ligaKey}_${todosSlots[si]}_${dimKey}_${last.tag}`.replace(/\W/g, '_'),
            tipo: 'vertical', liga: ligaKey, dimensao: dimKey,
            tag: last.tag, slot_min: todosSlots[si], torre,
            celulas: seq.slice(-torre).map(c => ({ hora: c.hora, ft: c.ft, gols: c.gols })),
            alvo: { hora: (last.hora + 1) % 24, slot_min: todosSlots[si], ts: last.ts + HORA_MS },
            repete_pct: pct, quebra_pct: 100 - pct,
            amostra: hist.amostra, k_historico: k,
            confiavel: hist.amostra >= Number(min_amostra),
            descricao: `${last.tag} x${torre} no slot ${todosSlots[si]}' — historicamente repete ${pct}% (${hist.repetiu}/${hist.amostra})`
          });
        }
      }

      // ── HORIZONTAL: slots seguidos dentro da hora mais recente ──
      const ultima = linhas[linhas.length - 1];
      if (ultima && agora - ultima.ts < 2 * HORA_MS) {
        for (const [dimKey, dim] of Object.entries(DIMS)) {
          const seqH = ultima.slots.map(g => ({ tag: dim.tag(g), ts: Number(g.start_time), slot: g.slot_min, ft: g.ft_str, gols: g.gols_total }));
          if (seqH.length < dim.minTorre) continue;
          const last = seqH[seqH.length - 1];
          let torre = 1;
          while (torre < seqH.length && seqH[seqH.length - 1 - torre].tag === last.tag) torre++;
          if (torre < dim.minTorre) continue;

          // histórico horizontal pooled: todas as linhas da liga
          const seqsHor = linhas.map(l => l.slots.map(g => ({ tag: dim.tag(g), ts: Number(g.start_time) })));
          // p/ horizontal os jogos são ~3min — adapta consecutivo via índice (já são ordenados, sem buracos relevantes)
          function histRepeteH(tag, k) {
            let amostra = 0, repetiu = 0;
            for (const s of seqsHor) {
              for (let i = k - 1; i < s.length - 1; i++) {
                let ok = true;
                for (let w = 0; w < k; w++) if (s[i - w].tag !== tag) { ok = false; break; }
                if (!ok) continue;
                amostra++;
                if (s[i + 1].tag === tag) repetiu++;
              }
            }
            return { amostra, repetiu };
          }
          let k = torre, hist = { amostra: 0, repetiu: 0 };
          while (k >= dim.minTorre) {
            hist = histRepeteH(last.tag, k);
            if (hist.amostra >= Number(min_amostra)) break;
            k--;
          }
          if (hist.amostra < 1) continue;
          const pct = Math.round(hist.repetiu / hist.amostra * 100);

          ativos.push({
            id: `lh_${ligaKey}_${dimKey}_${last.tag}`.replace(/\W/g, '_'),
            tipo: 'horizontal', liga: ligaKey, dimensao: dimKey,
            tag: last.tag, slot_min: last.slot, torre,
            celulas: seqH.slice(-torre).map(c => ({ slot_min: c.slot, ft: c.ft, gols: c.gols })),
            alvo: { hora: ultima.hora, proximo_slot: true },
            repete_pct: pct, quebra_pct: 100 - pct,
            amostra: hist.amostra, k_historico: k,
            confiavel: hist.amostra >= Number(min_amostra),
            descricao: `${last.tag} x${torre} seguidos na hora ${ultima.hora}h — repete ${pct}% (${hist.repetiu}/${hist.amostra})`
          });
        }
      }
    }

    // ordena: torres maiores + extremos (repete muito OU quebra muito) primeiro
    ativos.sort((a, b) => {
      const ea = Math.abs(a.repete_pct - 50) + a.torre * 5;
      const eb = Math.abs(b.repete_pct - 50) + b.torre * 5;
      return eb - ea;
    });

    const payload = { ok: true, total: ativos.length, horas: Number(horas), gerado_em: new Date().toISOString(), ativos: ativos.slice(0, 60) };
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
