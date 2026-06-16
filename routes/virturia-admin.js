const express = require('express');
const router  = express.Router();
const db      = require('../db');

const AUTH_KEY = 'virturia2026secret';

const TABELAS = {
  betano: 'virturia_resultados',
  bet365: 'virturia_resultados_b365',
};

function auth(req, res, next) {
  if (req.headers['x-admin-key'] === AUTH_KEY) return next();
  res.status(401).json({ erro: 'não autorizado' });
}

function tabela(req) {
  const p = (req.query.provedor || 'betano').toLowerCase();
  return TABELAS[p] || TABELAS.betano;
}

function ligaWhere(req) {
  return req.query.liga ? `AND liga = '${req.query.liga.replace(/'/g, "''")}'` : '';
}

// GET /api/virturia/admin/resumo?provedor=betano&liga=brasileirao
router.get('/admin/resumo', auth, async (req, res) => {
  try {
    const t = tabela(req);
    const lw = ligaWhere(req);
    const r = await db.query(`
      SELECT
        COUNT(*)                                                          AS total,
        MIN(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') AS primeiro,
        MAX(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') AS ultimo,
        COUNT(DISTINCT liga)                                              AS ligas
      FROM ${t}
      WHERE 1=1 ${lw}
    `);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/virturia/admin/ligas?provedor=betano
router.get('/admin/ligas', auth, async (req, res) => {
  try {
    const t = tabela(req);
    const r = await db.query(`
      SELECT
        liga,
        COUNT(*)                                                                          AS total,
        ROUND(100.0*SUM(CASE WHEN gols_total >= 2 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS over15,
        ROUND(100.0*SUM(CASE WHEN gols_total <= 2 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS under25,
        ROUND(100.0*SUM(CASE WHEN gols_total >= 3 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS over25,
        ROUND(100.0*SUM(CASE WHEN gols_total <= 1 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS under15,
        ROUND(100.0*SUM(CASE WHEN is_btts         THEN 1 ELSE 0 END)/COUNT(*), 1)       AS btts,
        ROUND(AVG(gols_total)::numeric, 2)                                               AS media_gols
      FROM ${t}
      GROUP BY liga
      ORDER BY total DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/virturia/admin/padroes-ht?provedor=betano&liga=
router.get('/admin/padroes-ht', auth, async (req, res) => {
  try {
    const t = tabela(req);
    const lw = ligaWhere(req);
    const r = await db.query(`
      SELECT
        ht_str,
        COUNT(*)                                                                          AS total,
        ROUND(100.0*SUM(CASE WHEN gols_total >= 2 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS over15,
        ROUND(100.0*SUM(CASE WHEN gols_total <= 2 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS under25,
        ROUND(100.0*SUM(CASE WHEN gols_total >= 3 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS over25,
        ROUND(100.0*SUM(CASE WHEN gols_total <= 1 THEN 1 ELSE 0 END)/COUNT(*), 1)       AS under15,
        ROUND(100.0*SUM(CASE WHEN is_btts         THEN 1 ELSE 0 END)/COUNT(*), 1)       AS btts
      FROM ${t}
      WHERE ht_str IN ('0-0','1-0','0-1','1-1','2-0','0-2','2-1','1-2')
      ${lw}
      GROUP BY ht_str
      ORDER BY total DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/virturia/admin/gols?provedor=betano&liga=
router.get('/admin/gols', auth, async (req, res) => {
  try {
    const t = tabela(req);
    const lw = ligaWhere(req);
    const r = await db.query(`
      SELECT
        gols_total,
        COUNT(*)                                                               AS total,
        ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER(), 1)                        AS pct
      FROM ${t}
      WHERE 1=1 ${lw}
      GROUP BY gols_total
      ORDER BY gols_total
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/virturia/admin/placares?provedor=betano&liga=
router.get('/admin/placares', auth, async (req, res) => {
  try {
    const t = tabela(req);
    const lw = ligaWhere(req);
    const r = await db.query(`
      SELECT
        ft_str,
        COUNT(*)                                              AS total,
        ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER(), 1)       AS pct
      FROM ${t}
      WHERE 1=1 ${lw}
      GROUP BY ft_str
      ORDER BY total DESC
      LIMIT 20
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/virturia/admin/horas?provedor=betano&liga=
router.get('/admin/horas', auth, async (req, res) => {
  try {
    const t = tabela(req);
    const lw = ligaWhere(req);
    const r = await db.query(`
      SELECT
        hora,
        COUNT(*)                                                                    AS jogos,
        ROUND(100.0*SUM(CASE WHEN gols_total <= 2 THEN 1 ELSE 0 END)/COUNT(*), 1) AS under25_pct,
        ROUND(100.0*SUM(CASE WHEN gols_total >= 3 THEN 1 ELSE 0 END)/COUNT(*), 1) AS over25_pct,
        ROUND(100.0*SUM(CASE WHEN is_btts         THEN 1 ELSE 0 END)/COUNT(*), 1) AS btts_pct
      FROM ${t}
      WHERE 1=1 ${lw}
      GROUP BY hora
      ORDER BY hora
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
