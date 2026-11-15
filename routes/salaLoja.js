// F5 Sala — loja do site (f5sala.com.br): comprar uma licença e Área do cliente. Base: /api/sala/loja
//   POST /comprar   { escola, sala, responsavel, email, telefone, ciclo, aceite } → { url } (Checkout do Mercado Pago)
//   POST /codigo    { email }                 → manda um código de 6 dígitos para o e-mail do responsável (sempre responde ok)
//   POST /entrar    { email, codigo }         → { token } (vale 8 horas)
//   GET  /conta     Authorization: Bearer     → escola, chaves (salas), vencimentos, links de pagamento e download
//   POST /nova-sala { sala, ciclo }           → { url } (compra de mais uma sala, já logado)
// O pagamento aprovado chega pelo webhook (routes/salaPagamento.js), que ativa a licença e manda o e-mail com a chave e o botão de baixar.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();
const { garantirTabelas, novaChave, novoToken } = require('../lib/salaDb');
const L = require('../lib/salaLicenca');
const P = require('../lib/salaPagar');
const LEM = require('../lib/salaLembretes');

router.use(async (req, res, next) => { try { await garantirTabelas(); next(); } catch (e) { res.status(503).json({ error: 'Loja indisponível no momento.' }); } });

const texto = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cicloDe = (v) => (v === 'anual' ? 'anual' : 'mensal');
const SEGREDO = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const assinar = (dados) => { const p = b64(dados); return p + '.' + crypto.createHmac('sha256', SEGREDO).update(p).digest('base64url'); };
function lerToken(t) {
  const [p, s] = String(t || '').split('.'); if (!p || !s) return null;
  const esperado = crypto.createHmac('sha256', SEGREDO).update(p).digest('base64url');
  if (s.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esperado))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return d.x > Date.now() ? d : null; } catch { return null; }
}
async function clienteDoToken(req, res) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const d = lerToken(t); if (!d) { res.status(401).json({ error: 'Sua sessão expirou. Entre de novo.' }); return null; }
  const { rows } = await db.query('SELECT * FROM sala_clientes WHERE id = $1', [d.c]);
  if (!rows.length) { res.status(401).json({ error: 'Cliente não encontrado.' }); return null; }
  return rows[0];
}

// cria (ou reaproveita) a licença ainda NÃO paga e devolve o link de pagamento
async function novaLicencaEPagamento(cliente, sala, ciclo) {
  sala = texto(sala, 60) || 'Laboratório 1';
  const p = await L.precos();
  let lic = (await db.query(`SELECT * FROM sala_licencas WHERE cliente_id = $1 AND sala = $2 AND plano = 'sala' AND proximo_vencimento IS NULL AND vitalicia = FALSE ORDER BY id DESC LIMIT 1`, [cliente.id, sala])).rows[0];
  if (!lic) {
    lic = (await db.query(
      `INSERT INTO sala_licencas (cliente_id, chave, token_pagamento, sala, plano, ciclo, valor, limite_alunos, max_maquinas, status) VALUES ($1,$2,$3,$4,'sala',$5,$6,$7,1,'ativo') RETURNING *`,
      [cliente.id, novaChave(), novoToken(), sala, ciclo, ciclo === 'anual' ? p.anual : p.mensal, L.LIMITE_PADRAO])).rows[0];
  }
  const r = await P.criarCheckout(lic, { escola: cliente.escola, email: cliente.email }, ciclo);
  if (!r.url) { const e = new Error('O Mercado Pago não devolveu o link de pagamento. Tente de novo.'); e.status = 502; throw e; }
  return r.url;
}
const falha = (res, e) => res.status(e.status || 500).json({ error: e.status === 502 ? 'Não consegui falar com o Mercado Pago agora. Tente de novo em instantes.' : (e.message || 'Erro interno') });

router.post('/comprar', async (req, res) => {
  try {
    const b = req.body || {}; const email = L.normalizarEmail(b.email); const escola = texto(b.escola, 160); const resp = texto(b.responsavel, 160); const tel = L.telefoneBR(b.telefone);
    if (!escola || !resp) return res.status(400).json({ error: 'Informe o nome da escola e o seu nome.' });
    if (!L.emailOk(email)) return res.status(400).json({ error: 'Digite um e-mail válido.' });
    if (!tel) return res.status(400).json({ error: 'Digite um WhatsApp válido, com DDD.' });
    if (b.aceite !== true) return res.status(400).json({ error: 'Para continuar, aceite receber os avisos de cobrança por e-mail e WhatsApp.' });
    if (!L.limitar('loja:' + req.ip, 12, 3600000) || !L.limitar('loja-em:' + email, 6, 3600000)) return res.status(429).json({ error: 'Muitas tentativas. Tente de novo daqui a pouco.' });
    let cliente = (await db.query('SELECT * FROM sala_clientes WHERE email = $1 ORDER BY id ASC LIMIT 1', [email])).rows[0];
    if (!cliente) cliente = (await db.query(`INSERT INTO sala_clientes (escola, responsavel, email, telefone, origem, aceite_avisos) VALUES ($1,$2,$3,$4,'site',TRUE) RETURNING *`, [escola, resp, email, tel])).rows[0];
    res.json({ ok: true, url: await novaLicencaEPagamento(cliente, b.sala, cicloDe(b.ciclo)) });
  } catch (e) { falha(res, e); }
});

router.post('/codigo', async (req, res) => {
  try {
    const email = L.normalizarEmail((req.body || {}).email);
    if (!L.emailOk(email)) return res.status(400).json({ error: 'Digite um e-mail válido.' });
    if (!L.limitar('cli-ip:' + req.ip, 10, 3600000) || !L.limitar('cli-em:' + email, 4, 3600000)) return res.status(429).json({ error: 'Muitos pedidos. Tente de novo daqui a pouco.' });
    const c = (await db.query('SELECT id, responsavel FROM sala_clientes WHERE email = $1 LIMIT 1', [email])).rows[0];
    if (c) {
      const codigo = await L.criarCodigo(email, 'portal');
      await L.enviarEmail({ to: email, subject: 'Seu código para entrar na Área do cliente do F5 Sala', html: require('../lib/salaEmails').layout('Seu código de acesso', `<p style="font-size:16px">Use este código para entrar na Área do cliente:</p><p style="font:900 38px Arial Black;letter-spacing:8px;margin:14px 0">${codigo}</p><p style="color:#6d7168">Vale por 15 minutos. Se não foi você, ignore este e-mail.</p>`), text: `Código da Área do cliente do F5 Sala: ${codigo}. Vale por 15 minutos.` });
    }
    res.json({ ok: true, minutos: 15 }); // sempre "ok": não revela quais e-mails são clientes
  } catch (e) { falha(res, e); }
});

router.post('/entrar', async (req, res) => {
  try {
    const email = L.normalizarEmail((req.body || {}).email);
    if (!L.limitar('cli-ent:' + req.ip, 20, 3600000)) return res.status(429).json({ error: 'Muitas tentativas.' });
    const c = await L.conferirCodigo(email, 'portal', (req.body || {}).codigo);
    if (!c.ok) return res.status(400).json({ error: c.erro });
    const cl = (await db.query('SELECT id FROM sala_clientes WHERE email = $1 ORDER BY id ASC LIMIT 1', [email])).rows[0];
    if (!cl) return res.status(400).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true, token: assinar({ c: cl.id, x: Date.now() + 8 * 3600000 }) });
  } catch (e) { falha(res, e); }
});

router.get('/conta', async (req, res) => {
  try {
    const cl = await clienteDoToken(req, res); if (!cl) return;
    const ls = (await db.query('SELECT * FROM sala_licencas WHERE cliente_id = $1 ORDER BY id ASC', [cl.id])).rows;
    const desde = new Date(Date.now() - 30 * L.DIA); const out = [];
    for (const l of ls) {
      const s = L.situacao(l);
      const alunos = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'aluno' AND ultimo_visto >= $2`, [l.id, desde])).rows[0].n;
      const profs = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND ativa = TRUE`, [l.id])).rows[0].n;
      out.push({ id: l.id, sala: l.sala, chave: l.chave, plano: l.vitalicia ? 'interna' : l.plano, ciclo: l.ciclo, estado: s.estado, limite_alunos: s.limite, limite_plano: l.limite_alunos, vencimento: l.vitalicia ? null : (l.plano === 'demo' ? L.diaISO(l.demo_ate) : L.diaISO(l.proximo_vencimento) || null), alunos_usados: alunos, computadores_professor: profs, vitalicia: !!l.vitalicia, link_mensal: l.vitalicia ? '' : LEM.linkPagamento(l, 'mensal'), link_anual: l.vitalicia ? '' : LEM.linkPagamento(l, 'anual') });
    }
    res.json({ ok: true, cliente: { escola: cl.escola, responsavel: cl.responsavel, email: cl.email }, licencas: out, precos: await L.precos(), download: (process.env.SALA_PUBLIC_URL || 'https://api.f5novacursos.com.br') + '/api/sala/licenca/download' });
  } catch (e) { falha(res, e); }
});

router.post('/nova-sala', async (req, res) => {
  try {
    const cl = await clienteDoToken(req, res); if (!cl) return;
    res.json({ ok: true, url: await novaLicencaEPagamento(cl, (req.body || {}).sala, cicloDe((req.body || {}).ciclo)) });
  } catch (e) { falha(res, e); }
});

module.exports = router;
