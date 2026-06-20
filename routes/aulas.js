const router = require('express').Router();
const db = require('../db');

// Auto-migration: banco de aulas reutilizável (repositório de planos + PDFs por título)
db.query(`
  CREATE TABLE IF NOT EXISTS aulas (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(200) NOT NULL,
    topicos TEXT,
    curso_id INTEGER,
    criado_em TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('[aulas] migration aulas:', err.message));

// PDF reutilizável do banco de aulas (escolhido por título na grade de frequência)
db.query("ALTER TABLE aulas ADD COLUMN IF NOT EXISTS pdf_url VARCHAR(500)")
  .catch(err => console.error('[aulas] migration pdf_url:', err.message));

// Frequência foi consolidada em routes/frequencia.js (tabelas freq_aulas / freq_presencas).
// As tabelas paralelas frequencia_aulas / frequencia_presenca que viviam aqui duplicavam
// aquela lógica — derrubadas para não confundir, MAS só se estiverem vazias (preserva
// qualquer dado que por acaso exista).
db.query(`
  DO $$
  BEGIN
    IF to_regclass('public.frequencia_presenca') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM frequencia_presenca LIMIT 1) THEN
      DROP TABLE frequencia_presenca;
    END IF;
    IF to_regclass('public.frequencia_aulas') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM frequencia_aulas LIMIT 1) THEN
      DROP TABLE frequencia_aulas;
    END IF;
  END $$;
`).catch(err => console.error('[aulas] drop duplicadas (se vazias):', err.message));

// ── AULAS (banco de conteúdo reutilizável) ─────────────────────────

// GET /api/aulas
router.get('/', async (req, res, next) => {
  try {
    const { curso_id } = req.query;
    let q = 'SELECT * FROM aulas';
    const p = [];
    if (curso_id) { p.push(curso_id); q += ' WHERE curso_id=$1'; }
    q += ' ORDER BY criado_em DESC';
    const { rows } = await db.query(q, p);
    res.json(rows);
  } catch(e){ next(e); }
});

// POST /api/aulas
router.post('/', async (req, res, next) => {
  try {
    const { titulo, topicos, curso_id, pdf_url } = req.body;
    const { rows } = await db.query(
      'INSERT INTO aulas (titulo, topicos, curso_id, pdf_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [titulo, topicos || null, curso_id || null, pdf_url || null]
    );
    res.json(rows[0]);
  } catch(e){ next(e); }
});

// PUT /api/aulas/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { titulo, topicos, curso_id, pdf_url } = req.body;
    const { rows } = await db.query(
      'UPDATE aulas SET titulo=$1, topicos=$2, curso_id=$3, pdf_url=COALESCE($4,pdf_url) WHERE id=$5 RETURNING *',
      [titulo, topicos || null, curso_id || null, pdf_url || null, req.params.id]
    );
    res.json(rows[0]);
  } catch(e){ next(e); }
});

// DELETE /api/aulas/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM aulas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e){ next(e); }
});

// NOTA: a frequência por turma vive em routes/frequencia.js (/api/frequencia).
// As rotas /frequencia e /presenca que existiam aqui foram removidas na consolidação.

module.exports = router;
