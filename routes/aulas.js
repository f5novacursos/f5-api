const router = require('express').Router();
const db = require('../db');

// Auto-migration: cria tabelas se não existirem
db.query(`
  CREATE TABLE IF NOT EXISTS aulas (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(200) NOT NULL,
    topicos TEXT,
    curso_id INTEGER,
    criado_em TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('[aulas] migration aulas:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS frequencia_aulas (
    id SERIAL PRIMARY KEY,
    turma_id INTEGER NOT NULL,
    aula_id INTEGER,
    data DATE NOT NULL,
    aula_numero INTEGER,
    titulo VARCHAR(200),
    topicos TEXT,
    cancelada BOOLEAN DEFAULT FALSE,
    obs VARCHAR(500),
    criado_em TIMESTAMP DEFAULT NOW(),
    UNIQUE(turma_id, data)
  )
`).catch(err => console.error('[aulas] migration frequencia_aulas:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS frequencia_presenca (
    id SERIAL PRIMARY KEY,
    frequencia_aula_id INTEGER NOT NULL REFERENCES frequencia_aulas(id) ON DELETE CASCADE,
    aluno_id INTEGER NOT NULL,
    presente BOOLEAN DEFAULT FALSE,
    UNIQUE(frequencia_aula_id, aluno_id)
  )
`).catch(err => console.error('[aulas] migration frequencia_presenca:', err.message));

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
    const { titulo, topicos, curso_id } = req.body;
    const { rows } = await db.query(
      'INSERT INTO aulas (titulo, topicos, curso_id) VALUES ($1,$2,$3) RETURNING *',
      [titulo, topicos || null, curso_id || null]
    );
    res.json(rows[0]);
  } catch(e){ next(e); }
});

// PUT /api/aulas/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { titulo, topicos, curso_id } = req.body;
    const { rows } = await db.query(
      'UPDATE aulas SET titulo=$1, topicos=$2, curso_id=$3 WHERE id=$4 RETURNING *',
      [titulo, topicos || null, curso_id || null, req.params.id]
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

// ── FREQUÊNCIA POR TURMA ───────────────────────────────────────────

// GET /api/aulas/frequencia/:turma_id — retorna todas as aulas + presença da turma
router.get('/frequencia/:turma_id', async (req, res, next) => {
  try {
    const tid = req.params.turma_id;
    const { rows: aulas } = await db.query(
      'SELECT * FROM frequencia_aulas WHERE turma_id=$1 ORDER BY data ASC',
      [tid]
    );
    const { rows: presencas } = await db.query(
      `SELECT fp.* FROM frequencia_presenca fp
       JOIN frequencia_aulas fa ON fa.id = fp.frequencia_aula_id
       WHERE fa.turma_id=$1`,
      [tid]
    );
    res.json({ aulas, presencas });
  } catch(e){ next(e); }
});

// POST /api/aulas/frequencia — cria ou atualiza uma aula na grade de frequência
router.post('/frequencia', async (req, res, next) => {
  try {
    const { turma_id, data, aula_numero, titulo, topicos, cancelada, obs, aula_id } = req.body;
    const { rows } = await db.query(
      `INSERT INTO frequencia_aulas (turma_id, aula_id, data, aula_numero, titulo, topicos, cancelada, obs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (turma_id, data) DO UPDATE SET
         aula_id=EXCLUDED.aula_id, aula_numero=EXCLUDED.aula_numero,
         titulo=EXCLUDED.titulo, topicos=EXCLUDED.topicos,
         cancelada=EXCLUDED.cancelada, obs=EXCLUDED.obs
       RETURNING *`,
      [turma_id, aula_id || null, data, aula_numero || null, titulo || null, topicos || null, cancelada || false, obs || null]
    );
    res.json(rows[0]);
  } catch(e){ next(e); }
});

// POST /api/aulas/presenca — marca/desmarca presença de um aluno
router.post('/presenca', async (req, res, next) => {
  try {
    const { frequencia_aula_id, aluno_id, presente } = req.body;
    const { rows } = await db.query(
      `INSERT INTO frequencia_presenca (frequencia_aula_id, aluno_id, presente)
       VALUES ($1,$2,$3)
       ON CONFLICT (frequencia_aula_id, aluno_id) DO UPDATE SET presente=EXCLUDED.presente
       RETURNING *`,
      [frequencia_aula_id, aluno_id, presente]
    );
    res.json(rows[0]);
  } catch(e){ next(e); }
});

// DELETE /api/aulas/frequencia/:id — remove uma aula da grade
router.delete('/frequencia/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM frequencia_aulas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e){ next(e); }
});

module.exports = router;
