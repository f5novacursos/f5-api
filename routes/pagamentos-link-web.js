// routes/pagamentos-link-web.js
// Rota nova para gerar link de pagamento InfinitePay para clientes web
// Adicionar no server.js: app.use('/api/pagamentos', require('./routes/pagamentos-link-web'));

const router   = require('express').Router();
const db       = require('../db');

const HANDLE   = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
const IP_URL   = 'https://api.checkout.infinitepay.io/links';
const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

// POST /api/pagamentos/link-web
router.post('/link-web', async (req, res, next) => {
  try {
    const { cliente_web_id, valor, descricao } = req.body;
    if (!cliente_web_id) return res.status(400).json({ error: 'cliente_web_id obrigatório' });

    // Busca cliente
    const { rows } = await db.query('SELECT * FROM clientes_web WHERE id=$1', [cliente_web_id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    const cliente = rows[0];

    const valor_reais    = parseFloat(valor || cliente.mensalidade || 27);
    const preco_centavos = Math.round(valor_reais * 100);
    const order_nsu      = `web-${cliente.id}-${Date.now()}`;
    const desc           = descricao || `Mensalidade ${cliente.plano} — ${cliente.dominio}`;

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: desc }],
      redirect_url: `https://f5novacursos.com.br?pago=1`,
      webhook_url:  `${BASE_URL}/webhook/infinitepay-web`,
      customer: {
        name: cliente.nome,
        ...(cliente.whatsapp && { phone_number: '+55' + cliente.whatsapp.replace(/\D/g, '') }),
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

    const short_url = `${BASE_URL}/pay-web/${cliente.id}`;

    // Salva order_nsu no cliente para o webhook de confirmação
    await db.query(
      'UPDATE clientes_web SET obs = CONCAT(COALESCE(obs,\'\'), $1) WHERE id=$2',
      [`\n[${new Date().toISOString().split('T')[0]}] order_nsu: ${order_nsu}`, cliente.id]
    );

    console.log(`[link-web] Cliente ${cliente.id} — ${checkout_url}`);
    res.json({ checkout_url, short_url, order_nsu });

  } catch (err) { next(err); }
});

// GET /pay-web/:id — redirect curto para o último link gerado
// TODO: salvar checkout_url em coluna própria da clientes_web quando precisar

module.exports = router;
