const express = require('express');
const router  = express.Router();
const db      = require('../db');
const lixeira = require('../lib/lixeira');
const adminAuth = require('../middleware/adminAuth');

/* Auto-migration — cria tabela e adiciona colunas novas se não existirem */
db.query(`
  CREATE TABLE IF NOT EXISTS clientes_web (
    id                    SERIAL PRIMARY KEY,
    nome                  VARCHAR(200) NOT NULL,
    whatsapp              VARCHAR(20)  DEFAULT '',
    dominio               VARCHAR(200) DEFAULT '',
    plano                 VARCHAR(50)  DEFAULT '',
    periodicidade         VARCHAR(20)  DEFAULT 'mensal',
    setup_valor           NUMERIC(10,2) DEFAULT 0,
    mensalidade           NUMERIC(10,2) DEFAULT 0,
    data_inicio           DATE,
    data_primeira_cobranca DATE,
    proximo_vencimento    DATE,
    status_pgto           VARCHAR(20)  DEFAULT 'pago',
    status                VARCHAR(20)  DEFAULT 'ativo',
    obs                   TEXT         DEFAULT '',
    exibir_portfolio      BOOLEAN      DEFAULT false,
    exibir_sistemas       BOOLEAN      DEFAULT false,
    portfolio_foto        VARCHAR(500) DEFAULT '',
    portfolio_link        VARCHAR(300) DEFAULT '',
    portfolio_tipo        VARCHAR(50)  DEFAULT '',
    portfolio_descricao   VARCHAR(200) DEFAULT '',
    criado_em             TIMESTAMP    DEFAULT NOW()
  )
`).catch(err => console.error('[clientes-web] migration erro:', err.message));

/* Adiciona coluna vencimento_dominio se não existir (migração incremental) */
db.query(`ALTER TABLE clientes_web ADD COLUMN IF NOT EXISTS vencimento_dominio DATE`)
  .catch(err => console.error('[clientes-web] migration vencimento_dominio:', err.message));

/* GET /api/clientes-web */
router.get('/clientes-web', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clientes_web ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* POST /api/clientes-web */
router.post('/clientes-web', adminAuth, async (req, res) => {
  try {
    const {
      nome, whatsapp='', dominio='', plano='', periodicidade='mensal',
      setup_valor=0, mensalidade=0, data_inicio=null, data_primeira_cobranca=null,
      proximo_vencimento=null, status_pgto='pago', status='ativo', obs='',
      exibir_portfolio=false, exibir_sistemas=false,
      portfolio_foto='', portfolio_link='', portfolio_tipo='', portfolio_descricao='',
      vencimento_dominio=null,
    } = req.body;

    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório.' });

    const { rows } = await db.query(
      `INSERT INTO clientes_web
        (nome,whatsapp,dominio,plano,periodicidade,setup_valor,mensalidade,
         data_inicio,data_primeira_cobranca,proximo_vencimento,
         status_pgto,status,obs,exibir_portfolio,exibir_sistemas,
         portfolio_foto,portfolio_link,portfolio_tipo,portfolio_descricao,
         vencimento_dominio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [nome.trim(),whatsapp,dominio,plano,periodicidade,setup_valor,mensalidade,
       data_inicio||null,data_primeira_cobranca||null,proximo_vencimento||null,
       status_pgto,status,obs,Boolean(exibir_portfolio),Boolean(exibir_sistemas),
       portfolio_foto,portfolio_link,portfolio_tipo,portfolio_descricao,
       vencimento_dominio||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* PUT /api/clientes-web/:id */
router.put('/clientes-web/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      nome, whatsapp, dominio, plano, periodicidade,
      setup_valor, mensalidade, data_inicio, data_primeira_cobranca,
      proximo_vencimento, status_pgto, status, obs,
      exibir_portfolio, exibir_sistemas,
      portfolio_foto, portfolio_link, portfolio_tipo, portfolio_descricao,
      vencimento_dominio,
    } = req.body;

    const { rows } = await db.query(
      `UPDATE clientes_web SET
        nome                  = COALESCE($1,  nome),
        whatsapp              = COALESCE($2,  whatsapp),
        dominio               = COALESCE($3,  dominio),
        plano                 = COALESCE($4,  plano),
        periodicidade         = COALESCE($5,  periodicidade),
        setup_valor           = COALESCE($6,  setup_valor),
        mensalidade           = COALESCE($7,  mensalidade),
        data_inicio           = COALESCE($8,  data_inicio),
        data_primeira_cobranca= COALESCE($9,  data_primeira_cobranca),
        proximo_vencimento    = COALESCE($10, proximo_vencimento),
        status_pgto           = COALESCE($11, status_pgto),
        status                = COALESCE($12, status),
        obs                   = COALESCE($13, obs),
        exibir_portfolio      = COALESCE($14, exibir_portfolio),
        exibir_sistemas       = COALESCE($15, exibir_sistemas),
        portfolio_foto        = COALESCE($16, portfolio_foto),
        portfolio_link        = COALESCE($17, portfolio_link),
        portfolio_tipo        = COALESCE($18, portfolio_tipo),
        portfolio_descricao   = COALESCE($19, portfolio_descricao),
        vencimento_dominio    = COALESCE($20, vencimento_dominio)
      WHERE id = $21 RETURNING *`,
      [
        nome?.trim()??null, whatsapp??null, dominio??null, plano??null,
        periodicidade??null, setup_valor??null, mensalidade??null,
        data_inicio||null, data_primeira_cobranca||null, proximo_vencimento||null,
        status_pgto??null, status??null, obs??null,
        exibir_portfolio!=null ? Boolean(exibir_portfolio) : null,
        exibir_sistemas!=null  ? Boolean(exibir_sistemas)  : null,
        portfolio_foto??null, portfolio_link??null,
        portfolio_tipo??null, portfolio_descricao??null,
        vencimento_dominio||null,
        id,
      ]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* DELETE /api/clientes-web/:id — manda o cliente web pra Lixeira */
router.delete('/clientes-web/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM clientes_web WHERE id = $1 RETURNING *', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const c = rows[0];
    await lixeira.guardar({
      entidade: 'cliente_web', ref_id: c.id, por: req,
      rotulo: `Cliente web ${c.nome || c.empresa || ''}`.trim(),
      dados: c,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
