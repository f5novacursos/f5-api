// F5 Sala — rotas do ADMIN (módulo "F5 Sala" dentro do F5 Admin). Base: /api/admin/sala  (protegidas por adminAuth, montado no server.js)
// Escolas (clientes), chaves (licenças = salas), pagamentos (pago/não pago), computadores, professores, chamados de suporte e configurações.
const express = require('express');
const db = require('../db');
const router = express.Router();
const { garantirTabelas, lerConfig, gravarConfig, novaChave, novoToken } = require('../lib/salaDb');
const L = require('../lib/salaLicenca');
const P = require('../lib/salaPagar');
const LEM = require('../lib/salaLembretes');

router.use(async (req, res, next) => { try { await garantirTabelas(); next(); } catch (e) { res.status(503).json({ error: 'Banco do F5 Sala indisponível.' }); } });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[sala admin]', e.message); res.status(e.status || 500).json({ error: e.message || 'Erro interno' }); });
const texto = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const num = (v, p = null) => { const n = Number(v); return Number.isFinite(n) ? n : p; };

// resumo da licença para as listas
function resumo(l) {
  const s = L.situacao(l);
  return { ...l, estado: s.estado, limite_efetivo: s.limite, vencimento_txt: l.vitalicia ? 'vitalícia' : (l.plano === 'demo' ? L.diaISO(l.demo_ate) : L.diaISO(l.proximo_vencimento)) };
}

// ---------- painel ----------
router.get('/painel', wrap(async (req, res) => {
  const ls = (await db.query(`SELECT l.*, c.escola FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id`)).rows.map(resumo);
  const agora = Date.now();
  const online = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE tipo = 'professor' AND ativa = TRUE AND ultimo_visto >= $1`, [new Date(agora - 2 * 3600000)])).rows[0].n;
  const alunos30 = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE tipo = 'aluno' AND ultimo_visto >= $1`, [new Date(agora - 30 * L.DIA)])).rows[0].n;
  const clientes = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_clientes`)).rows[0].n;
  const chamados = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_chamados WHERE status = 'aberto'`)).rows[0].n;
  const pagos = ls.filter((l) => l.plano === 'sala' && !l.vitalicia && ['ativo', 'carencia'].includes(l.estado)); // só quem está pagando de fato
  const receitaMensal = pagos.reduce((t, l) => t + (Number(l.valor) || 0) / (l.ciclo === 'anual' ? 12 : 1), 0);
  const em = (d1, d2) => ls.filter((l) => l.plano === 'sala' && !l.vitalicia && l.proximo_vencimento && (new Date(L.diaISO(l.proximo_vencimento) + 'T00:00:00-03:00').getTime() - agora) / L.DIA >= d1 && (new Date(L.diaISO(l.proximo_vencimento) + 'T00:00:00-03:00').getTime() - agora) / L.DIA < d2).length;
  res.json({
    clientes, licencas: ls.length,
    ativas: ls.filter((l) => l.estado === 'ativo' && l.plano !== 'demo').length,
    demos: ls.filter((l) => l.plano === 'demo' && l.estado === 'ativo').length,
    em_carencia: ls.filter((l) => l.estado === 'carencia').length,
    vencidas: ls.filter((l) => l.estado === 'vencido' && l.plano !== 'demo').length,
    suspensas: ls.filter((l) => l.estado === 'suspenso').length,
    vencem_7_dias: em(0, 7),
    receita_mensal: Math.round(receitaMensal * 100) / 100,
    computadores_professor_online: online, computadores_aluno_30d: alunos30, chamados_abertos: chamados,
  });
}));

// ---------- clientes (escolas) ----------
router.get('/clientes', wrap(async (req, res) => {
  const cs = (await db.query(`SELECT * FROM sala_clientes ORDER BY id DESC`)).rows;
  const ls = (await db.query(`SELECT * FROM sala_licencas ORDER BY id ASC`)).rows.map(resumo);
  res.json(cs.map((c) => ({ ...c, licencas: ls.filter((l) => l.cliente_id === c.id) })));
}));
router.post('/clientes', wrap(async (req, res) => {
  const b = req.body || {}; const email = L.normalizarEmail(b.email);
  if (!texto(b.escola, 160)) return res.status(400).json({ error: 'Informe o nome da escola/empresa.' });
  if (!L.emailOk(email)) return res.status(400).json({ error: 'E-mail do responsável inválido.' });
  const tel = b.telefone ? L.telefoneBR(b.telefone) : '';
  if (b.telefone && !tel) return res.status(400).json({ error: 'WhatsApp inválido (use DDD + número).' });
  const r = await db.query(
    `INSERT INTO sala_clientes (escola, responsavel, email, telefone, documento, site, instagram, origem, aceite_avisos, obs) VALUES ($1,$2,$3,$4,$5,$6,$7,'admin',$8,$9) RETURNING *`,
    [texto(b.escola, 160), texto(b.responsavel, 160) || null, email, tel || null, texto(b.documento, 30) || null, texto(b.site, 200) || null, texto(b.instagram, 200) || null, b.aceite_avisos !== false, texto(b.obs, 2000) || null]);
  res.status(201).json(r.rows[0]);
}));
router.put('/clientes/:id', wrap(async (req, res) => {
  const b = req.body || {}; const id = num(req.params.id);
  const at = (await db.query(`SELECT * FROM sala_clientes WHERE id = $1`, [id])).rows[0];
  if (!at) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const email = b.email !== undefined ? L.normalizarEmail(b.email) : at.email;
  if (!L.emailOk(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  const tel = b.telefone !== undefined ? (b.telefone ? L.telefoneBR(b.telefone) : '') : at.telefone;
  if (b.telefone && !tel) return res.status(400).json({ error: 'WhatsApp inválido (use DDD + número).' });
  const r = await db.query(
    `UPDATE sala_clientes SET escola=$1, responsavel=$2, email=$3, telefone=$4, documento=$5, site=$6, instagram=$7, aceite_avisos=$8, obs=$9 WHERE id=$10 RETURNING *`,
    [texto(b.escola ?? at.escola, 160), texto(b.responsavel ?? at.responsavel, 160) || null, email, tel || null, texto(b.documento ?? at.documento, 30) || null, texto(b.site ?? at.site, 200) || null, texto(b.instagram ?? at.instagram, 200) || null, b.aceite_avisos ?? at.aceite_avisos, texto(b.obs ?? at.obs, 2000) || null, id]);
  res.json(r.rows[0]);
}));

// ---------- licenças (chaves) ----------
router.post('/licencas', wrap(async (req, res) => {
  const b = req.body || {}; const clienteId = num(b.cliente_id);
  const cl = (await db.query(`SELECT * FROM sala_clientes WHERE id = $1`, [clienteId])).rows[0];
  if (!cl) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const sala = texto(b.sala, 60); if (!sala) return res.status(400).json({ error: 'Informe o nome da sala (ex.: ARCA).' });
  const plano = ['sala', 'demo', 'interna'].includes(b.plano) ? b.plano : 'sala';
  const ciclo = b.ciclo === 'anual' ? 'anual' : 'mensal';
  const p = await L.precos();
  const valor = b.valor !== undefined && b.valor !== '' ? num(b.valor, 0) : (ciclo === 'anual' ? p.anual : p.mensal);
  const venc = b.proximo_vencimento ? texto(b.proximo_vencimento, 10) : null;
  const r = await db.query(
    `INSERT INTO sala_licencas (cliente_id, chave, token_pagamento, sala, plano, ciclo, valor, limite_alunos, max_maquinas, status, vitalicia, proximo_vencimento, demo_ate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ativo',$10,$11,$12) RETURNING *`,
    [clienteId, novaChave(), novoToken(), sala, plano, ciclo, valor, num(b.limite_alunos, L.LIMITE_PADRAO), num(b.max_maquinas, 1), !!b.vitalicia, venc, plano === 'demo' ? L.somarDias(new Date(), L.DEMO_DIAS) : null]);
  if (b.enviar_email) await enviarChave(r.rows[0], cl);
  res.status(201).json(resumo(r.rows[0]));
}));
router.put('/licencas/:id', wrap(async (req, res) => {
  const b = req.body || {}; const id = num(req.params.id);
  const at = (await db.query(`SELECT * FROM sala_licencas WHERE id = $1`, [id])).rows[0];
  if (!at) return res.status(404).json({ error: 'Licença não encontrada.' });
  const status = ['ativo', 'suspenso', 'cancelado'].includes(b.status) ? b.status : at.status;
  const r = await db.query(
    `UPDATE sala_licencas SET sala=$1, plano=$2, ciclo=$3, valor=$4, limite_alunos=$5, max_maquinas=$6, status=$7, vitalicia=$8, proximo_vencimento=$9, demo_ate=$10 WHERE id=$11 RETURNING *`,
    [texto(b.sala ?? at.sala, 60), ['sala', 'demo', 'interna'].includes(b.plano) ? b.plano : at.plano, b.ciclo === 'anual' ? 'anual' : (b.ciclo === 'mensal' ? 'mensal' : at.ciclo), b.valor !== undefined ? num(b.valor, at.valor) : at.valor,
     num(b.limite_alunos, at.limite_alunos), num(b.max_maquinas, at.max_maquinas), status, b.vitalicia ?? at.vitalicia, b.proximo_vencimento !== undefined ? (b.proximo_vencimento || null) : at.proximo_vencimento, b.demo_ate !== undefined ? (b.demo_ate || null) : at.demo_ate, id]);
  res.json(resumo(r.rows[0]));
}));
router.get('/licencas/:id', wrap(async (req, res) => {
  const id = num(req.params.id);
  const l = (await db.query(`SELECT l.*, c.escola, c.responsavel, c.email, c.telefone FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.id = $1`, [id])).rows[0];
  if (!l) return res.status(404).json({ error: 'Licença não encontrada.' });
  const maquinas = (await db.query(`SELECT * FROM sala_maquinas WHERE licenca_id = $1 ORDER BY tipo ASC, ultimo_visto DESC LIMIT 400`, [id])).rows;
  const professores = (await db.query(`SELECT * FROM sala_professores WHERE licenca_id = $1 ORDER BY ultimo_visto DESC`, [id])).rows;
  const pagamentos = (await db.query(`SELECT * FROM sala_pagamentos WHERE licenca_id = $1 ORDER BY id DESC LIMIT 60`, [id])).rows;
  const avisos = (await db.query(`SELECT * FROM sala_avisos WHERE licenca_id = $1 ORDER BY id DESC LIMIT 30`, [id])).rows;
  const desde = Date.now() - 30 * L.DIA;
  res.json({
    ...resumo(l), maquinas, professores, pagamentos, avisos,
    alunos_usados: maquinas.filter((m) => m.tipo === 'aluno' && new Date(m.ultimo_visto).getTime() >= desde).length,
    link_pagamento_mensal: LEM.linkPagamento(l, 'mensal'), link_pagamento_anual: LEM.linkPagamento(l, 'anual'),
  });
}));
async function enviarChave(lic, cl) {
  const download = (process.env.SALA_PUBLIC_URL || 'https://api.f5novacursos.com.br') + '/api/sala/licenca/download';
  return L.enviarEmail({
    to: cl.email, subject: 'Sua chave do F5 Sala',
    html: L.caixaEmail(`Olá, ${L.escapar((cl.responsavel || '').split(' ')[0] || 'tudo bem')}!`, `<p>Chave do F5 Sala da <b>${L.escapar(cl.escola)}</b> (sala <b>${L.escapar(lic.sala)}</b>):</p><p style="font-size:26px;font-weight:700;letter-spacing:2px;margin:12px 0">${lic.chave}</p><p><b>1.</b> <a href="${download}">Baixe o F5 Sala</a> e instale no computador do professor.<br><b>2.</b> Ao abrir, digite a chave acima.<br><b>3.</b> Instale também no computador de cada aluno e escolha "Aluno".</p>`),
    text: `Chave do F5 Sala (${lic.sala}): ${lic.chave}. Baixe em ${download}`,
  });
}
router.post('/licencas/:id/enviar-chave', wrap(async (req, res) => {
  const l = (await db.query(`SELECT l.*, c.escola, c.responsavel, c.email FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.id = $1`, [num(req.params.id)])).rows[0];
  if (!l) return res.status(404).json({ error: 'Licença não encontrada.' });
  const ok = await enviarChave(l, l);
  res.json({ ok, para: l.email });
}));
// marca como PAGO manualmente (dinheiro, transferência, Pix fora do sistema)
router.post('/licencas/:id/pago', wrap(async (req, res) => {
  const b = req.body || {}; const ciclo = b.ciclo === 'anual' ? 'anual' : 'mensal';
  const valor = b.valor !== undefined && b.valor !== '' ? num(b.valor, 0) : await P.valorDoCiclo(ciclo);
  const r = await P.registrarPagamento({ licencaId: num(req.params.id), valor, ciclo, metodo: texto(b.metodo, 20) || 'manual', origem: 'admin', obs: texto(b.obs, 500) || null, mpId: null });
  if (!r.ok) return res.status(404).json({ error: 'Licença não encontrada.' });
  res.json(r);
}));
// lembrete agora (WhatsApp + e-mail), sem esperar o dia certo
router.post('/licencas/:id/lembrar', wrap(async (req, res) => {
  const l = (await db.query(`SELECT l.*, c.escola, c.responsavel, c.email, c.telefone, c.aceite_avisos FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.id = $1`, [num(req.params.id)])).rows[0];
  if (!l) return res.status(404).json({ error: 'Licença não encontrada.' });
  const venc = l.proximo_vencimento ? new Date(L.diaISO(l.proximo_vencimento) + 'T00:00:00-03:00') : new Date();
  const dias = Math.round((venc.getTime() - Date.now()) / L.DIA);
  res.json({ ok: true, canais: await LEM.enviar({ ...l, proximo_vencimento: l.proximo_vencimento || new Date() }, dias) });
}));
router.post('/lembretes/rodar', wrap(async (req, res) => { res.json(await LEM.rodar()); }));
router.delete('/maquinas/:id', wrap(async (req, res) => {
  await db.query(`UPDATE sala_maquinas SET ativa = FALSE, desativada_em = NOW(), desativada_motivo = 'admin' WHERE id = $1`, [num(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- pagamentos ----------
router.get('/pagamentos', wrap(async (req, res) => {
  res.json((await db.query(`SELECT p.*, l.sala, l.chave, c.escola FROM sala_pagamentos p JOIN sala_licencas l ON l.id = p.licenca_id JOIN sala_clientes c ON c.id = l.cliente_id ORDER BY p.id DESC LIMIT 300`)).rows);
}));

// ---------- chamados (suporte) ----------
router.get('/chamados', wrap(async (req, res) => {
  const status = req.query.status === 'fechado' ? 'fechado' : null;
  const rows = (await db.query(
    `SELECT h.*, l.sala, c.escola, c.email FROM sala_chamados h JOIN sala_licencas l ON l.id = h.licenca_id JOIN sala_clientes c ON c.id = l.cliente_id ORDER BY h.atualizado_em DESC LIMIT 200`)).rows;
  if (rows.length) { // última mensagem de cada chamado (consulta simples, sem subconsulta)
    const ms = (await db.query('SELECT chamado_id, autor, texto, id FROM sala_chamados_msgs ORDER BY id ASC')).rows;
    const ultima = new Map(); for (const m of ms) ultima.set(m.chamado_id, m);
    for (const h of rows) { const m = ultima.get(h.id); h.ultima = m ? m.texto : ''; h.ultimo_autor = m ? m.autor : ''; }
  }
  res.json(status ? rows.filter((r) => r.status === status) : rows);
}));
router.get('/chamados/:id', wrap(async (req, res) => {
  const h = (await db.query(`SELECT h.*, l.sala, c.escola, c.email, c.telefone FROM sala_chamados h JOIN sala_licencas l ON l.id = h.licenca_id JOIN sala_clientes c ON c.id = l.cliente_id WHERE h.id = $1`, [num(req.params.id)])).rows[0];
  if (!h) return res.status(404).json({ error: 'Chamado não encontrado.' });
  h.mensagens = (await db.query(`SELECT * FROM sala_chamados_msgs WHERE chamado_id = $1 ORDER BY id ASC`, [h.id])).rows;
  res.json(h);
}));
router.post('/chamados/:id/responder', wrap(async (req, res) => {
  const b = req.body || {}; const msg = texto(b.texto, 4000);
  const h = (await db.query(`SELECT h.*, l.sala, c.escola, c.email FROM sala_chamados h JOIN sala_licencas l ON l.id = h.licenca_id JOIN sala_clientes c ON c.id = l.cliente_id WHERE h.id = $1`, [num(req.params.id)])).rows[0];
  if (!h) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (msg) {
    await db.query(`INSERT INTO sala_chamados_msgs (chamado_id, autor, texto, lida_cliente) VALUES ($1,'f5',$2,FALSE)`, [h.id, msg]);
    L.enviarEmail({ to: h.email, subject: `Resposta do suporte do F5 Sala: ${h.assunto}`, html: L.caixaEmail('Resposta do suporte', `<p style="white-space:pre-wrap">${L.escapar(msg)}</p><p style="color:#64748b">Você também vê esta resposta dentro do F5 Sala (Suporte).</p>`), text: msg }).catch(() => {});
  }
  await db.query(`UPDATE sala_chamados SET status = $1, atualizado_em = NOW() WHERE id = $2`, [b.fechar ? 'fechado' : 'respondido', h.id]);
  res.json({ ok: true });
}));

// ---------- configurações ----------
const CHAVES_CONFIG = ['download_url', 'download_r2_key', 'preco_mensal', 'preco_anual'];
// Envio do instalador direto para o armazenamento (R2): devolve um endereço temporário de envio (PUT) e a chave do arquivo
router.post('/instalador/url', wrap(async (req, res) => {
  const r2 = require('../lib/r2');
  if (!r2.r2Configurado()) return res.status(503).json({ error: 'Armazenamento (R2) não configurado no servidor.' });
  const versao = String((req.body || {}).versao || '').replace(/[^0-9A-Za-z._-]/g, '').slice(0, 20) || 'atual';
  const key = `sala/instalador/F5-Sala-Setup-${versao}.exe`;
  res.json({ ok: true, key, url: r2.presignPut(key, 3600) });
}));
router.get('/config', wrap(async (req, res) => {
  const p = await L.precos();
  res.json({ download_url: await lerConfig('download_url', ''), download_r2_key: await lerConfig('download_r2_key', ''), r2: require('../lib/r2').r2Configurado(), preco_mensal: p.mensal, preco_anual: p.anual, demo_dias: L.DEMO_DIAS, limite_alunos: L.LIMITE_PADRAO, mercado_pago: !!process.env.MERCADOPAGO_ACCESS_TOKEN, resend: !!process.env.RESEND_API_KEY, whatsapp: !!process.env.EVOLUTION_API_KEY });
}));
router.put('/config', wrap(async (req, res) => {
  const b = req.body || {};
  for (const k of CHAVES_CONFIG) {
    if (b[k] === undefined) continue;
    if (k === 'download_url' && b[k] && !/^https:\/\/[^\s]+$/.test(String(b[k]))) return res.status(400).json({ error: 'O endereço do download precisa começar com https://' });
    if (k === 'download_r2_key' && b[k] && !/^sala\/instalador\/[A-Za-z0-9._-]+$/.test(String(b[k]))) return res.status(400).json({ error: 'Arquivo do instalador inválido.' });
    if (k.startsWith('preco_') && !(Number(b[k]) > 0)) return res.status(400).json({ error: 'Preço inválido.' });
    await gravarConfig(k, b[k]);
  }
  res.json({ ok: true });
}));

module.exports = router;
