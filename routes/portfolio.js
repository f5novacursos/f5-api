const express = require('express');
const router  = express.Router();
const db      = require('../db');

/* ══════════════════════════════════════════════════════════════
   AUTO-MIGRATION — cria tabela clientes_web se não existir
   Roda uma vez no boot da API, igual ao padrão das outras rotas.
══════════════════════════════════════════════════════════════ */
db.query(`
  CREATE TABLE IF NOT EXISTS clientes_web (
    id                   SERIAL PRIMARY KEY,
    nome                 VARCHAR(200) NOT NULL,
    portfolio_foto       VARCHAR(500),
    portfolio_link       VARCHAR(300),
    portfolio_descricao  VARCHAR(200),
    portfolio_tipo       VARCHAR(50),
    exibir_portfolio     BOOLEAN DEFAULT false,
    exibir_sistemas      BOOLEAN DEFAULT false,
    criado_em            TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('[portfolio] auto-migration erro:', err.message));

/* ══════════════════════════════════════════════════════════════
   GET /api/portfolio
   Query params opcionais:
     ?tipo=Sistema Web   → filtra por portfolio_tipo
     ?limit=5            → limita quantidade de resultados
   Retorna somente registros com exibir_portfolio = true
   Ordem: mais recentes primeiro (id DESC)
══════════════════════════════════════════════════════════════ */
router.get('/portfolio', async (req, res) => {
  try {
    const { tipo, limit } = req.query;

    let sql    = 'SELECT * FROM clientes_web WHERE exibir_portfolio = true';
    const vals = [];

    if (tipo) {
      vals.push(tipo);
      sql += ' AND portfolio_tipo = $' + vals.length;
    }

    sql += ' ORDER BY id DESC';

    if (limit && !isNaN(Number(limit))) {
      vals.push(Number(limit));
      sql += ' LIMIT $' + vals.length;
    }

    const { rows } = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/portfolio]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar portfólio.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/portfolio — cadastra novo cliente
   Body: { nome, portfolio_foto, portfolio_link,
           portfolio_descricao, portfolio_tipo,
           exibir_portfolio, exibir_sistemas }
══════════════════════════════════════════════════════════════ */
router.post('/portfolio', async (req, res) => {
  try {
    const {
      nome,
      portfolio_foto       = '',
      portfolio_link       = '',
      portfolio_descricao  = '',
      portfolio_tipo       = '',
      exibir_portfolio     = false,
      exibir_sistemas      = false,
    } = req.body;

    if (!nome || !nome.trim()) {
      return res.status(400).json({ erro: 'Nome é obrigatório.' });
    }

    const { rows } = await db.query(
      `INSERT INTO clientes_web
         (nome, portfolio_foto, portfolio_link, portfolio_descricao,
          portfolio_tipo, exibir_portfolio, exibir_sistemas)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        nome.trim(),
        portfolio_foto,
        portfolio_link,
        portfolio_descricao,
        portfolio_tipo,
        Boolean(exibir_portfolio),
        Boolean(exibir_sistemas),
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/portfolio]', err.message);
    res.status(500).json({ erro: 'Erro ao cadastrar cliente.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   PUT /api/portfolio/:id — edita cliente existente
   Body: qualquer subconjunto dos campos acima
══════════════════════════════════════════════════════════════ */
router.put('/portfolio/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      nome,
      portfolio_foto,
      portfolio_link,
      portfolio_descricao,
      portfolio_tipo,
      exibir_portfolio,
      exibir_sistemas,
    } = req.body;

    const { rows } = await db.query(
      `UPDATE clientes_web SET
         nome                = COALESCE($1, nome),
         portfolio_foto      = COALESCE($2, portfolio_foto),
         portfolio_link      = COALESCE($3, portfolio_link),
         portfolio_descricao = COALESCE($4, portfolio_descricao),
         portfolio_tipo      = COALESCE($5, portfolio_tipo),
         exibir_portfolio    = COALESCE($6, exibir_portfolio),
         exibir_sistemas     = COALESCE($7, exibir_sistemas)
       WHERE id = $8
       RETURNING *`,
      [
        nome        ? nome.trim() : null,
        portfolio_foto       ?? null,
        portfolio_link       ?? null,
        portfolio_descricao  ?? null,
        portfolio_tipo       ?? null,
        exibir_portfolio != null ? Boolean(exibir_portfolio) : null,
        exibir_sistemas  != null ? Boolean(exibir_sistemas)  : null,
        id,
      ]
    );

    if (!rows.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT /api/portfolio/:id]', err.message);
    res.status(500).json({ erro: 'Erro ao editar cliente.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   DELETE /api/portfolio/:id — remove cliente
══════════════════════════════════════════════════════════════ */
router.delete('/portfolio/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rowCount } = await db.query('DELETE FROM clientes_web WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/portfolio/:id]', err.message);
    res.status(500).json({ erro: 'Erro ao remover cliente.' });
  }
});

module.exports = router;
