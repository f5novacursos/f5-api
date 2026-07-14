const router = require('express').Router();
const db     = require('../db');
const adminAuth = require('../middleware/adminAuth');

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS site_paginas (
        pagina VARCHAR(60) NOT NULL,
        campo  VARCHAR(60) NOT NULL,
        valor  TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (pagina, campo)
      )
    `);
  } catch (e) {
    console.error('[site-paginas] migration error:', e.message);
  }
})();

/* GET /api/site-paginas/:pagina — retorna { campo: valor, ... } de uma pagina */
router.get('/:pagina', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT campo, valor FROM site_paginas WHERE pagina = $1',
      [req.params.pagina]
    );
    const out = {};
    rows.forEach(r => { out[r.campo] = r.valor; });
    res.json(out);
  } catch (err) { next(err); }
});

/* PUT /api/site-paginas/:pagina — grava um ou mais campos da pagina */
router.put('/:pagina', adminAuth, async (req, res, next) => {
  try {
    const entradas = Object.entries(req.body || {});
    if (!entradas.length) return res.status(400).json({ error: 'Nenhum campo enviado' });
    for (const [campo, valor] of entradas) {
      await db.query(
        `INSERT INTO site_paginas (pagina, campo, valor) VALUES ($1,$2,$3)
         ON CONFLICT (pagina, campo) DO UPDATE SET valor=$3`,
        [req.params.pagina, campo, String(valor ?? '')]
      );
    }
    const { rows } = await db.query(
      'SELECT campo, valor FROM site_paginas WHERE pagina = $1',
      [req.params.pagina]
    );
    const out = {};
    rows.forEach(r => { out[r.campo] = r.valor; });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
