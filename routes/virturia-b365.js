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
      const dBRT = new Date(d.getTime() - 3*3600000);
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

module.exports = router;
