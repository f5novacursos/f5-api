const router = require('express').Router();
const db     = require('../db');

/* Auto-migration: coluna checkout_url em alunos */
(async () => {
  try {
    await db.query("ALTER TABLE alunos ADD COLUMN IF NOT EXISTS checkout_url VARCHAR(600)");
    await db.query("ALTER TABLE alunos ADD COLUMN IF NOT EXISTS valor_restante VARCHAR(20)");
    await db.query("ALTER TABLE alunos ADD COLUMN IF NOT EXISTS prox_pgto DATE");
    await db.query("ALTER TABLE alunos ADD COLUMN IF NOT EXISTS obs TEXT");
  } catch (e) { console.warn('[pagamentos] migration:', e.message); }
})();


const HANDLE   = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
const IP_URL   = 'https://api.checkout.infinitepay.io/links';
const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

/* POST /api/pagamentos/link */
router.post('/link', async (req, res, next) => {
  try {
    const { aluno_id } = req.body;
    if (!aluno_id) return res.status(400).json({ error: 'aluno_id obrigatório' });

    const { rows } = await db.query('SELECT * FROM alunos WHERE id=$1', [aluno_id]);
    if (!rows.length) return res.status(404).json({ error: 'Aluno não encontrado' });
    const aluno = rows[0];

    const order_nsu      = `student-${aluno.id}-${Date.now()}`;
    const valor_reais    = parseFloat(aluno.valor || aluno.valor_curso || 600);
    const preco_centavos = Math.round(valor_reais * 100);

    const payload = {
      handle:   HANDLE,
      order_nsu,
      items: [{
        quantity:    1,
        price:       preco_centavos,
        description: aluno.curso || 'Curso F5 Nova Cursos',
      }],
      redirect_url: `https://f5novacursos.com.br/reserva.html?pago=1`,
      webhook_url:  `${BASE_URL}/webhook/infinitepay`,
      customer: {
        name: aluno.nome,
        ...(aluno.email    && { email:        aluno.email }),
        ...(aluno.whatsapp && { phone_number: '+55' + aluno.whatsapp.replace(/\D/g, '') }),
      },
    };

    const ipRes = await fetch(IP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!ipRes.ok) {
      const err = await ipRes.text();
      return res.status(502).json({ error: 'InfinitePay erro', detail: err });
    }

    const data         = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;
    if (!checkout_url) return res.status(502).json({ error: 'URL não retornada', data });

    const short_url = BASE_URL + '/pay/' + aluno.id;
    await db.query('UPDATE alunos SET order_nsu=$1, checkout_url=$2 WHERE id=$3', [order_nsu, checkout_url, aluno.id]);
    res.json({ checkout_url, short_url, order_nsu });
  } catch (err) { next(err); }
});

/* POST /api/pagamentos/matricula */
router.post('/matricula', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { nome, whatsapp, curso, valor } = req.body;
    if (!nome || !whatsapp || !curso) {
      return res.status(400).json({ error: 'nome, whatsapp e curso são obrigatórios' });
    }

    const preco = parseFloat(valor) || 600;

    const { rows } = await client.query(
      `INSERT INTO alunos (nome, whatsapp, curso, status, valor)
       VALUES ($1,$2,$3,'aguardando_pagamento',$4) RETURNING *`,
      [nome, whatsapp, curso, preco]
    );
    const aluno = rows[0];

    const order_nsu      = `student-${aluno.id}-${Date.now()}`;
    const preco_centavos = Math.round(preco * 100);

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: curso }],
      redirect_url: `https://f5novacursos.com.br/reserva.html?pago=1`,
      webhook_url:  `${BASE_URL}/webhook/infinitepay`,
      customer: {
        name:         nome,
        phone_number: '+55' + whatsapp.replace(/\D/g, ''),
      },
    };

    const ipRes = await fetch(IP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!ipRes.ok) {
      const errText = await ipRes.text();
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'InfinitePay erro', detail: errText });
    }

    const data         = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;
    if (!checkout_url) {
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'Checkout URL não retornada', data });
    }

    const short_url_mat = BASE_URL + '/pay/' + aluno.id;
    await client.query('UPDATE alunos SET order_nsu=$1, checkout_url=$2 WHERE id=$3', [order_nsu, checkout_url, aluno.id]);
    await client.query('COMMIT');

    console.log(`[Matricula] Aluno ${aluno.id} criado, checkout: ${checkout_url}`);
    res.status(201).json({ checkout_url, short_url: short_url_mat, aluno_id: aluno.id, order_nsu });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

async function webhookInfinitePay(req, res) {
  try {
    const { order_nsu, capture_method, transaction_nsu, receipt_url } = req.body;
    console.log('[InfinitePay Webhook]', JSON.stringify(req.body));

    if (!order_nsu) return res.status(400).json({ error: 'order_nsu ausente' });

    // ── FLUXO EAD (order_nsu começa com 'ead-mat-') ──────────────
    if (String(order_nsu).startsWith('ead-mat-')) {
      const { rows: mats } = await db.query(
        'SELECT * FROM ead_matriculas WHERE order_nsu=$1',
        [order_nsu]
      );

      if (!mats.length) {
        console.warn('[Webhook EAD] Matrícula não encontrada para order_nsu:', order_nsu);
        return res.status(200).json({ ok: true });
      }

      await db.query(
        `UPDATE ead_matriculas SET
           status          = 'ativa',
           transaction_nsu = $1,
           receipt_url     = $2
         WHERE order_nsu = $3`,
        [transaction_nsu || '', receipt_url || '', order_nsu]
      );

      console.log(`[Webhook EAD] Matrícula ativada - order_nsu: ${order_nsu}`);
      return res.status(200).json({ ok: true });
    }

    // ── FLUXO PRESENCIAL (aluno acadêmico) ───────────────────────
    const { rows } = await db.query('SELECT * FROM alunos WHERE order_nsu=$1', [order_nsu]);
    if (!rows.length) {
      console.warn('[Webhook] Aluno não encontrado para order_nsu:', order_nsu);
      return res.status(200).json({ ok: true });
    }

    await db.query(
      `UPDATE alunos SET
         status          = 'ativo',
         pagamento       = CURRENT_DATE,
         forma_pgto      = $1,
         transaction_nsu = $2,
         receipt_url     = $3
       WHERE order_nsu = $4`,
      [capture_method || 'online', transaction_nsu || '', receipt_url || '', order_nsu]
    );

    console.log(`[Webhook] Aluno ativado - order_nsu: ${order_nsu}`);

    // Notificar n8n — Confirmação de Matrícula
    fetch('https://n8n.f5novacursos.com.br/webhook/f5nova-matricula-confirmada', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome:     rows[0].nome,
        whatsapp: '55' + rows[0].whatsapp.replace(/\D/g, ''),
        curso:    rows[0].curso,
        aluno_id: rows[0].id
      })
    }).catch(e => console.error('[n8n matricula]', e.message));

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Webhook] Erro:', err);
    res.status(400).json({ error: err.message });
  }
}


/* GET /pay/:id — redirect curto para checkout InfinitePay */
async function payRedirect(req, res) {
  try {
    const { rows } = await db.query('SELECT checkout_url FROM alunos WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].checkout_url) {
      return res.status(404).send('Link de pagamento nao encontrado ou expirado.');
    }
    res.redirect(302, rows[0].checkout_url);
  } catch (err) {
    console.error('[payRedirect]', err);
    res.status(500).send('Erro interno.');
  }
}

module.exports = router;
module.exports.webhookInfinitePay = webhookInfinitePay;
module.exports.payRedirect = payRedirect;
