const router = require('express').Router();
const db     = require('../db');
const adminAuth = require('../middleware/adminAuth');

const DEFAULTS = {
  nome:      'F5 Nova Cursos',
  endereco:  'Av. Amazonas, 188 — Estados, João Pessoa - PB',
  whatsapp:  '5583998874995',
  email:     'f5novacursos@gmail.com',
  instagram: '',
};

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS site_config (
        chave VARCHAR(40) PRIMARY KEY,
        valor TEXT NOT NULL DEFAULT ''
      )
    `);
    const { rows } = await db.query('SELECT COUNT(*) FROM site_config');
    if (parseInt(rows[0].count) === 0) {
      for (const [chave, valor] of Object.entries(DEFAULTS)) {
        await db.query('INSERT INTO site_config (chave, valor) VALUES ($1,$2)', [chave, valor]);
      }
      console.log('[site-config] Tabela criada e valores padrao inseridos.');
    }
  } catch (e) {
    console.error('[site-config] migration error:', e.message);
  }
})();

/* GET /api/site-config — retorna { chave: valor, ... } */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT chave, valor FROM site_config');
    const out = { ...DEFAULTS };
    rows.forEach(r => { out[r.chave] = r.valor; });
    res.json(out);
  } catch (err) { next(err); }
});

/* PUT /api/site-config — atualiza um ou mais pares chave/valor */
router.put('/', adminAuth, async (req, res, next) => {
  try {
    const entradas = Object.entries(req.body || {}).filter(([k]) => k in DEFAULTS);
    if (!entradas.length) return res.status(400).json({ error: 'Nenhum campo valido enviado' });
    for (const [chave, valor] of entradas) {
      await db.query(
        `INSERT INTO site_config (chave, valor) VALUES ($1,$2)
         ON CONFLICT (chave) DO UPDATE SET valor=$2`,
        [chave, String(valor ?? '')]
      );
    }
    const { rows } = await db.query('SELECT chave, valor FROM site_config');
    const out = { ...DEFAULTS };
    rows.forEach(r => { out[r.chave] = r.valor; });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
