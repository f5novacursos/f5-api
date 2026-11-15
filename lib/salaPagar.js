// F5 Sala — cobrança pelo Mercado Pago (mesmo molde do F5 Caixa): Pix, Checkout Pro (cartão/boleto) e o webhook que soma dias no vencimento.
// Não é cobrança automática: a cada período a escola paga (Pix/cartão) e o vencimento anda 30 (mensal) ou 365 (anual) dias.
// Segredo SÓ por variável de ambiente (Coolify): MERCADOPAGO_ACCESS_TOKEN. Nunca escrever token em arquivo.
const crypto = require('crypto');
const db = require('../db');
const L = require('./salaLicenca');

const MP = process.env.MP_API_URL || 'https://api.mercadopago.com'; // MP_API_URL só existe para testes locais
const API_PUBLICA = process.env.SALA_PUBLIC_URL || 'https://api.f5novacursos.com.br';
const SITE = process.env.SALA_SITE_URL || 'https://f5novacursos.com.br';

function token() {
  const t = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!t) { const e = new Error('Pagamento ainda não disponível (token do Mercado Pago não configurado).'); e.status = 503; throw e; }
  return t;
}
async function mp(caminho, opcoes = {}) {
  const r = await fetch(MP + caminho, { ...opcoes, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(), ...(opcoes.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.message || ('Mercado Pago respondeu ' + r.status)); e.status = 502; e.detalhe = d; throw e; }
  return d;
}

const valorDoCiclo = async (ciclo) => { const p = await L.precos(); return ciclo === 'anual' ? p.anual : p.mensal; };
const descricao = (lic, ciclo) => `F5 Sala — ${lic.escola || 'licença'} (${lic.sala}) — ${ciclo === 'anual' ? '12 meses' : '1 mês'}`;
const referencia = (lic, ciclo) => JSON.stringify({ sala: 1, licenca_id: lic.id, ciclo });

async function criarPix(lic, cliente, ciclo) {
  const valor = await valorDoCiclo(ciclo);
  const d = await mp('/v1/payments', {
    method: 'POST', headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: valor, description: descricao({ ...lic, escola: cliente.escola }, ciclo), payment_method_id: 'pix',
      payer: { email: cliente.email }, external_reference: referencia(lic, ciclo),
      notification_url: `${API_PUBLICA}/api/sala/pagar/webhook`,
    }),
  });
  const t = (d.point_of_interaction && d.point_of_interaction.transaction_data) || {};
  return { payment_id: String(d.id), valor, copia_cola: t.qr_code || '', qr_base64: t.qr_code_base64 || '', ticket_url: t.ticket_url || '' };
}

async function criarCheckout(lic, cliente, ciclo) {
  const valor = await valorDoCiclo(ciclo);
  const d = await mp('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ title: descricao({ ...lic, escola: cliente.escola }, ciclo), quantity: 1, unit_price: valor, currency_id: 'BRL' }],
      payer: { email: cliente.email }, external_reference: referencia(lic, ciclo),
      notification_url: `${API_PUBLICA}/api/sala/pagar/webhook`,
      back_urls: { success: `${SITE}/f5-sala.html?pago=1`, failure: `${SITE}/f5-sala.html`, pending: `${SITE}/f5-sala.html?pendente=1` },
      auto_return: 'approved',
    }),
  });
  return { url: d.init_point, valor };
}

const buscarPagamento = (id) => mp('/v1/payments/' + encodeURIComponent(id));

// Soma dias à licença e guarda o pagamento (uma vez só por pagamento: idempotente)
async function registrarPagamento({ licencaId, valor, ciclo, metodo, origem = 'mp', obs = null, mpId = null }) {
  const { rows } = await db.query(`SELECT l.*, c.escola, c.email, c.telefone FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.id = $1`, [licencaId]);
  if (!rows.length) return { ok: false, erro: 'licenca_inexistente' };
  const lic = rows[0];
  if (mpId) { const ja = await db.query('SELECT id FROM sala_pagamentos WHERE mp_payment_id = $1', [mpId]); if (ja.rows.length) return { ok: true, repetido: true }; } // mesmo pagamento nunca soma duas vezes
  const ins = await db.query(
    `INSERT INTO sala_pagamentos (licenca_id, mp_payment_id, valor, ciclo, metodo, origem, obs) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (mp_payment_id) DO NOTHING RETURNING id`, [licencaId, mpId, valor, ciclo, metodo || null, origem, obs]);
  if (!ins.rows.length) return { ok: true, repetido: true };
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const atual = lic.proximo_vencimento ? new Date(L.diaISO(lic.proximo_vencimento) + 'T00:00:00') : null;
  const base = atual && atual > hoje && lic.plano !== 'demo' ? atual : hoje;
  const novo = L.somarDias(base, ciclo === 'anual' ? 365 : 30);
  const nova = L.diaISO(novo);
  await db.query(
    `UPDATE sala_licencas SET plano = CASE WHEN vitalicia THEN plano ELSE 'sala' END, ciclo = $1, valor = $2, proximo_vencimento = $3, demo_ate = NULL,
            limite_alunos = $4, status = CASE WHEN status = 'suspenso' THEN status ELSE 'ativo' END WHERE id = $5`,
    [ciclo, valor, nova, Math.max(lic.limite_alunos || 0, L.LIMITE_PADRAO), licencaId]);
  await db.query(`UPDATE sala_pagamentos SET novo_vencimento = $1 WHERE id = $2`, [nova, ins.rows[0].id]);
  L.enviarEmail({
    to: lic.email, subject: 'Pagamento confirmado — F5 Sala',
    html: L.caixaEmail('Pagamento confirmado!', `<p>Recebemos o pagamento da licença <b>${L.escapar(lic.sala)}</b> (${L.escapar(lic.escola)}).</p><p>Sua licença está ativa até <b>${nova.split('-').reverse().join('/')}</b>. Obrigado!</p>`),
    text: `Pagamento confirmado. Licença do F5 Sala (${lic.sala}) ativa até ${nova}.`,
  }).catch(() => {});
  return { ok: true, novo_vencimento: nova };
}

// Aplica um pagamento do Mercado Pago (já consultado na API do MP — nunca confiamos no corpo do webhook)
async function aplicarPagamentoMP(pag) {
  if (!pag || pag.status !== 'approved' || !pag.external_reference) return { ok: false, motivo: 'nao_aprovado' };
  let ext; try { ext = JSON.parse(pag.external_reference); } catch { return { ok: false, motivo: 'referencia_invalida' }; }
  if (!ext || !ext.sala || !ext.licenca_id) return { ok: false, motivo: 'outro_sistema' };
  const ciclo = ext.ciclo === 'anual' ? 'anual' : 'mensal';
  const esperado = await valorDoCiclo(ciclo);
  if (Number(pag.transaction_amount || 0) + 0.01 < esperado) { console.warn(`[sala] pagamento ${pag.id} abaixo do preço (${pag.transaction_amount} < ${esperado}) — NÃO aplicado`); return { ok: false, motivo: 'valor_menor' }; }
  return registrarPagamento({ licencaId: Number(ext.licenca_id), valor: Number(pag.transaction_amount), ciclo, metodo: pag.payment_type_id || pag.payment_method_id || null, origem: 'mp', mpId: String(pag.id) });
}

module.exports = { criarPix, criarCheckout, buscarPagamento, registrarPagamento, aplicarPagamentoMP, valorDoCiclo };
