const router = require('express').Router();
const db = require('../db');

// Auto-migration: garante que a coluna foto existe na tabela turmas
db.query("ALTER TABLE turmas ADD COLUMN IF NOT EXISTS foto VARCHAR(500)")
  .catch(err => console.error('[turmas] migration foto:', err.message));

// GET /api/turmas — listar turmas (com filtro opcional por status)
router.get('/', async (req, res, next) => {
  try {
    // Auto-avanca status:
    //   aberta   → formando  quando data_ini JÁ PASSOU (exclusive hoje)
    //   formando → encerrada quando data_fim JÁ PASSOU (exclusive hoje)
    await db.query(
      "UPDATE turmas SET status = 'formando' " +
      "WHERE status = 'aberta' " +
      "AND data_ini IS NOT NULL AND data_ini < CURRENT_DATE"
    );
    await db.query(
      "UPDATE turmas SET status = 'encerrada' " +
      "WHERE status = 'formando' " +
      "AND data_fim IS NOT NULL AND data_fim < CURRENT_DATE"
    );

    const { status, nome } = req.query;
    let query = 'SELECT * FROM turmas WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      query += ' AND status = $' + params.length;
    }
    if (nome) {
      params.push('%' + nome + '%');
      query += ' AND nome ILIKE $' + params.length;
    }

    query += ' ORDER BY data_ini DESC, id DESC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/turmas/:id — detalhe de uma turma
router.get('/:id', async (req, res, next) => {
  try {
    // Auto-avanca status: aberta -> formando se data_ini ja passou
    await db.query(
      "UPDATE turmas SET status = 'formando' " +
      "WHERE id = $1 AND status = 'aberta' " +
      "AND data_ini IS NOT NULL AND data_ini < CURRENT_DATE",
      [req.params.id]
    );
    await db.query(
      "UPDATE turmas SET status = 'encerrada' " +
      "WHERE id = $1 AND status = 'formando' " +
      "AND data_fim IS NOT NULL AND data_fim < CURRENT_DATE",
      [req.params.id]
    );

    const { rows } = await db.query('SELECT * FROM turmas WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Turma nao encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/turmas — criar turma
router.post('/', async (req, res, next) => {
  try {
    const { codigo, nome, turma, horario, dias, data_ini, data_fim, carga, vagas_total, vagas_ocupadas, status, foto } = req.body;
    const { rows } = await db.query(
      'INSERT INTO turmas (codigo, nome, turma, horario, dias, data_ini, data_fim, carga, vagas_total, vagas_ocupadas, status, foto) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [codigo, nome, turma, horario, dias, data_ini, data_fim, carga,
       vagas_total != null ? vagas_total : 15,
       vagas_ocupadas != null ? vagas_ocupadas : 0,
       status != null ? status : 'aberta',
       foto]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/turmas/:id — atualizar turma
router.put('/:id', async (req, res, next) => {
  try {
    const { codigo, nome, turma, horario, dias, data_ini, data_fim, carga, vagas_total, vagas_ocupadas, status, foto } = req.body;
    const { rows } = await db.query(
      'UPDATE turmas SET codigo=$1, nome=$2, turma=$3, horario=$4, dias=$5, data_ini=$6, ' +
      'data_fim=$7, carga=$8, vagas_total=$9, vagas_ocupadas=$10, status=$11, foto=$12 ' +
      'WHERE id=$13 RETURNING *',
      [codigo, nome, turma, horario, dias, data_ini, data_fim, carga, vagas_total, vagas_ocupadas, status, foto, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Turma nao encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/turmas/:id/vagas — atualizar vagas ocupadas
router.patch('/:id/vagas', async (req, res, next) => {
  try {
    const { vagas_ocupadas } = req.body;
    const { rows } = await db.query(
      'UPDATE turmas SET vagas_ocupadas=$1 WHERE id=$2 RETURNING *',
      [vagas_ocupadas, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/turmas/:id — excluir turma
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM turmas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
