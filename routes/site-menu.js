const router = require('express').Router();
const db     = require('../db');
const adminAuth = require('../middleware/adminAuth');

/*
 * site_menu guarda só os itens EXTRAS do menu — os que já existem hoje
 * (Início, Cursos, Serviços, Portfólio, Certificados, Contato, o CTA e o
 * botão de WhatsApp) continuam fixos no nav-loader.js, porque têm dropdown/
 * estilos especiais que uma lista simples não reproduz com segurança.
 * Itens cadastrados aqui aparecem no menu, antes de "Contato".
 */
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS site_menu (
        id      SERIAL PRIMARY KEY,
        label   VARCHAR(60)  NOT NULL,
        link    VARCHAR(200) NOT NULL,
        ordem   INTEGER      NOT NULL DEFAULT 0,
        ativo   BOOLEAN      NOT NULL DEFAULT true
      )
    `);
  } catch (e) {
    console.error('[site-menu] migration error:', e.message);
  }
})();

/* GET /api/site-menu — lista itens ativos, ordenados */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM site_menu WHERE ativo = true ORDER BY ordem, id');
    res.json(rows);
  } catch (err) { next(err); }
});

/* POST /api/site-menu — cria item */
router.post('/', adminAuth, async (req, res, next) => {
  try {
    const { label, link } = req.body;
    const ordem = parseInt(req.body.ordem) || 0;
    if (!label || !link) return res.status(400).json({ error: 'label e link sao obrigatorios' });
    const { rows } = await db.query(
      'INSERT INTO site_menu (label, link, ordem) VALUES ($1,$2,$3) RETURNING *',
      [label, link, ordem]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/* PUT /api/site-menu/:id — edita item (label, link, ordem, ativo) */
router.put('/:id', adminAuth, async (req, res, next) => {
  try {
    const { label, link } = req.body;
    const ordem = parseInt(req.body.ordem) || 0;
    const ativo = req.body.ativo !== false;
    if (!label || !link) return res.status(400).json({ error: 'label e link sao obrigatorios' });
    const { rows } = await db.query(
      'UPDATE site_menu SET label=$1, link=$2, ordem=$3, ativo=$4 WHERE id=$5 RETURNING *',
      [label, link, ordem, ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item nao encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* DELETE /api/site-menu/:id — remove item (hard delete, é so navegacao) */
router.delete('/:id', adminAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query('DELETE FROM site_menu WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Item nao encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
