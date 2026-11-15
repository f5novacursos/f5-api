// F5 Sala — rotas PÚBLICAS usadas pelo programa (ativar, recibo, mover de computador, demonstração, download).
// Base: /api/sala/licenca/*   (quem prova que é o dono é a CHAVE; mover de computador exige código no e-mail do responsável da escola)
const express = require('express');
const db = require('../db');
const router = express.Router();
const { garantirTabelas, lerConfig, novaChave, novoToken, normalizarChave } = require('../lib/salaDb');
const L = require('../lib/salaLicenca');

router.use(async (req, res, next) => { try { await garantirTabelas(); next(); } catch (e) { res.status(503).json({ error: 'Sistema de licenças indisponível no momento.' }); } });

const hashOk = (h) => /^[a-f0-9]{16,80}$/i.test(String(h || ''));
const texto = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

async function achar(chaveBruta) {
  const chave = normalizarChave(chaveBruta);
  if (!/^F5S-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(chave)) return null;
  const { rows } = await db.query(
    `SELECT l.*, c.escola, c.email AS cliente_email, c.site, c.instagram, c.responsavel, c.id AS cliente_id_real
       FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.chave = $1`, [chave]);
  if (!rows.length) return null;
  const r = rows[0];
  return { lic: r, cliente: { escola: r.escola, email: r.cliente_email, site: r.site, instagram: r.instagram, responsavel: r.responsavel } };
}
const limiteIp = (req, nome, max = 30) => L.limitar(`${nome}:${req.ip}`, max, 3600000);

// GET /api/sala/licenca/chave-publica → { pem }
router.get('/chave-publica', async (req, res) => { res.json({ pem: await L.chavePublica() }); });

// GET /api/sala/licenca/planos → preços atuais (para a tela de "Licença e plano")
router.get('/planos', async (req, res) => { res.json({ ...(await L.precos()), limite_alunos: L.LIMITE_PADRAO, demo_dias: L.DEMO_DIAS, demo_alunos: L.DEMO_ALUNOS }); });

// POST /api/sala/licenca/ativar { chave, maquina: { hash, nome, versao } }
router.post('/ativar', async (req, res) => {
  if (!limiteIp(req, 'ativar', 40)) return res.status(429).json({ error: 'Muitas tentativas. Tente de novo daqui a pouco.' });
  const b = req.body || {}; const m = b.maquina || {};
  if (!hashOk(m.hash)) return res.status(400).json({ error: 'Não consegui identificar este computador.' });
  const a = await achar(b.chave);
  if (!a) return res.status(404).json({ error: 'Chave não encontrada. Confira se digitou igual ao e-mail que você recebeu.', codigo: 'chave_invalida' });
  const { lic, cliente } = a;
  if (lic.status === 'suspenso' || lic.status === 'cancelado') return res.status(403).json({ error: 'Esta licença está suspensa. Fale com o suporte.', codigo: 'suspensa' });

  // a demonstração é uma por computador de professor
  if (lic.plano === 'demo') {
    const outra = await db.query(
      `SELECT 1 FROM sala_maquinas m JOIN sala_licencas l ON l.id = m.licenca_id WHERE m.hash = $1 AND m.tipo = 'professor' AND l.plano = 'demo' AND l.id <> $2 LIMIT 1`, [m.hash, lic.id]);
    if (outra.rows.length) return res.status(409).json({ error: 'Este computador já usou uma demonstração. Para continuar, contrate uma licença.', codigo: 'demo_ja_usada' });
  }

  const nome = texto(m.nome, 120); const versao = texto(m.versao, 20);
  const mesma = await db.query(`SELECT id, ativa FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND hash = $2 ORDER BY id DESC LIMIT 1`, [lic.id, m.hash]);
  if (mesma.rows.length) {
    await db.query(`UPDATE sala_maquinas SET ativa = TRUE, desativada_em = NULL, desativada_motivo = NULL, ultimo_visto = NOW(), nome = $1, versao = $2 WHERE id = $3`, [nome, versao, mesma.rows[0].id]);
    return res.json({ ok: true, ...(await L.recibo(lic, cliente)) });
  }
  const ativas = await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND ativa = TRUE`, [lic.id]);
  if (ativas.rows[0].n >= lic.max_maquinas) {
    return res.status(409).json({ error: 'Esta chave já está ativa em outro computador. Para usar neste, peça para mover a licença (um código vai para o e-mail do responsável da escola).', codigo: 'em_uso', email: L.mascararEmail(cliente.email) });
  }
  await db.query(`INSERT INTO sala_maquinas (licenca_id, tipo, hash, nome, versao) VALUES ($1,'professor',$2,$3,$4)`, [lic.id, m.hash, nome, versao]);
  res.json({ ok: true, ...(await L.recibo(lic, cliente)) });
});

// POST /api/sala/licenca/recibo { chave, maquina: { hash, versao }, alunos: [hash...], professores: [{nome,email}] }  (batimento)
router.post('/recibo', async (req, res) => {
  if (!limiteIp(req, 'recibo', 200)) return res.status(429).json({ error: 'Muitas consultas.' });
  const b = req.body || {}; const m = b.maquina || {};
  if (!hashOk(m.hash)) return res.status(400).json({ error: 'Computador não identificado.' });
  const a = await achar(b.chave);
  if (!a) return res.status(404).json({ error: 'Chave não encontrada.', codigo: 'chave_invalida' });
  const { lic, cliente } = a;
  const mq = await db.query(`SELECT id, ativa FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND hash = $2 ORDER BY id DESC LIMIT 1`, [lic.id, m.hash]);
  if (!mq.rows.length || !mq.rows[0].ativa) return res.status(403).json({ error: 'Esta licença foi movida para outro computador.', codigo: 'maquina_desativada' });
  await db.query(`UPDATE sala_maquinas SET ultimo_visto = NOW(), versao = $1 WHERE id = $2`, [texto(m.versao, 20), mq.rows[0].id]);

  // computadores de aluno vistos (só o identificador técnico, sem nome de pessoa)
  const alunos = (Array.isArray(b.alunos) ? b.alunos : []).filter(hashOk).slice(0, 300);
  for (const h of alunos) {
    const ja = await db.query(`SELECT id FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'aluno' AND hash = $2 LIMIT 1`, [lic.id, h]);
    if (ja.rows.length) await db.query(`UPDATE sala_maquinas SET ultimo_visto = NOW(), ativa = TRUE WHERE id = $1`, [ja.rows[0].id]);
    else await db.query(`INSERT INTO sala_maquinas (licenca_id, tipo, hash) VALUES ($1,'aluno',$2)`, [lic.id, h]);
  }
  for (const p of (Array.isArray(b.professores) ? b.professores : []).slice(0, 40)) {
    const nome = texto(p && p.nome, 120); if (!nome) continue;
    await db.query(`INSERT INTO sala_professores (licenca_id, nome, email) VALUES ($1,$2,$3) ON CONFLICT (licenca_id, nome) DO UPDATE SET email = COALESCE(EXCLUDED.email, sala_professores.email), ultimo_visto = NOW()`, [lic.id, nome, texto(p.email, 254) || null]);
  }
  const desde = new Date(Date.now() - 30 * L.DIA);
  const usados = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'aluno' AND ultimo_visto >= $2`, [lic.id, desde])).rows[0].n;
  const sit = L.situacao(lic);
  if (usados > sit.limite && sit.limite > 0) await db.query(`UPDATE sala_licencas SET excedeu_em = NOW() WHERE id = $1`, [lic.id]);
  res.json({ ok: true, ...(await L.recibo(lic, cliente, { alunos_usados: usados })) });
});

// POST /api/sala/licenca/mover/pedir { chave } → manda um código para o e-mail do RESPONSÁVEL da escola
router.post('/mover/pedir', async (req, res) => {
  const a = await achar((req.body || {}).chave);
  if (!limiteIp(req, 'mover', 10)) return res.status(429).json({ error: 'Muitos pedidos. Tente de novo daqui a pouco.' });
  if (!a) return res.status(404).json({ error: 'Chave não encontrada.', codigo: 'chave_invalida' });
  const email = L.normalizarEmail(a.cliente.email);
  if (!L.limitar('mover-em:' + email, 3, 3600000)) return res.status(429).json({ error: 'Muitos pedidos de código. Tente de novo daqui a pouco.' });
  const codigo = await L.criarCodigo(email, 'mover');
  const ok = await L.enviarEmail({
    to: email, subject: 'Código para mover a licença do F5 Sala',
    html: L.caixaEmail('Mover a licença do F5 Sala', `<p>Alguém pediu para usar a licença da sala <b>${L.escapar(a.lic.sala)}</b> (${L.escapar(a.cliente.escola)}) em um novo computador.</p><p>Se foi você ou alguém da sua escola, informe este código no F5 Sala:</p><p style="font-size:34px;letter-spacing:6px;font-weight:700;margin:14px 0">${codigo}</p><p>Vale por 15 minutos. Ao confirmar, o computador antigo deixa de usar a licença. Se não foi você, ignore este e-mail.</p>`),
    text: `Código para mover a licença do F5 Sala (${a.lic.sala}): ${codigo}. Vale por 15 minutos.`,
  });
  if (!ok) return res.status(502).json({ error: 'Não consegui enviar o e-mail agora. Tente de novo em instantes.' });
  res.json({ ok: true, email: L.mascararEmail(email), minutos: 15 });
});

// POST /api/sala/licenca/mover/confirmar { chave, codigo, maquina: { hash, nome, versao } }
router.post('/mover/confirmar', async (req, res) => {
  const b = req.body || {}; const m = b.maquina || {};
  if (!limiteIp(req, 'mover-c', 20)) return res.status(429).json({ error: 'Muitas tentativas.' });
  if (!hashOk(m.hash)) return res.status(400).json({ error: 'Não consegui identificar este computador.' });
  const a = await achar(b.chave);
  if (!a) return res.status(404).json({ error: 'Chave não encontrada.', codigo: 'chave_invalida' });
  const { lic, cliente } = a;
  if (lic.status === 'suspenso' || lic.status === 'cancelado') return res.status(403).json({ error: 'Esta licença está suspensa. Fale com o suporte.', codigo: 'suspensa' });
  const c = await L.conferirCodigo(L.normalizarEmail(cliente.email), 'mover', b.codigo);
  if (!c.ok) return res.status(400).json({ error: c.erro });
  const desde = new Date(Date.now() - 365 * L.DIA);
  const trocas = (await db.query(`SELECT COUNT(*)::int AS n FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND desativada_motivo = 'mover' AND desativada_em >= $2`, [lic.id, desde])).rows[0].n;
  const ja = await db.query(`SELECT id FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND hash = $2 ORDER BY id DESC LIMIT 1`, [lic.id, m.hash]);
  if (trocas >= L.TROCAS_POR_ANO && !ja.rows.length) return res.status(429).json({ error: 'O limite de trocas de computador deste ano foi atingido. Fale com o suporte.', codigo: 'limite_trocas' });
  await db.query(`UPDATE sala_maquinas SET ativa = FALSE, desativada_em = NOW(), desativada_motivo = 'mover' WHERE licenca_id = $1 AND tipo = 'professor' AND ativa = TRUE AND hash <> $2`, [lic.id, m.hash]);
  if (ja.rows.length) await db.query(`UPDATE sala_maquinas SET ativa = TRUE, desativada_em = NULL, desativada_motivo = NULL, ultimo_visto = NOW(), nome = $1, versao = $2 WHERE id = $3`, [texto(m.nome, 120), texto(m.versao, 20), ja.rows[0].id]);
  else await db.query(`INSERT INTO sala_maquinas (licenca_id, tipo, hash, nome, versao) VALUES ($1,'professor',$2,$3,$4)`, [lic.id, m.hash, texto(m.nome, 120), texto(m.versao, 20)]);
  res.json({ ok: true, ...(await L.recibo(lic, cliente)) });
});

// ---------- demonstração ----------
// POST /api/sala/licenca/demo/pedir { escola, responsavel, email, telefone }  → manda código ao e-mail
router.post('/demo/pedir', async (req, res) => {
  const b = req.body || {};
  const email = L.normalizarEmail(b.email); const escola = texto(b.escola, 160); const responsavel = texto(b.responsavel, 160);
  const telefone = L.telefoneBR(b.telefone);
  if (!escola || !responsavel) return res.status(400).json({ error: 'Informe o nome da escola e o seu nome.' });
  if (!L.emailOk(email)) return res.status(400).json({ error: 'Digite um e-mail válido.' });
  if (!telefone) return res.status(400).json({ error: 'Digite um WhatsApp válido, com DDD.' });
  if (b.aceite !== true) return res.status(400).json({ error: 'Para continuar, aceite receber avisos do F5 Sala por e-mail e WhatsApp.' });
  if (!limiteIp(req, 'demo', 8) || !L.limitar('demo-em:' + email, 3, 3600000)) return res.status(429).json({ error: 'Muitos pedidos. Tente de novo daqui a pouco.' });
  const codigo = await L.criarCodigo(email, 'demo', { escola, responsavel, telefone, site: texto(b.site, 200), instagram: texto(b.instagram, 200) });
  const ok = await L.enviarEmail({
    to: email, subject: 'Seu código para testar o F5 Sala',
    html: L.caixaEmail(`Olá, ${L.escapar(responsavel.split(' ')[0])}!`, `<p>Use o código abaixo para liberar a demonstração do F5 Sala:</p><p style="font-size:34px;letter-spacing:6px;font-weight:700;margin:14px 0">${codigo}</p><p>Vale por 15 minutos. Se você não pediu, ignore este e-mail.</p>`),
    text: `Código do F5 Sala: ${codigo}. Vale por 15 minutos.`,
  });
  if (!ok) return res.status(502).json({ error: 'Não consegui enviar o e-mail agora. Tente de novo em instantes.' });
  res.json({ ok: true, minutos: 15 });
});

// POST /api/sala/licenca/demo/confirmar { email, codigo }  → cria escola + chave de demonstração e manda por e-mail
router.post('/demo/confirmar', async (req, res) => {
  const b = req.body || {}; const email = L.normalizarEmail(b.email);
  if (!limiteIp(req, 'demo-c', 15)) return res.status(429).json({ error: 'Muitas tentativas.' });
  const c = await L.conferirCodigo(email, 'demo', b.codigo);
  if (!c.ok) return res.status(400).json({ error: c.erro });
  const d = c.dados || {};
  // já existe cadastro com este e-mail? então devolve a MESMA chave (não cria outra demonstração)
  const ex = await db.query(`SELECT l.* FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE c.email = $1 ORDER BY l.id ASC LIMIT 1`, [email]);
  let chave;
  if (ex.rows.length) chave = ex.rows[0].chave;
  else {
    const cl = await db.query(
      `INSERT INTO sala_clientes (escola, responsavel, email, telefone, site, instagram, origem, aceite_avisos) VALUES ($1,$2,$3,$4,$5,$6,'site',TRUE) RETURNING id`,
      [texto(d.escola, 160), texto(d.responsavel, 160), email, d.telefone || null, texto(d.site, 200) || null, texto(d.instagram, 200) || null]);
    chave = novaChave();
    await db.query(
      `INSERT INTO sala_licencas (cliente_id, chave, token_pagamento, sala, plano, ciclo, valor, limite_alunos, max_maquinas, status, demo_ate)
       VALUES ($1,$2,$3,$4,'demo','mensal',0,$5,1,'ativo',$6)`,
      [cl.rows[0].id, chave, novoToken(), 'Demonstração', L.DEMO_ALUNOS, L.somarDias(new Date(), L.DEMO_DIAS)]);
  }
  const download = (process.env.SALA_PUBLIC_URL || 'https://api.f5novacursos.com.br') + '/api/sala/licenca/download';
  await require('../lib/salaEmails').entrega({ cliente: { escola: texto(d.escola, 160), email, responsavel: texto(d.responsavel, 160) }, lic: { chave, sala: 'Demonstração' }, demo: true });
  res.json({ ok: true, chave, download });
});

// GET /api/sala/licenca/download → leva para o instalador (endereço configurado em admin → F5 Sala → Configurações)
router.get('/download', async (req, res) => {
  const r2 = require('../lib/r2'); const chaveR2 = await lerConfig('download_r2_key', '');
  if (chaveR2 && r2.r2Configurado()) { try { return res.redirect(302, r2.presignGet(chaveR2, 900)); } catch (e) { console.error('[sala] download R2:', e.message); } }
  const url = await lerConfig('download_url', '');
  if (!/^https:\/\//.test(url)) return res.status(404).json({ error: 'O download ainda não foi publicado.' });
  res.redirect(302, url);
});

module.exports = router;
