const router = require('express').Router();
const db = require('../db');

// GET /api/reservas — listar reservas (filtro por interesse/busca)
router.get('/', async (req, res, next) => {
  try {
    const { busca, interesse } = req.query;
    let query = 'SELECT * FROM reservas WHERE 1=1';
    const params = [];

    if (busca) {
      params.push(`%${busca}%`);
      query += ` AND (nome ILIKE $${params.length} OR whatsapp ILIKE $${params.length})`;
    }
    if (interesse) {
      params.push(`%${interesse}%`);
      query += ` AND interesse ILIKE $${params.length}`;
    }

    query += ' ORDER BY criado_em DESC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/reservas/:id — detalhe
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM reservas WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Reserva não encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/reservas — nova reserva (chamada pelo formulário público do site)
// status aceito: 'reserva' (padrão) | 'aguardando_pagamento' (matrícula online)
router.post('/', async (req, res, next) => {
  try {
    const { nome, whatsapp, interesse, turma_pref, origem, status } = req.body;
    const statusValido = ['reserva', 'aguardando_pagamento'].includes(status) ? status : 'reserva';
    const { rows } = await db.query(
      `INSERT INTO reservas (nome, whatsapp, interesse, turma_pref, origem, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nome, whatsapp, interesse, turma_pref, origem ?? 'formulario_site', statusValido]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/reservas/:id/converter — converter reserva em aluno
router.post('/:id/converter', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Buscar dados da reserva
    const { rows: r } = await client.query('SELECT * FROM reservas WHERE id=$1', [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Reserva não encontrada' });
    const reserva = r[0];

    // Criar aluno — status_pagamento sempre começa como 'pendente'
    const { cpf, data_nasc, email, endereco, turma_id, status, pagamento, valor, status_pagamento } = req.body;
    const { rows: a } = await client.query(
      `INSERT INTO alunos (nome, whatsapp, cpf, data_nasc, email, endereco, curso, turma_id, status, pagamento, valor, status_pagamento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        reserva.nome, reserva.whatsapp, cpf, data_nasc, email, endereco,
        reserva.interesse, turma_id,
        status ?? 'ativo',
        pagamento ?? null,
        valor,
        status_pagamento ?? 'pendente'   // <-- padrão: pendente
      ]
    );

    // Incrementar vagas
    if (turma_id) {
      await client.query('UPDATE turmas SET vagas_ocupadas = vagas_ocupadas + 1 WHERE id=$1', [turma_id]);
    }

    // Remover reserva
    await client.query('DELETE FROM reservas WHERE id=$1', [req.params.id]);

    await client.query('COMMIT');
    res.status(201).json({ aluno: a[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/reservas/:id — excluir reserva
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM reservas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
