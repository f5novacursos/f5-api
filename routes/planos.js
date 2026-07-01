const router = require('express').Router();
const db     = require('../db');

const DEFAULTS = {
  vitrine:    { setup: 197, mensal: 27,  anual: 270 },
  lancamento: { setup: 297, mensal: 37,  anual: 370 },
  presenca:   { setup: 497, mensal: 47,  anual: 470 },
  autoridade: { setup: 797, mensal: 67,  anual: 670 },
};

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS planos_web (
        chave   VARCHAR(20) PRIMARY KEY,
        setup   INTEGER NOT NULL DEFAULT 0,
        mensal  INTEGER NOT NULL DEFAULT 0,
        anual   INTEGER NOT NULL DEFAULT 0
      )
    `);
    const { rows } = await db.query('SELECT COUNT(*) FROM planos_web');
    if (parseInt(rows[0].count) === 0) {
      for (const [chave, v] of Object.entries(DEFAULTS)) {
        await db.query(
          'INSERT INTO planos_web (chave, setup, mensal, anual) VALUES ($1,$2,$3,$4)',
          [chave, v.setup, v.mensal, v.anual]
        );
      }
    }
  } catch (e) {
    console.error('[planos] migration error:', e.message);
  }
})();

/* GET /api/planos — retorna todos os planos */
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM planos_web');
    const out = {};
    rows.forEach(r => { out[r.chave] = { setup: r.setup, mensal: r.mensal, anual: r.anual }; });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* PUT /api/planos — atualiza todos os planos */
router.put('/', async (req, res) => {
  try {
    const chaves = ['vitrine', 'lancamento', 'presenca', 'autoridade'];
    for (const chave of chaves) {
      const p = req.body[chave];
      if (!p) continue;
      await db.query(
        `INSERT INTO planos_web (chave, setup, mensal, anual) VALUES ($1,$2,$3,$4)
         ON CONFLICT (chave) DO UPDATE SET setup=$2, mensal=$3, anual=$4`,
        [chave, p.setup || 0, p.mensal || 0, p.anual || 0]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
