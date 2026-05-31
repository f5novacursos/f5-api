const express = require('express');
const router  = express.Router();
const db      = require('../db');

/* ── Auto-migration ─────────────────────────────────────────
   Cria tabela financeiro se não existir.
   tipo: 'receita' | 'despesa'
   categoria:
     Despesas:  ALIMENTAÇÃO | MARKETING | SALÁRIO | ALUGUEL | AULA | EXTRA | OUTRO
     Receitas:  Formatação | Design | Montagem e Manutenção | Aula Particular |
                Venda de Material | Conta Recebida Avulsa | Atrasados | Receita Extra
─────────────────────────────────────────────────────────── */
db.query(`
  CREATE TABLE IF NOT EXISTS financeiro (
    id          SERIAL PRIMARY KEY,
    tipo        VARCHAR(10)   NOT NULL CHECK (tipo IN ('receita','despesa')),
    categoria   VARCHAR(100)  NOT NULL DEFAULT '',
    descricao   VARCHAR(300)  NOT NULL DEFAULT '',
    valor       NUMERIC(10,2) NOT NULL DEFAULT 0,
    data        DATE          NOT NULL DEFAULT CURRENT_DATE,
    status      VARCHAR(20)   NOT NULL DEFAULT 'pago' CHECK (status IN ('pago','pendente')),
    obs         TEXT          DEFAULT '',
    criado_em   TIMESTAMP     DEFAULT NOW()
  )
`).catch(err => console.error('[financeiro] migration erro:', err.message));

/* ── GET /api/financeiro ─────────────────────────────────────
   Query params opcionais:
     ?tipo=receita|despesa
     ?mes=2026-01     (filtra por mês/ano da data)
     ?ano=2026        (filtra por ano)
─────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const { tipo, mes, ano } = req.query;
    const params = [];
    const where  = [];

    if (tipo) {
      params.push(tipo);
      where.push(`tipo = $${params.length}`);
    }
    if (mes) {
      // mes = '2026-01'
      params.push(mes + '-01');
      params.push(mes + '-31');
      where.push(`data BETWEEN $${params.length - 1} AND $${params.length}`);
    }
    if (ano) {
      params.push(ano);
      where.push(`EXTRACT(YEAR FROM data) = $${params.length}`);
    }

    const sql = `SELECT * FROM financeiro${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY data DESC, id DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ── GET /api/financeiro/resumo ──────────────────────────────
   Retorna KPIs do mês atual + histórico 6 meses + receita de matrículas
─────────────────────────────────────────────────────────── */
router.get('/resumo', async (req, res) => {
  try {
    const { mes } = req.query; // opcional: '2026-01'
    const refMes = mes || new Date().toISOString().slice(0, 7); // '2026-05'
    const [ano, m] = refMes.split('-');

    // KPIs do mês — lançamentos manuais (despesas + receitas avulsas)
    const { rows: lancMes } = await db.query(`
      SELECT tipo, categoria, SUM(valor) as total, COUNT(*) as qt
      FROM financeiro
      WHERE EXTRACT(YEAR FROM data) = $1 AND EXTRACT(MONTH FROM data) = $2
      GROUP BY tipo, categoria
    `, [ano, m]);

    // Receitas de matrículas do mês (alunos que pagaram neste mês)
    const { rows: matriculas } = await db.query(`
      SELECT COUNT(*) as qt, COALESCE(SUM(valor), 0) as total
      FROM alunos
      WHERE valor IS NOT NULL AND valor > 0
        AND EXTRACT(YEAR FROM pagamento) = $1
        AND EXTRACT(MONTH FROM pagamento) = $2
    `, [ano, m]);

    // MRR clientes web ativos
    const { rows: mrr } = await db.query(`
      SELECT COALESCE(SUM(mensalidade), 0) as mrr, COUNT(*) as qt
      FROM clientes_web WHERE status = 'ativo'
    `);

    // Inadimplência — alunos inadimplentes
    const { rows: inadimp } = await db.query(`
      SELECT COUNT(*) as qt, COALESCE(SUM(valor), 0) as total
      FROM alunos WHERE status = 'inadimplente'
    `);

    // Histórico últimos 6 meses
    const { rows: historico } = await db.query(`
      SELECT
        TO_CHAR(data, 'Mon') as mes,
        EXTRACT(YEAR FROM data) as ano,
        EXTRACT(MONTH FROM data) as mes_num,
        SUM(CASE WHEN tipo='receita' THEN valor ELSE 0 END) as rec,
        SUM(CASE WHEN tipo='despesa' THEN valor ELSE 0 END) as dep
      FROM financeiro
      WHERE data >= (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months')
      GROUP BY TO_CHAR(data, 'Mon'), EXTRACT(YEAR FROM data), EXTRACT(MONTH FROM data)
      ORDER BY ano, mes_num
    `);

    // Histórico de matrículas dos últimos 6 meses
    const { rows: histMatriculas } = await db.query(`
      SELECT
        TO_CHAR(pagamento, 'Mon') as mes,
        EXTRACT(YEAR FROM pagamento) as ano,
        EXTRACT(MONTH FROM pagamento) as mes_num,
        COALESCE(SUM(valor), 0) as rec
      FROM alunos
      WHERE valor IS NOT NULL AND valor > 0
        AND pagamento >= (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months')
      GROUP BY TO_CHAR(pagamento, 'Mon'), EXTRACT(YEAR FROM pagamento), EXTRACT(MONTH FROM pagamento)
      ORDER BY ano, mes_num
    `);

    // Lançamentos detalhados do mês (manual + matrículas)
    const { rows: lancDetalhes } = await db.query(`
      SELECT id, tipo, categoria, descricao, valor, data, status, obs
      FROM financeiro
      WHERE EXTRACT(YEAR FROM data) = $1 AND EXTRACT(MONTH FROM data) = $2
      ORDER BY data DESC
    `, [ano, m]);

    const { rows: alunosMes } = await db.query(`
      SELECT id, nome, curso, valor, pagamento, forma_pgto
      FROM alunos
      WHERE valor IS NOT NULL AND valor > 0
        AND EXTRACT(YEAR FROM pagamento) = $1
        AND EXTRACT(MONTH FROM pagamento) = $2
      ORDER BY pagamento DESC
    `, [ano, m]);

    // Soma receitas avulsas do mês
    const receitaAvulsa = lancMes
      .filter(l => l.tipo === 'receita')
      .reduce((s, l) => s + parseFloat(l.total), 0);

    const despesaTotal = lancMes
      .filter(l => l.tipo === 'despesa')
      .reduce((s, l) => s + parseFloat(l.total), 0);

    const receitaMatriculas = parseFloat(matriculas[0]?.total || 0);
    const receitaTotal = receitaMatriculas + receitaAvulsa;
    const saldo = receitaTotal - despesaTotal;

    res.json({
      mes: refMes,
      receita_matriculas: receitaMatriculas,
      receita_avulsa:     receitaAvulsa,
      receita_total:      receitaTotal,
      despesa_total:      despesaTotal,
      saldo,
      margem: receitaTotal ? Math.round((saldo / receitaTotal) * 100) : 0,
      qt_matriculas: parseInt(matriculas[0]?.qt || 0),
      mrr_clientes:  parseFloat(mrr[0]?.mrr || 0),
      qt_clientes_ativos: parseInt(mrr[0]?.qt || 0),
      inadimplencia: parseFloat(inadimp[0]?.total || 0),
      qt_inadimplentes: parseInt(inadimp[0]?.qt || 0),
      historico,
      hist_matriculas: histMatriculas,
      lancamentos: lancDetalhes,
      matriculas_mes: alunosMes,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ── POST /api/financeiro ────────────────────────────────────
   Body: { tipo, categoria, descricao, valor, data, status?, obs? }
─────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  try {
    const { tipo, categoria, descricao, valor, data, status = 'pago', obs = '' } = req.body;
    if (!tipo || !valor || !data) {
      return res.status(400).json({ erro: 'tipo, valor e data são obrigatórios' });
    }
    const { rows } = await db.query(`
      INSERT INTO financeiro (tipo, categoria, descricao, valor, data, status, obs)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [tipo, categoria || '', descricao || '', valor, data, status, obs]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ── PUT /api/financeiro/:id ─────────────────────────────────*/
router.put('/:id', async (req, res) => {
  try {
    const { tipo, categoria, descricao, valor, data, status, obs } = req.body;
    const { rows } = await db.query(`
      UPDATE financeiro SET
        tipo      = COALESCE($1, tipo),
        categoria = COALESCE($2, categoria),
        descricao = COALESCE($3, descricao),
        valor     = COALESCE($4, valor),
        data      = COALESCE($5, data),
        status    = COALESCE($6, status),
        obs       = COALESCE($7, obs)
      WHERE id = $8
      RETURNING *
    `, [tipo, categoria, descricao, valor, data, status, obs, req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ── DELETE /api/financeiro/:id ──────────────────────────────*/
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM financeiro WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Lançamento não encontrado' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
