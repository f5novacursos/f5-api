const router = require('express').Router();
const db = require('../db');

// GET /api/alunos
router.get('/', async (req, res, next) => {
  try {
    // Auto-avanca: ativo -> formado APENAS quando turma está encerrada
    // (não avança por data para permitir que admin mova alunos de turma manualmente)
    await db.query(
      "UPDATE alunos a SET status = 'formado' FROM turmas t " +
      "WHERE a.turma_id = t.id AND a.status = 'ativo' " +
      "AND t.status = 'encerrada'"
    );

    const { busca, status, turma_id, status_pagamento } = req.query;
    let query = 'SELECT a.*, t.turma AS turma_nome, t.nome AS curso_nome FROM alunos a LEFT JOIN turmas t ON a.turma_id = t.id WHERE 1=1';
    const params = [];

    if (busca) {
      params.push('%' + busca + '%');
      query += ' AND (a.nome ILIKE $' + params.length +
               ' OR a.cpf ILIKE $' + params.length +
               ' OR a.email ILIKE $' + params.length +
               ' OR a.whatsapp ILIKE $' + params.length + ')';
    }
    if (status) {
      params.push(status);
      query += ' AND a.status = $' + params.length;
    }
    if (turma_id) {
      params.push(turma_id);
      query += ' AND a.turma_id = $' + params.length;
    }
    if (status_pagamento) {
      params.push(status_pagamento);
      query += ' AND a.status_pagamento = $' + params.length;
    }

    query += ' ORDER BY a.nome ASC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/alunos/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT a.*, t.turma AS turma_nome, t.nome AS curso_nome, t.horario, t.dias ' +
      'FROM alunos a LEFT JOIN turmas t ON a.turma_id = t.id WHERE a.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aluno nao encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/alunos
router.post('/', async (req, res, next) => {
  try {
    const { nome, cpf, data_nasc, email, whatsapp, endereco, curso, turma_id, status, pagamento, valor, status_pagamento } = req.body;
    const { rows } = await db.query(
      'INSERT INTO alunos (nome, cpf, data_nasc, email, whatsapp, endereco, curso, turma_id, status, pagamento, valor, status_pagamento) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [nome, cpf, data_nasc, email, whatsapp, endereco, curso, turma_id, status ?? 'ativo', pagamento, valor, status_pagamento ?? 'pendente']
    );
    if (turma_id) {
      await db.query('UPDATE turmas SET vagas_ocupadas = vagas_ocupadas + 1 WHERE id = $1', [turma_id]);
    }
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/alunos/:id — COALESCE preserva campos nao enviados (cert_hash, curso, etc.)
router.put('/:id', async (req, res, next) => {
  try {
    const { nome, cpf, data_nasc, email, whatsapp, endereco, curso, turma_id, status, pagamento, valor, cert_hash, status_pagamento } = req.body;

    // Aceita valor como string "R$ 550,00" ou numero
    const valorNum = valor != null
      ? parseFloat(String(valor).replace(/[^\d,.]/g,'').replace(',','.')) || null
      : null;

    const { rows } = await db.query(
      `UPDATE alunos SET
        nome             = COALESCE($1,  nome),
        cpf              = COALESCE($2,  cpf),
        data_nasc        = COALESCE($3,  data_nasc),
        email            = COALESCE($4,  email),
        whatsapp         = COALESCE($5,  whatsapp),
        endereco         = COALESCE($6,  endereco),
        curso            = COALESCE($7,  curso),
        turma_id         = COALESCE($8,  turma_id),
        status           = COALESCE($9,  status),
        pagamento        = COALESCE($10, pagamento),
        valor            = COALESCE($11, valor),
        cert_hash        = COALESCE(NULLIF($12,''), cert_hash),
        status_pagamento = COALESCE($13, status_pagamento)
      WHERE id = $14 RETURNING *`,
      [
        nome      ?? null,
        cpf       ?? null,
        data_nasc ?? null,
        email     ?? null,
        whatsapp  ?? null,
        endereco  ?? null,
        curso     ?? null,
        turma_id  ?? null,
        status    ?? null,
        pagamento || null,
        valorNum,
        cert_hash ?? null,
        status_pagamento ?? null,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aluno nao encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/alunos/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const { rows } = await db.query(
      'UPDATE alunos SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/alunos/:id/pagamento
router.patch('/:id/pagamento', async (req, res, next) => {
  try {
    const { status_pagamento, pagamento } = req.body;
    const { rows } = await db.query(
      'UPDATE alunos SET status_pagamento=$1, pagamento=$2 WHERE id=$3 RETURNING *',
      [status_pagamento, pagamento ?? null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/alunos/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT turma_id FROM alunos WHERE id=$1', [req.params.id]);
    if (rows.length) {
      const turma_id = rows[0].turma_id;
      await db.query('DELETE FROM alunos WHERE id=$1', [req.params.id]);
      if (turma_id) {
        await db.query('UPDATE turmas SET vagas_ocupadas = vagas_ocupadas - 1 WHERE id=$1 AND vagas_ocupadas > 0', [turma_id]);
      }
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
