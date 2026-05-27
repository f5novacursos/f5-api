const router = require('express').Router();
const db     = require('../db');

/* ── Auto-migration: cria tabela e semeia dados iniciais ── */
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS cursos (
        id        SERIAL PRIMARY KEY,
        nome      VARCHAR(100) NOT NULL,
        emoji     VARCHAR(10)  DEFAULT '📚',
        carga     INTEGER      NOT NULL DEFAULT 40,
        preco     NUMERIC      NOT NULL DEFAULT 600,
        ativo     BOOLEAN      DEFAULT true,
        criado_em TIMESTAMP    DEFAULT now()
      )
    `);
    const { rows } = await db.query('SELECT COUNT(*) FROM cursos');
    if (parseInt(rows[0].count) === 0) {
      await db.query(`
        INSERT INTO cursos (nome, emoji, carga, preco) VALUES
          ('Informática Profissional + IA', '💻', 60, 600),
          ('Design Gráfico',                '🎨', 50, 600),
          ('Excel Avançado',                '📊', 40, 400),
          ('Power BI',                      '📈', 40, 400)
      `);
      console.log('[cursos] Tabela criada e dados iniciais inseridos.');
    } else {
      console.log('[cursos] Tabela OK.');
    }
  } catch (err) {
    console.error('[cursos] Erro na migration:', err.message);
  }
})();

/* GET /api/cursos — lista todos os cursos ativos */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nome, emoji, carga, preco FROM cursos WHERE ativo = true ORDER BY id'
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* POST /api/cursos — cria novo curso */
router.post('/', async (req, res, next) => {
  try {
    const { nome, emoji = '📚', carga, preco } = req.body;
    if (!nome || !carga || !preco)
      return res.status(400).json({ error: 'nome, carga e preco sao obrigatorios' });
    const { rows } = await db.query(
      'INSERT INTO cursos (nome, emoji, carga, preco) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome, emoji, parseInt(carga), parseFloat(preco)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/* PUT /api/cursos/:id — atualiza curso */
router.put('/:id', async (req, res, next) => {
  try {
    const { nome, emoji, carga, preco } = req.body;
    if (!nome || !carga || !preco)
      return res.status(400).json({ error: 'nome, carga e preco sao obrigatorios' });
    const { rows } = await db.query(
      'UPDATE cursos SET nome=$1, emoji=$2, carga=$3, preco=$4 WHERE id=$5 AND ativo=true RETURNING *',
      [nome, emoji || '📚', parseInt(carga), parseFloat(preco), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Curso nao encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* DELETE /api/cursos/:id — desativa curso (soft delete) */
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'UPDATE cursos SET ativo=false WHERE id=$1 RETURNING nome',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Curso nao encontrado' });
    res.json({ ok: true, nome: rows[0].nome });
  } catch (err) { next(err); }
});

module.exports = router;
