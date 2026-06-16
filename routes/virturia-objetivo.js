// ══════════════════════════════════════════════════════════════════
// routes/virturia-objetivo.js — Gestor Inteligente de Banca VirtuIA
// Rotas: GET/POST /api/virturia/objetivo/...
// ══════════════════════════════════════════════════════════════════
const router  = require('express').Router();
const db      = require('../db');
const jwt     = require('jsonwebtoken');

const JWT_SECRET = process.env.VIRTURIA_JWT_SECRET || process.env.VIRTURIA_CHAVE || 'virturia2026secret';

// ── Auth middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Token ausente' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch(e) { return res.status(401).json({ error: 'Token inválido' }); }
}

// ── Criação das tabelas ──────────────────────────────────────────
async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_objetivo_plano (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      provedor     VARCHAR(10) NOT NULL,
      banca_inicio DECIMAL(10,2) NOT NULL,
      meta_total   DECIMAL(10,2) NOT NULL,
      prazo_dias   INTEGER NOT NULL DEFAULT 7,
      sessoes_dia  INTEGER NOT NULL DEFAULT 3,
      ativo        BOOLEAN DEFAULT true,
      criado_em    TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, provedor)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_objetivo_dia (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      provedor     VARCHAR(10) NOT NULL,
      data         DATE NOT NULL,
      banca_inicio DECIMAL(10,2) NOT NULL,
      banca_fim    DECIMAL(10,2),
      lucro        DECIMAL(10,2) DEFAULT 0,
      fechado      BOOLEAN DEFAULT false,
      UNIQUE(user_id, provedor, data)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_objetivo_entrada (
      id        SERIAL PRIMARY KEY,
      user_id   INTEGER NOT NULL,
      provedor  VARCHAR(10) NOT NULL,
      data      DATE NOT NULL,
      sessao    INTEGER NOT NULL DEFAULT 1,
      odd       DECIMAL(6,2),
      stake     DECIMAL(10,2) NOT NULL,
      resultado VARCHAR(5) NOT NULL,
      lucro     DECIMAL(10,2) NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);
}
initTables().catch(e => console.error('[objetivo] init error:', e.message));

// ── Helper: data de hoje no fuso BRT ────────────────────────────
function hoje() {
  const d = new Date();
  d.setHours(d.getHours() - 3); // UTC → BRT
  return d.toISOString().slice(0, 10);
}

// ── Helper: gera mensagem inteligente ───────────────────────────
function mensagemInteligente(ctx) {
  const {
    lucroHoje, metaHoje, metaTotal, lucroTotal,
    entradas, ultimoDiaFoiRed, sessaoAtual, sessoesTotal, metaSessao
  } = ctx;

  const faltaTotal = Math.max(0, metaTotal - lucroTotal);
  const faltaHoje  = Math.max(0, metaHoje  - lucroHoje);
  const pctTotal   = metaTotal > 0 ? (lucroTotal / metaTotal) * 100 : 0;

  // Sequência de reds
  const ultimas = entradas.slice(-3);
  const reds    = ultimas.filter(e => e.resultado === 'red').length;
  const ultimo  = ultimas[ultimas.length - 1];

  // 1. Stop loss — 2+ reds seguidos
  if (ultimas.length >= 2 &&
      ultimas[ultimas.length-1]?.resultado === 'red' &&
      ultimas[ultimas.length-2]?.resultado === 'red') {
    return {
      nivel: 'danger',
      emoji: '🛑',
      titulo: 'PARA AGORA!',
      texto: '2 reds seguidos. Encerre essa sessão. Respira, toma água, volta na próxima.'
    };
  }

  // 2. Meta total batida
  if (lucroTotal >= metaTotal && metaTotal > 0) {
    return {
      nivel: 'success',
      emoji: '🏆',
      titulo: 'META TOTAL BATIDA!',
      texto: `Você alcançou sua meta de R$${metaTotal.toFixed(2)}! Saque o lucro e comemore.`
    };
  }

  // 3. Meta do dia batida
  if (lucroHoje >= metaHoje && metaHoje > 0) {
    return {
      nivel: 'success',
      emoji: '✅',
      titulo: 'META DO DIA BATIDA!',
      texto: `Ótimo trabalho! Faltam apenas R$${faltaTotal.toFixed(2)} para sua meta total. Para por hoje.`
    };
  }

  // 4. Perto da meta total (menos de 20% restando)
  if (pctTotal >= 80 && metaTotal > 0) {
    return {
      nivel: 'warning',
      emoji: '🎯',
      titulo: `Faltam R$${faltaTotal.toFixed(2)} para sua meta!`,
      texto: `Você está a ${(100 - pctTotal).toFixed(0)}% de completar o plano. Não arrisque mais do que R$${(faltaTotal * 0.5).toFixed(2)} agora.`
    };
  }

  // 5. Dia anterior foi ruim
  if (ultimoDiaFoiRed) {
    return {
      nivel: 'info',
      emoji: '💪',
      titulo: 'Cabeça fria hoje!',
      texto: `Ontem foi difícil, mas faz parte. Hoje começa do zero. Foca nas sessões — R$${metaSessao.toFixed(2)} por sessão, sem pressão.`
    };
  }

  // 6. Sessão atual concluída
  if (lucroHoje >= metaSessao * sessaoAtual) {
    const proxSessao = sessaoAtual < sessoesTotal
      ? ['tarde', 'noite', 'encerrado'][sessaoAtual]
      : null;
    return {
      nivel: 'info',
      emoji: '☕',
      titulo: `Sessão ${['manhã','tarde','noite'][sessaoAtual-1]} concluída!`,
      texto: proxSessao
        ? `Descanse agora. Próxima sessão: ${proxSessao}. Meta restante: R$${faltaHoje.toFixed(2)}.`
        : 'Todas as sessões do dia concluídas! Ótimo trabalho.'
    };
  }

  // 7. Normal — orienta a sessão
  const sessaoNome = ['manhã','tarde','noite'][sessaoAtual - 1] || 'atual';
  return {
    nivel: 'normal',
    emoji: '📊',
    titulo: `Sessão da ${sessaoNome}`,
    texto: `Meta dessa sessão: R$${metaSessao.toFixed(2)}. Falta R$${faltaHoje.toFixed(2)} pra fechar o dia. Calma e foco.`
  };
}

// ── GET /objetivo/status ─────────────────────────────────────────
router.get('/objetivo/status', auth, async (req, res) => {
  try {
    const uid  = req.user.id;
    const prov = req.query.provedor || 'betano';
    const hj   = hoje();

    // Plano ativo
    const { rows: [plano] } = await db.query(
      `SELECT * FROM virturia_objetivo_plano WHERE user_id=$1 AND provedor=$2 AND ativo=true`,
      [uid, prov]
    );

    if (!plano) return res.json({ ok: true, plano: null, status: null });

    // Dia de hoje
    let { rows: [dia] } = await db.query(
      `SELECT * FROM virturia_objetivo_dia WHERE user_id=$1 AND provedor=$2 AND data=$3`,
      [uid, prov, hj]
    );

    // Se não tem registro de hoje, cria automaticamente
    if (!dia) {
      // Pega banca_fim do dia anterior
      const { rows: [anterior] } = await db.query(
        `SELECT banca_fim FROM virturia_objetivo_dia
         WHERE user_id=$1 AND provedor=$2 AND data < $3 AND banca_fim IS NOT NULL
         ORDER BY data DESC LIMIT 1`,
        [uid, prov, hj]
      );
      const bancaInicio = anterior ? parseFloat(anterior.banca_fim) : parseFloat(plano.banca_inicio);
      await db.query(
        `INSERT INTO virturia_objetivo_dia (user_id, provedor, data, banca_inicio)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [uid, prov, hj, bancaInicio]
      );
      const { rows: [novo] } = await db.query(
        `SELECT * FROM virturia_objetivo_dia WHERE user_id=$1 AND provedor=$2 AND data=$3`,
        [uid, prov, hj]
      );
      dia = novo;
    }

    // Entradas de hoje
    const { rows: entradas } = await db.query(
      `SELECT * FROM virturia_objetivo_entrada
       WHERE user_id=$1 AND provedor=$2 AND data=$3 ORDER BY criado_em ASC`,
      [uid, prov, hj]
    );

    // Lucro de hoje calculado das entradas
    const lucroHoje = entradas.reduce((s, e) => s + parseFloat(e.lucro), 0);

    // Lucro total do plano (soma de todos os dias)
    const { rows: [totRow] } = await db.query(
      `SELECT COALESCE(SUM(banca_fim - banca_inicio), 0) AS lucro_total
       FROM virturia_objetivo_dia
       WHERE user_id=$1 AND provedor=$2 AND fechado=true`,
      [uid, prov]
    );
    const lucroTotal = parseFloat(totRow.lucro_total) + lucroHoje;

    // Dia anterior foi vermelho?
    const { rows: [diaAnt] } = await db.query(
      `SELECT lucro FROM virturia_objetivo_dia
       WHERE user_id=$1 AND provedor=$2 AND data < $3 AND fechado=true
       ORDER BY data DESC LIMIT 1`,
      [uid, prov, hj]
    );
    const ultimoDiaFoiRed = diaAnt ? parseFloat(diaAnt.lucro) < 0 : false;

    // Cálculos
    const prazo      = plano.prazo_dias;
    const sessoesDia = plano.sessoes_dia;
    const metaTotal  = parseFloat(plano.meta_total);
    const metaHoje   = metaTotal / prazo;
    const metaSessao = metaHoje / sessoesDia;

    // Sessão atual baseada em hora BRT
    const horaBRT   = new Date(Date.now() - 3 * 3600000).getUTCHours();
    const sessaoAtual = horaBRT < 12 ? 1 : horaBRT < 18 ? 2 : 3;

    const msg = mensagemInteligente({
      lucroHoje, metaHoje, metaTotal, lucroTotal,
      entradas, ultimoDiaFoiRed, sessaoAtual,
      sessoesTotal: sessoesDia, metaSessao
    });

    // Histórico resumido (últimos 7 dias)
    const { rows: historico } = await db.query(
      `SELECT data, banca_inicio, banca_fim, lucro, fechado
       FROM virturia_objetivo_dia
       WHERE user_id=$1 AND provedor=$2
       ORDER BY data DESC LIMIT 30`,
      [uid, prov]
    );

    res.json({
      ok: true,
      plano: {
        banca_inicio: parseFloat(plano.banca_inicio),
        meta_total:   metaTotal,
        prazo_dias:   prazo,
        sessoes_dia:  sessoesDia,
      },
      hoje: {
        data:          hj,
        banca_inicio:  parseFloat(dia.banca_inicio),
        banca_atual:   parseFloat(dia.banca_inicio) + lucroHoje,
        lucro_hoje:    lucroHoje,
        meta_hoje:     metaHoje,
        meta_sessao:   metaSessao,
        sessao_atual:  sessaoAtual,
        entradas,
      },
      total: {
        lucro:     lucroTotal,
        meta:      metaTotal,
        pct:       metaTotal > 0 ? (lucroTotal / metaTotal) * 100 : 0,
        falta:     Math.max(0, metaTotal - lucroTotal),
      },
      mensagem: msg,
      historico,
    });
  } catch(e) {
    console.error('[objetivo/status]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /objetivo/plano ─────────────────────────────────────────
router.post('/objetivo/plano', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { provedor = 'betano', banca_inicio, meta_total, prazo_dias, sessoes_dia = 3 } = req.body;
    if (!banca_inicio || !meta_total || !prazo_dias)
      return res.status(400).json({ error: 'banca_inicio, meta_total e prazo_dias são obrigatórios' });

    await db.query(`
      INSERT INTO virturia_objetivo_plano (user_id, provedor, banca_inicio, meta_total, prazo_dias, sessoes_dia, ativo)
      VALUES ($1,$2,$3,$4,$5,$6,true)
      ON CONFLICT (user_id, provedor) DO UPDATE SET
        banca_inicio=$3, meta_total=$4, prazo_dias=$5, sessoes_dia=$6, ativo=true, criado_em=NOW()
    `, [uid, provedor, banca_inicio, meta_total, prazo_dias, sessoes_dia]);

    // Cria o registro do dia de hoje automaticamente
    const hj = hoje();
    await db.query(`
      INSERT INTO virturia_objetivo_dia (user_id, provedor, data, banca_inicio)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
    `, [uid, provedor, hj, banca_inicio]);

    res.json({ ok: true });
  } catch(e) {
    console.error('[objetivo/plano]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /objetivo/entrada ───────────────────────────────────────
router.post('/objetivo/entrada', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { provedor = 'betano', sessao = 1, odd, stake, resultado } = req.body;
    if (!stake || !resultado) return res.status(400).json({ error: 'stake e resultado são obrigatórios' });

    const lucro = resultado === 'green'
      ? +(stake * ((odd || 1) - 1)).toFixed(2)
      : -(+stake);

    const hj = hoje();
    await db.query(`
      INSERT INTO virturia_objetivo_entrada (user_id, provedor, data, sessao, odd, stake, resultado, lucro)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [uid, provedor, hj, sessao, odd || null, stake, resultado, lucro]);

    // Atualiza lucro do dia
    await db.query(`
      UPDATE virturia_objetivo_dia
      SET lucro = (
        SELECT COALESCE(SUM(lucro),0) FROM virturia_objetivo_entrada
        WHERE user_id=$1 AND provedor=$2 AND data=$3
      ),
      banca_fim = banca_inicio + (
        SELECT COALESCE(SUM(lucro),0) FROM virturia_objetivo_entrada
        WHERE user_id=$1 AND provedor=$2 AND data=$3
      )
      WHERE user_id=$1 AND provedor=$2 AND data=$3
    `, [uid, provedor, hj]);

    res.json({ ok: true, lucro });
  } catch(e) {
    console.error('[objetivo/entrada]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /objetivo/entrada/:id ─────────────────────────────────
router.delete('/objetivo/entrada/:id', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { id } = req.params;
    const hj = hoje();

    const { rows: [e] } = await db.query(
      `SELECT * FROM virturia_objetivo_entrada WHERE id=$1 AND user_id=$2`,
      [id, uid]
    );
    if (!e) return res.status(404).json({ error: 'Entrada não encontrada' });

    await db.query(`DELETE FROM virturia_objetivo_entrada WHERE id=$1`, [id]);

    // Recalcula lucro do dia
    await db.query(`
      UPDATE virturia_objetivo_dia
      SET lucro = (
        SELECT COALESCE(SUM(lucro),0) FROM virturia_objetivo_entrada
        WHERE user_id=$1 AND provedor=$2 AND data=$3
      ),
      banca_fim = banca_inicio + (
        SELECT COALESCE(SUM(lucro),0) FROM virturia_objetivo_entrada
        WHERE user_id=$1 AND provedor=$2 AND data=$3
      )
      WHERE user_id=$1 AND provedor=$2 AND data=$3
    `, [uid, e.provedor, e.data]);

    res.json({ ok: true });
  } catch(e) {
    console.error('[objetivo/entrada DELETE]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /objetivo/fechar-dia ────────────────────────────────────
router.post('/objetivo/fechar-dia', auth, async (req, res) => {
  try {
    const uid  = req.user.id;
    const prov = req.body.provedor || 'betano';
    const hj   = hoje();

    await db.query(`
      UPDATE virturia_objetivo_dia SET fechado=true
      WHERE user_id=$1 AND provedor=$2 AND data=$3
    `, [uid, prov, hj]);

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /objetivo/historico ──────────────────────────────────────
router.get('/objetivo/historico', auth, async (req, res) => {
  try {
    const uid  = req.user.id;
    const prov = req.query.provedor || 'betano';

    const { rows } = await db.query(`
      SELECT d.data, d.banca_inicio, d.banca_fim, d.lucro, d.fechado,
        (SELECT COUNT(*) FROM virturia_objetivo_entrada e
         WHERE e.user_id=d.user_id AND e.provedor=d.provedor AND e.data=d.data) AS total_entradas,
        (SELECT COUNT(*) FROM virturia_objetivo_entrada e
         WHERE e.user_id=d.user_id AND e.provedor=d.provedor AND e.data=d.data AND e.resultado='green') AS greens,
        (SELECT COUNT(*) FROM virturia_objetivo_entrada e
         WHERE e.user_id=d.user_id AND e.provedor=d.provedor AND e.data=d.data AND e.resultado='red') AS reds
      FROM virturia_objetivo_dia d
      WHERE d.user_id=$1 AND d.provedor=$2
      ORDER BY d.data DESC LIMIT 30
    `, [uid, prov]);

    res.json({ ok: true, historico: rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
