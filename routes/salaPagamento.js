// F5 Sala — pagamento da licença (Mercado Pago). Base: /api/sala/pagar
//   POST /pix        { chave, ciclo }   → Pix com copia-e-cola (dentro do programa)
//   POST /checkout   { chave, ciclo }   → link do Checkout Pro (cartão/boleto/Pix)
//   GET  /status/:id ?chave=            → o programa pergunta se já foi aprovado (e aplica, se o webhook ainda não chegou)
//   GET  /ir/:token  ?ciclo=            → link curto de cobrança (WhatsApp/e-mail): cria o checkout na hora e redireciona
//   POST /webhook                       → aviso do Mercado Pago (sempre confere o pagamento na API do MP antes de aplicar)
const express = require('express');
const db = require('../db');
const router = express.Router();
const { garantirTabelas, normalizarChave } = require('../lib/salaDb');
const L = require('../lib/salaLicenca');
const P = require('../lib/salaPagar');

router.use(async (req, res, next) => { try { await garantirTabelas(); next(); } catch (e) { res.status(503).json({ error: 'Sistema de licenças indisponível no momento.' }); } });

async function porChave(chaveBruta) {
  const { rows } = await db.query(`SELECT l.*, c.escola, c.email, c.telefone FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.chave = $1`, [normalizarChave(chaveBruta)]);
  return rows[0] || null;
}
const cicloDe = (v) => (v === 'anual' ? 'anual' : 'mensal');
function erro(res, e) { const s = e.status || 500; if (s >= 500 && s !== 503) console.error('[sala pagar]', e.message, e.detalhe ? JSON.stringify(e.detalhe).slice(0, 300) : ''); res.status(s === 502 ? 502 : s).json({ error: s === 502 ? 'Não consegui falar com o Mercado Pago agora. Tente de novo em instantes.' : e.message }); }

router.post('/pix', async (req, res) => {
  try {
    if (!L.limitar('pix:' + req.ip, 20, 3600000)) return res.status(429).json({ error: 'Muitos pedidos. Tente de novo daqui a pouco.' });
    const lic = await porChave((req.body || {}).chave);
    if (!lic) return res.status(404).json({ error: 'Chave não encontrada.' });
    if (lic.vitalicia) return res.status(400).json({ error: 'Esta licença é vitalícia: não precisa de pagamento.' });
    res.json({ ok: true, ...(await P.criarPix(lic, { escola: lic.escola, email: lic.email }, cicloDe(req.body.ciclo))) });
  } catch (e) { erro(res, e); }
});

router.post('/checkout', async (req, res) => {
  try {
    if (!L.limitar('chk:' + req.ip, 20, 3600000)) return res.status(429).json({ error: 'Muitos pedidos. Tente de novo daqui a pouco.' });
    const lic = await porChave((req.body || {}).chave);
    if (!lic) return res.status(404).json({ error: 'Chave não encontrada.' });
    if (lic.vitalicia) return res.status(400).json({ error: 'Esta licença é vitalícia: não precisa de pagamento.' });
    const r = await P.criarCheckout(lic, { escola: lic.escola, email: lic.email }, cicloDe(req.body.ciclo));
    if (!r.url) return res.status(502).json({ error: 'O Mercado Pago não devolveu o link. Tente de novo.' });
    res.json({ ok: true, ...r });
  } catch (e) { erro(res, e); }
});

router.get('/status/:id', async (req, res) => {
  try {
    const lic = await porChave(req.query.chave);
    if (!lic) return res.status(404).json({ error: 'Chave não encontrada.' });
    const pag = await P.buscarPagamento(req.params.id);
    let ext = {}; try { ext = JSON.parse(pag.external_reference || '{}'); } catch {}
    if (Number(ext.licenca_id) !== lic.id) return res.status(404).json({ error: 'Pagamento não encontrado.' }); // só dá para consultar pagamento da própria chave
    const r = pag.status === 'approved' ? await P.aplicarPagamentoMP(pag) : { ok: false };
    res.json({ ok: true, status: pag.status, aplicado: !!r.ok, novo_vencimento: r.novo_vencimento || null });
  } catch (e) { erro(res, e); }
});

router.get('/ir/:token', async (req, res) => {
  try {
    if (!L.limitar('ir:' + req.ip, 30, 3600000)) return res.status(429).send('Muitos pedidos. Tente de novo daqui a pouco.');
    const { rows } = await db.query(`SELECT l.*, c.escola, c.email FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.token_pagamento = $1`, [String(req.params.token || '').slice(0, 60)]);
    if (!rows.length || rows[0].vitalicia) return res.status(404).send('Link de pagamento não encontrado.');
    const r = await P.criarCheckout(rows[0], { escola: rows[0].escola, email: rows[0].email }, cicloDe(req.query.ciclo));
    if (!r.url) return res.status(502).send('Não consegui abrir o pagamento agora. Tente de novo em instantes.');
    res.redirect(302, r.url);
  } catch (e) { console.error('[sala pagar ir]', e.message); res.status(e.status || 500).send('Não consegui abrir o pagamento agora. Tente de novo em instantes.'); }
});

router.post('/webhook', async (req, res) => {
  try {
    const id = (req.body && req.body.data && req.body.data.id) || req.query['data.id'] || (req.query.topic === 'payment' ? req.query.id : null);
    const tipo = (req.body && req.body.type) || req.query.type || req.query.topic;
    if (id && (tipo === 'payment' || !tipo)) {
      const pag = await P.buscarPagamento(id);
      const r = await P.aplicarPagamentoMP(pag);
      if (r.ok && !r.repetido) console.log(`[sala] pagamento ${id} aplicado: vencimento ${r.novo_vencimento}`);
    }
  } catch (e) { console.error('[sala webhook]', e.message); }
  res.status(200).send('OK'); // sempre 200, para o Mercado Pago não repetir sem parar
});

module.exports = router;
