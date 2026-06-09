const router = require('express').Router();
const db = require('../db');

// ── BET365 Virtual Sports — tabela separada ──────────────────────────────────
// TODO próximo chat: preencher leagueIds e slots reais da Bet365
// Eduardo vai trazer: nome das ligas, leagueIds, minutos dos slots

const B365_LEAGUE_MAP = {
  // 'leagueId': 'slug_liga'  — preencher no próximo chat
  // Ex: '12345': 'premier_league_b365'
};

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_resultados_b365 (
      id            SERIAL PRIMARY KEY,
      event_id      VARCHAR(60) NOT NULL UNIQUE,
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
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_b365_liga ON virturia_resultados_b365(liga)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_b365_hora ON virturia_resultados_b365(hora, slot_min)`);
}
initTable().catch(e => console.error('[virturia-b365] init error:', e.message));

// POST /api/virturia-b365/salvar
router.post('/salvar', async (req, res, next) => {
  try {
    const { resultados } = req.body;
    if (!Array.isArray(resultados) || resultados.length === 0) return res.json({ ok: true, salvos: 0 });

    const SLOTS = {
      express_cup:   [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59],
      copa_mundo:    [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
      euro_cup:      [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
      sul_americana: [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
      premier_league:[0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
    };

    let salvos = 0;
    for (const r of resultados) {
      if (!r.startTime) continue;
      const ftA = Number(r.scoreA)||0, ftB = Number(r.scoreB)||0;
      const htA = r.htA!=null?Number(r.htA):null, htB = r.htB!=null?Number(r.htB):null;
      const d = new Date(r.startTime);
      const dBRT = new Date(d.getTime() + 1*3600000); // BST = UTC+1
      const hora = dBRT.getUTCHours(), minuto = dBRT.getUTCMinutes();
      const ligaSlots = SLOTS[r.liga] || SLOTS['liga1_b365'];
      let slotIdx=0, minDiff=99;
      for (let i=0;i<ligaSlots.length;i++) {
        const diff=Math.abs(ligaSlots[i]-minuto);
        if(diff<minDiff){minDiff=diff;slotIdx=i;}
      }
      const slotMin = ligaSlots[slotIdx];
      const dataBRT = dBRT.toISOString().slice(0, 10);
      // event_id único por liga+dia+hora+slot (Bet365 também reutiliza IDs a cada ciclo)
      const eventId = `${r.liga}_${dataBRT}_${hora}_${slotMin}`;
      try {
        await db.query(`
          INSERT INTO virturia_resultados_b365
            (event_id,liga,hora,slot,slot_min,team_a,team_b,ft_a,ft_b,ht_a,ht_b,ft_str,ht_str,gols_total,is_btts,casa_ganha,visit_ganha,empate,ht_atipico,start_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (event_id) DO UPDATE SET
            ft_a=EXCLUDED.ft_a, ft_b=EXCLUDED.ft_b, ht_a=EXCLUDED.ht_a, ht_b=EXCLUDED.ht_b,
            ft_str=EXCLUDED.ft_str, ht_str=EXCLUDED.ht_str, gols_total=EXCLUDED.gols_total,
            is_btts=EXCLUDED.is_btts, casa_ganha=EXCLUDED.casa_ganha, visit_ganha=EXCLUDED.visit_ganha,
            empate=EXCLUDED.empate, start_time=EXCLUDED.start_time
        `, [eventId,r.liga,hora,slotIdx,slotMin,r.teamA,r.teamB,ftA,ftB,htA,htB,
            `${ftA}-${ftB}`,htA!=null?`${htA}-${htB}`:null,ftA+ftB,ftA>0&&ftB>0,ftA>ftB,ftB>ftA,ftA===ftB,
            htA!=null?(htA+htB>=3):false, r.startTime]);
        salvos++;
      } catch(e) { if(salvos===0) console.error('[b365 insert] liga='+r.liga+' eventId='+eventId+' err='+e.message); }
    }
    res.json({ ok: true, salvos, recebidos: resultados.length });
  } catch(e) { next(e); }
});

// GET /api/virturia-b365/resultados
router.get('/resultados', async (req, res, next) => {
  try {
    const { liga, horas = 6 } = req.query;
    const cutoffMs = Date.now() - Number(horas) * 3600000;
    const params = [cutoffMs];
    let ligaFilter = '';
    if (liga) { ligaFilter = 'AND liga = $2'; params.push(liga); }
    const r = await db.query(`
      SELECT event_id AS id, liga,
        team_a AS "teamA", team_b AS "teamB",
        ft_a::text AS "scoreA", ft_b::text AS "scoreB",
        ht_a::text AS "htA", ht_b::text AS "htB",
        start_time AS "startTime", start_time AS "endedAt", true AS "isEnded"
      FROM virturia_resultados_b365
      WHERE start_time > $1 ${ligaFilter}
      ORDER BY start_time DESC LIMIT 2000
    `, params);
    const tot = await db.query('SELECT COUNT(*) as t FROM virturia_resultados_b365 WHERE start_time > $1', [cutoffMs]);
    res.json({ ok: true, total: r.rows.length, hist: Number(tot.rows[0].t), results: r.rows });
  } catch(e) { next(e); }
});

// GET /api/virturia-b365/stats
router.get('/stats', async (req, res, next) => {
  try {
    const r = await db.query(`
      SELECT liga, COUNT(*) as total, MIN(coletado_em) as primeiro, MAX(coletado_em) as ultimo
      FROM virturia_resultados_b365 GROUP BY liga ORDER BY liga
    `);
    const total = await db.query('SELECT COUNT(*) as total FROM virturia_resultados_b365');
    res.json({ ok: true, total: Number(total.rows[0].total), por_liga: r.rows });
  } catch(e) { next(e); }
});


// GET /api/virturia-b365/padroes-auto
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
      FROM virturia_resultados_b365
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

    // Retorna só O resultado principal — sem contradições
    function tagPrincipal(j) {
      if (j.gols_total === 0) return '0-0';
      if (j.gols_total >= 4) return 'OVER 3.5';
      if (j.gols_total >= 3) return 'OVER 2.5';
      if (j.gols_total >= 2) return 'OVER 1.5';
      return 'UNDER 1.5';
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
          // Pega APENAS o resultado mais frequente
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          padroes.push({ id: `v_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'), tipo: 'vertical', liga: ligaKey, slot_min: slotMin, condicao: [cond], resultado: res, ocorrencias: v.total, acertos: cnt, confianca: conf, descricao: `Slot ${slotMin}': saiu ${cond} → próxima hora: ${res}` });
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
        // Pega APENAS o resultado mais frequente
        const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
        if (!melhor) continue;
        const [res, cnt] = melhor;
        const conf = Math.round(cnt / v.total * 100);
        if (conf < minConf) continue;
        padroes.push({ id: `h_${ligaKey}_${cond}_${res}`.replace(/\W/g,'_'), tipo: 'horizontal', liga: ligaKey, slot_min: null, condicao: [cond], resultado: res, ocorrencias: v.total, acertos: cnt, confianca: conf, descricao: `Mesma hora: depois de ${cond} → próximo slot: ${res}` });
      }
    }

    const vistos = new Set();
    const final = padroes
      .filter(p => { if (vistos.has(p.id)) return false; vistos.add(p.id); return true; })
      .sort((a, b) => b.confianca - a.confianca || b.ocorrencias - a.ocorrencias)
      .slice(0, 100);

    res.json({ ok: true, total: final.length, horas: Number(horas), padroes: final });
  } catch(e) { next(e); }
});

// POST /api/virturia-b365/limpar
router.post('/limpar', async (req, res, next) => {
  try {
    const { chave } = req.body;
    if (chave !== 'virturia2026secret') return res.status(403).json({ error: 'Chave inválida' });
    await db.query('DELETE FROM virturia_resultados_b365');
    res.json({ ok: true, msg: 'Tabela limpa com sucesso' });
  } catch(e) { next(e); }
});

module.exports = router;
