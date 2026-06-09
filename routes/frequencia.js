const router = require('express').Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');

// ── Auto-migration ─────────────────────────────────────────────────────────
(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS freq_aulas (
      id          SERIAL PRIMARY KEY,
      turma_id    INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
      numero      INTEGER NOT NULL,
      data        DATE NOT NULL,
      titulo      VARCHAR(200),
      pdf_url     VARCHAR(500),
      criado_em   TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.error('[freq] migration freq_aulas:', e.message));

  await db.query(`
    CREATE TABLE IF NOT EXISTS freq_presencas (
      id        SERIAL PRIMARY KEY,
      aula_id   INTEGER NOT NULL REFERENCES freq_aulas(id) ON DELETE CASCADE,
      aluno_id  INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
      presente  BOOLEAN DEFAULT FALSE,
      UNIQUE(aula_id, aluno_id)
    )
  `).catch(e => console.error('[freq] migration freq_presencas:', e.message));

  // Garante pasta de PDFs
  const uploadDir = '/usr/share/nginx/html/freq-pdfs';
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
})();

// ── GET /api/frequencia — lista turmas com resumo ───────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.nome, t.status, t.data_ini, t.data_fim, t.dia_semana, t.hora_ini, t.hora_fim,
              COUNT(DISTINCT a.id)::int  AS total_alunos,
              COUNT(DISTINCT fa.id)::int AS total_aulas
       FROM turmas t
       LEFT JOIN alunos a  ON a.turma_id = t.id AND a.status = 'ativo'
       LEFT JOIN freq_aulas fa ON fa.turma_id = t.id
       GROUP BY t.id
       ORDER BY t.data_ini DESC NULLS LAST, t.id DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/frequencia/:turma_id ───────────────────────────────────────────
router.get('/:turma_id', async (req, res, next) => {
  try {
    const tid = parseInt(req.params.turma_id);

    const { rows: alunos } = await db.query(
      `SELECT id, nome, cpf FROM alunos WHERE turma_id=$1 AND status='ativo' ORDER BY nome`,
      [tid]
    );
    const { rows: aulas } = await db.query(
      `SELECT * FROM freq_aulas WHERE turma_id=$1 ORDER BY numero`,
      [tid]
    );
    const { rows: presencas } = await db.query(
      `SELECT fp.aula_id, fp.aluno_id, fp.presente
       FROM freq_presencas fp
       JOIN freq_aulas fa ON fa.id=fp.aula_id
       WHERE fa.turma_id=$1`,
      [tid]
    );

    const mapaPresencas = {};
    presencas.forEach(p => {
      if (!mapaPresencas[p.aula_id]) mapaPresencas[p.aula_id] = {};
      mapaPresencas[p.aula_id][p.aluno_id] = p.presente;
    });

    res.json({ alunos, aulas, presencas: mapaPresencas });
  } catch (err) { next(err); }
});

// ── POST /api/frequencia/:turma_id/aulas — criar aula ───────────────────────
router.post('/:turma_id/aulas', async (req, res, next) => {
  try {
    const tid = parseInt(req.params.turma_id);
    const { numero, data, titulo, pdf_url } = req.body;

    const { rows: alunos } = await db.query(
      `SELECT id FROM alunos WHERE turma_id=$1 AND status='ativo'`, [tid]
    );
    const { rows: [aula] } = await db.query(
      `INSERT INTO freq_aulas (turma_id, numero, data, titulo, pdf_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tid, numero, data, titulo || `Aula ${String(numero).padStart(2,'0')}`, pdf_url||null]
    );
    for (const aluno of alunos) {
      await db.query(
        `INSERT INTO freq_presencas (aula_id, aluno_id, presente)
         VALUES ($1,$2,false) ON CONFLICT DO NOTHING`,
        [aula.id, aluno.id]
      );
    }
    res.status(201).json(aula);
  } catch (err) { next(err); }
});

// ── PUT /api/frequencia/aulas/:aula_id ──────────────────────────────────────
router.put('/aulas/:aula_id', async (req, res, next) => {
  try {
    const aid = parseInt(req.params.aula_id);
    const { titulo, pdf_url, data } = req.body;
    const { rows: [aula] } = await db.query(
      `UPDATE freq_aulas
       SET titulo  = COALESCE($1, titulo),
           pdf_url = COALESCE($2, pdf_url),
           data    = COALESCE($3::date, data)
       WHERE id=$4 RETURNING *`,
      [titulo||null, pdf_url||null, data||null, aid]
    );
    res.json(aula);
  } catch (err) { next(err); }
});

// ── DELETE /api/frequencia/aulas/:aula_id ────────────────────────────────────
router.delete('/aulas/:aula_id', async (req, res, next) => {
  try {
    await db.query(`DELETE FROM freq_aulas WHERE id=$1`, [parseInt(req.params.aula_id)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/frequencia/aulas/:aula_id/presenca ─────────────────────────────
router.post('/aulas/:aula_id/presenca', async (req, res, next) => {
  try {
    const aid = parseInt(req.params.aula_id);
    const { aluno_id, presente } = req.body;
    await db.query(
      `INSERT INTO freq_presencas (aula_id, aluno_id, presente)
       VALUES ($1,$2,$3)
       ON CONFLICT (aula_id, aluno_id) DO UPDATE SET presente=$3`,
      [aid, aluno_id, !!presente]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/frequencia/upload-pdf — base64 → salva arquivo ────────────────
router.post('/upload-pdf', async (req, res, next) => {
  try {
    const { nome, base64 } = req.body;
    if (!nome || !base64) return res.status(400).json({ error: 'nome e base64 obrigatórios' });
    const safe = nome.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = Date.now() + '_' + safe;
    const uploadDir = '/tmp/f5-pdfs';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(path.join(uploadDir, filename), buf);
    res.json({ url: `/api/frequencia/pdf/${filename}`, nome: safe });
  } catch (err) { next(err); }
});

// ── GET /api/frequencia/pdf/:filename ────────────────────────────────────────
router.get('/pdf/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join('/tmp/f5-pdfs', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF não encontrado' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── GET /api/frequencia/:turma_id/relatorio ──────────────────────────────────
router.get('/:turma_id/relatorio', async (req, res, next) => {
  try {
    const tid = parseInt(req.params.turma_id);
    const { rows } = await db.query(
      `SELECT a.id, a.nome, a.cpf,
              COUNT(fp.id) FILTER (WHERE fp.presente=true)::int AS presencas,
              COUNT(fa2.id)::int AS total,
              ROUND(
                100.0 * COUNT(fp.id) FILTER (WHERE fp.presente=true)
                / NULLIF(COUNT(fa2.id),0)
              ,1) AS percentual
       FROM alunos a
       CROSS JOIN freq_aulas fa2
       LEFT JOIN freq_presencas fp ON fp.aluno_id=a.id AND fp.aula_id=fa2.id
       WHERE a.turma_id=$1 AND a.status='ativo' AND fa2.turma_id=$1
       GROUP BY a.id, a.nome, a.cpf
       ORDER BY a.nome`,
      [tid]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
