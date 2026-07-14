const express = require('express');
const router  = express.Router();
const db      = require('../db');
const lixeira = require('../lib/lixeira');

/* ── Auto-migration ──────────────────────────────────────── */
db.query(`
  CREATE TABLE IF NOT EXISTS financeiro (
    id          SERIAL PRIMARY KEY,
    tipo        VARCHAR(10)   NOT NULL CHECK (tipo IN ('receita','despesa')),
    categoria   VARCHAR(100)  NOT NULL DEFAULT '',
    cliente     VARCHAR(200)  NOT NULL DEFAULT '',
    descricao   VARCHAR(300)  NOT NULL DEFAULT '',
    valor       NUMERIC(10,2) NOT NULL DEFAULT 0,
    data        DATE          NOT NULL DEFAULT CURRENT_DATE,
    status      VARCHAR(20)   NOT NULL DEFAULT 'pago' CHECK (status IN ('pago','pendente')),
    obs         TEXT          DEFAULT '',
    criado_em   TIMESTAMP     DEFAULT NOW()
  )
`).catch(err => console.error('[financeiro] create erro:', err.message));

db.query(`ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS cliente VARCHAR(200) NOT NULL DEFAULT ''`)
  .catch(() => {});
db.query(`ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS recibo_url VARCHAR(600) DEFAULT ''`)
  .catch(() => {});
/* Despesas recorrentes — templates mensais */
db.query(`ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS recorrente BOOLEAN DEFAULT false`)
  .catch(() => {});
/* Tabela separada para templates recorrentes */
db.query(`
  CREATE TABLE IF NOT EXISTS financeiro_recorrente (
    id          SERIAL PRIMARY KEY,
    categoria   VARCHAR(100) NOT NULL DEFAULT '',
    descricao   VARCHAR(300) NOT NULL DEFAULT '',
    valor       NUMERIC(10,2) NOT NULL DEFAULT 0,
    dia_venc    INTEGER DEFAULT 10,
    ativo       BOOLEAN DEFAULT true,
    criado_em   TIMESTAMP DEFAULT NOW()
  )
`).catch(() => {});

/* ── GET /api/financeiro ─────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const { tipo, mes, ano } = req.query;
    const params = [];
    const where  = ['(recorrente IS NULL OR recorrente = false)'];
    if (tipo) { params.push(tipo); where.push(`tipo = $${params.length}`); }
    if (mes)  {
      params.push(mes + '-01');
      where.push(`DATE_TRUNC('month', data) = DATE_TRUNC('month', $${params.length}::date)`);
    }
    if (ano)  { params.push(ano); where.push(`EXTRACT(YEAR FROM data) = $${params.length}`); }
    const sql = `SELECT * FROM financeiro WHERE ${where.join(' AND ')} ORDER BY data DESC, id DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── GET /api/financeiro/recorrentes — lista templates ─────── */
router.get('/recorrentes', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM financeiro_recorrente WHERE ativo=true ORDER BY id ASC'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── POST /api/financeiro/recorrentes — cria template ──────── */
router.post('/recorrentes', async (req, res) => {
  try {
    const { categoria='', descricao='', valor, dia_venc=10 } = req.body;
    if (!valor) return res.status(400).json({ erro: 'valor obrigatório' });
    const { rows } = await db.query(
      `INSERT INTO financeiro_recorrente (categoria, descricao, valor, dia_venc)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [categoria, descricao, valor, dia_venc]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── DELETE /api/financeiro/recorrentes/:id — remove template ─ */
router.delete('/recorrentes/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'UPDATE financeiro_recorrente SET ativo=false WHERE id=$1 AND ativo=true RETURNING *',
      [req.params.id]
    );
    if (rows.length) {
      const r = rows[0];
      await lixeira.guardar({
        entidade: 'financeiro_recorrente', ref_id: r.id, por: req,
        rotulo: `Despesa recorrente ${r.descricao || r.categoria || ''}`.trim(),
        dados: r,
      });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── POST /api/financeiro/recorrentes/:id/pagar — paga um mês ─ */
router.post('/recorrentes/:id/pagar', async (req, res) => {
  try {
    const { mes } = req.body; // 'YYYY-MM'
    const { rows: rec } = await db.query(
      'SELECT * FROM financeiro_recorrente WHERE id=$1', [req.params.id]
    );
    if (!rec.length) return res.status(404).json({ erro: 'Recorrente não encontrado' });
    const r = rec[0];
    const data = mes ? `${mes}-${String(r.dia_venc).padStart(2,'0')}` : new Date().toISOString().split('T')[0];
    const { rows } = await db.query(
      `INSERT INTO financeiro (tipo, categoria, descricao, valor, data, status, obs)
       VALUES ('despesa',$1,$2,$3,$4,'pago','Pago via recorrente') RETURNING *`,
      [r.categoria, r.descricao, r.valor, data]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── GET /api/financeiro/resumo ──────────────────────────── */
router.get('/resumo', async (req, res) => {
  try {
    const { mes } = req.query;
    const refMes = mes || new Date().toISOString().slice(0, 7);
    const [ano, m] = refMes.split('-');

    const { rows: lancMes } = await db.query(`
      SELECT tipo, categoria, SUM(valor) as total, COUNT(*) as qt
      FROM financeiro
      WHERE EXTRACT(YEAR FROM data)=$1 AND EXTRACT(MONTH FROM data)=$2
        AND (recorrente IS NULL OR recorrente = false)
      GROUP BY tipo, categoria
    `, [ano, m]);

    const { rows: matriculas } = await db.query(`
      SELECT COUNT(*) as qt, COALESCE(SUM(valor),0) as total
      FROM alunos
      WHERE valor IS NOT NULL AND valor>0
        AND EXTRACT(YEAR FROM pagamento)=$1 AND EXTRACT(MONTH FROM pagamento)=$2
    `, [ano, m]);

    /* MRR: só conta cliente que já tinha contrato iniciado até o fim do mês
       consultado — evita que cliente novo infle o MRR de meses passados.
       ⚠️ Limite conhecido: não existe data de cancelamento na tabela, então
       um cliente que já saiu ainda conta pra MRR de meses em que estava ativo
       mas também (incorretamente) pra depois, até virar status != 'ativo'. */
    const { rows: mrr } = await db.query(`
      SELECT COALESCE(SUM(mensalidade),0) as mrr, COUNT(*) as qt
      FROM clientes_web
      WHERE status='ativo' AND (periodicidade IS NULL OR periodicidade != 'avulso')
        AND (data_inicio IS NULL OR data_inicio <= (DATE_TRUNC('month', $1::date) + INTERVAL '1 month' - INTERVAL '1 day'))
    `, [refMes + '-01']);

    /* Lista de quem compõe o MRR, pro relatório mostrar de onde vem o
       dinheiro (mesmo critério de data da query acima) — não só o total. */
    const { rows: clientesMrr } = await db.query(`
      SELECT id, nome, plano, mensalidade
      FROM clientes_web
      WHERE status='ativo' AND (periodicidade IS NULL OR periodicidade != 'avulso')
        AND (data_inicio IS NULL OR data_inicio <= (DATE_TRUNC('month', $1::date) + INTERVAL '1 month' - INTERVAL '1 day'))
      ORDER BY mensalidade DESC
    `, [refMes + '-01']);

    /* Inadimplência: antes só contava quem tinha status='inadimplente' (flag
       manual), ignorando aluno com status_pagamento 'pendente' ou 'parcial'
       (que tem valor_restante). Agora soma o que falta receber de verdade:
       parcial → valor_restante; pendente ou inadimplente → valor cheio. */
    const { rows: inadimp } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE devendo > 0) as qt, COALESCE(SUM(devendo),0) as total
      FROM (
        SELECT CASE
          WHEN status_pagamento = 'parcial' THEN
            COALESCE(NULLIF(regexp_replace(REPLACE(valor_restante::text, ',', '.'), '[^0-9.]', '', 'g'), '')::numeric, 0)
          WHEN status_pagamento = 'pendente' OR status = 'inadimplente' THEN
            COALESCE(valor, 0)
          ELSE 0
        END as devendo
        FROM alunos
      ) t
    `);

    const { rows: historico } = await db.query(`
      SELECT TO_CHAR(data,'Mon') as mes,
             EXTRACT(YEAR FROM data) as ano,
             EXTRACT(MONTH FROM data) as mes_num,
             SUM(CASE WHEN tipo='receita' THEN valor ELSE 0 END) as rec,
             SUM(CASE WHEN tipo='despesa' THEN valor ELSE 0 END) as dep
      FROM financeiro
      WHERE data >= (DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '5 months')
        AND (recorrente IS NULL OR recorrente = false)
      GROUP BY TO_CHAR(data,'Mon'), EXTRACT(YEAR FROM data), EXTRACT(MONTH FROM data)
      ORDER BY ano, mes_num
    `);

    const { rows: histMatriculas } = await db.query(`
      SELECT TO_CHAR(pagamento,'Mon') as mes,
             EXTRACT(YEAR FROM pagamento) as ano,
             EXTRACT(MONTH FROM pagamento) as mes_num,
             COALESCE(SUM(valor),0) as rec
      FROM alunos
      WHERE valor IS NOT NULL AND valor>0
        AND pagamento >= (DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '5 months')
      GROUP BY TO_CHAR(pagamento,'Mon'), EXTRACT(YEAR FROM pagamento), EXTRACT(MONTH FROM pagamento)
      ORDER BY ano, mes_num
    `);

    const { rows: lancDetalhes } = await db.query(`
      SELECT id, tipo, categoria, cliente, descricao, valor, data, status, obs
      FROM financeiro
      WHERE EXTRACT(YEAR FROM data)=$1 AND EXTRACT(MONTH FROM data)=$2
        AND (recorrente IS NULL OR recorrente = false)
      ORDER BY data DESC
    `, [ano, m]);

    const { rows: alunosMes } = await db.query(`
      SELECT id, nome, curso, valor, pagamento, forma_pgto
      FROM alunos
      WHERE valor IS NOT NULL AND valor>0
        AND EXTRACT(YEAR FROM pagamento)=$1 AND EXTRACT(MONTH FROM pagamento)=$2
      ORDER BY pagamento DESC
    `, [ano, m]);

    const { rows: totaisAno } = await db.query(`
      SELECT tipo, COALESCE(SUM(valor),0) as total
      FROM financeiro
      WHERE EXTRACT(YEAR FROM data)=$1
        AND (recorrente IS NULL OR recorrente = false)
      GROUP BY tipo
    `, [ano]);

    const { rows: totalMatriculasAno } = await db.query(`
      SELECT COALESCE(SUM(valor),0) as total
      FROM alunos
      WHERE valor IS NOT NULL AND valor>0 AND EXTRACT(YEAR FROM pagamento)=$1
    `, [ano]);

    /* Recorrentes: lista todos + marca quais já foram pagos este mês */
    const { rows: recTemplates } = await db.query(
      'SELECT * FROM financeiro_recorrente WHERE ativo=true ORDER BY id ASC'
    );
    const { rows: recPagos } = await db.query(`
      SELECT descricao FROM financeiro
      WHERE tipo='despesa' AND status='pago'
        AND EXTRACT(YEAR FROM data)=$1 AND EXTRACT(MONTH FROM data)=$2
        AND obs='Pago via recorrente'
    `, [ano, m]);
    const descPagos = new Set(recPagos.map(r => r.descricao));
    const recorrentes = recTemplates.map(r => ({
      ...r,
      pago_mes: descPagos.has(r.descricao),
    }));

    const receitaAvulsa    = lancMes.filter(l=>l.tipo==='receita').reduce((s,l)=>s+parseFloat(l.total),0);
    const despesaTotal     = lancMes.filter(l=>l.tipo==='despesa').reduce((s,l)=>s+parseFloat(l.total),0);
    const receitaMatriculas = parseFloat(matriculas[0]?.total||0);
    const mrrWeb           = parseFloat(mrr[0]?.mrr||0);
    const receitaTotal     = receitaMatriculas + receitaAvulsa + mrrWeb;
    const saldo            = receitaTotal - despesaTotal;

    const anoRecAvulsa  = totaisAno.find(t=>t.tipo==='receita') ? parseFloat(totaisAno.find(t=>t.tipo==='receita').total) : 0;
    const anoDesp       = totaisAno.find(t=>t.tipo==='despesa') ? parseFloat(totaisAno.find(t=>t.tipo==='despesa').total) : 0;
    const anoMatriculas = parseFloat(totalMatriculasAno[0]?.total||0);

    res.json({
      mes: refMes,
      receita_matriculas: receitaMatriculas,
      receita_avulsa:     receitaAvulsa,
      receita_web_mrr:    mrrWeb,
      receita_total:      receitaTotal,
      despesa_total:      despesaTotal,
      saldo,
      margem: receitaTotal ? Math.round((saldo/receitaTotal)*100) : 0,
      qt_matriculas:      parseInt(matriculas[0]?.qt||0),
      mrr_clientes:       mrrWeb,
      qt_clientes_ativos: parseInt(mrr[0]?.qt||0),
      inadimplencia:      parseFloat(inadimp[0]?.total||0),
      qt_inadimplentes:   parseInt(inadimp[0]?.qt||0),
      ano_receita_matriculas: anoMatriculas,
      ano_receita_avulsa:     anoRecAvulsa,
      ano_despesa:            anoDesp,
      historico,
      hist_matriculas:    histMatriculas,
      lancamentos:        lancDetalhes,
      matriculas_mes:     alunosMes,
      clientes_mrr:       clientesMrr,
      recorrentes,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── POST /api/financeiro ────────────────────────────────── */
router.post('/', async (req, res) => {
  try {
    const { tipo, categoria, cliente='', descricao='', valor, data, status='pago', obs='', recibo_url='' } = req.body;
    if (!tipo || !valor || !data) return res.status(400).json({ erro: 'tipo, valor e data são obrigatórios' });
    const { rows } = await db.query(`
      INSERT INTO financeiro (tipo, categoria, cliente, descricao, valor, data, status, obs, recibo_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [tipo, categoria||'', cliente, descricao, valor, data, status, obs, recibo_url]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── GET /api/financeiro/:id ─────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM financeiro WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── PUT /api/financeiro/:id ─────────────────────────────── */
router.put('/:id', async (req, res) => {
  try {
    const { tipo, categoria, cliente, descricao, valor, data, status, obs } = req.body;
    const { rows } = await db.query(`
      UPDATE financeiro SET
        tipo      = COALESCE($1,tipo),
        categoria = COALESCE($2,categoria),
        cliente   = COALESCE($3,cliente),
        descricao = COALESCE($4,descricao),
        valor     = COALESCE($5,valor),
        data      = COALESCE($6,data),
        status    = COALESCE($7,status),
        obs       = COALESCE($8,obs)
      WHERE id=$9 RETURNING *
    `, [tipo, categoria, cliente, descricao, valor, data, status, obs, req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/* ── DELETE /api/financeiro/:id ──────────────────────────── */
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM financeiro WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Não encontrado' });
    const f = rows[0];
    await lixeira.guardar({
      entidade: 'financeiro', ref_id: f.id, por: req,
      rotulo: `${f.tipo === 'receita' ? 'Receita' : 'Despesa'} ${f.descricao || f.categoria || ''}`.trim(),
      dados: f,
    });
    res.json({ ok: true, id: f.id });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
