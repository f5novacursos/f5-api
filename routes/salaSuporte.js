// F5 Sala — suporte dentro do programa (substitui o WhatsApp). Base: /api/sala/suporte
// O professor escreve no programa; a mensagem aparece em admin → F5 Sala → Chamados; a resposta volta para o programa (e por e-mail ao responsável).
// Só quem tem uma chave válida E um computador de professor registrado nessa chave consegue escrever (evita spam).
const express = require('express');
const db = require('../db');
const router = express.Router();
const { garantirTabelas, normalizarChave } = require('../lib/salaDb');
const L = require('../lib/salaLicenca');

router.use(async (req, res, next) => { try { await garantirTabelas(); next(); } catch (e) { res.status(503).json({ error: 'Suporte indisponível no momento.' }); } });

const texto = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const TIPOS = new Set(['duvida', 'sugestao', 'problema', 'outro']);
const AVISO_EMAIL = process.env.SALA_SUPORTE_EMAIL || 'f5novacursos@gmail.com';

async function validar(req, res) {
  const b = req.body || {};
  if (!L.limitar('sup:' + req.ip, 60, 3600000)) { res.status(429).json({ error: 'Muitas mensagens. Tente de novo daqui a pouco.' }); return null; }
  const { rows } = await db.query(
    `SELECT l.*, c.escola, c.email FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id WHERE l.chave = $1`, [normalizarChave(b.chave)]);
  if (!rows.length) { res.status(404).json({ error: 'Chave não encontrada.' }); return null; }
  const m = await db.query(`SELECT id FROM sala_maquinas WHERE licenca_id = $1 AND tipo = 'professor' AND hash = $2 LIMIT 1`, [rows[0].id, texto(b.hash, 80)]);
  if (!m.rows.length) { res.status(403).json({ error: 'Este computador não está ativado nesta licença.' }); return null; }
  return rows[0];
}

// POST /novo { chave, hash, tipo, assunto, mensagem, professor, versao }
router.post('/novo', async (req, res) => {
  const lic = await validar(req, res); if (!lic) return;
  const b = req.body; const msg = texto(b.mensagem, 4000);
  if (msg.length < 3) return res.status(400).json({ error: 'Escreva a sua mensagem.' });
  const tipo = TIPOS.has(b.tipo) ? b.tipo : 'duvida';
  const assunto = texto(b.assunto, 160) || msg.slice(0, 60);
  const c = await db.query(`INSERT INTO sala_chamados (licenca_id, tipo, assunto, professor, versao) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [lic.id, tipo, assunto, texto(b.professor, 120) || null, texto(b.versao, 20) || null]);
  await db.query(`INSERT INTO sala_chamados_msgs (chamado_id, autor, texto, lida_cliente) VALUES ($1,'cliente',$2,TRUE)`, [c.rows[0].id, msg]);
  L.enviarEmail({
    to: AVISO_EMAIL, subject: `[F5 Sala] ${tipo}: ${assunto} — ${lic.escola}`,
    html: L.caixaEmail('Novo chamado do F5 Sala', `<p><b>${L.escapar(lic.escola)}</b> · sala ${L.escapar(lic.sala)} · professor ${L.escapar(b.professor || '?')} · versão ${L.escapar(b.versao || '?')}</p><p style="white-space:pre-wrap">${L.escapar(msg)}</p><p>Responda em admin → F5 Sala → Chamados.</p>`),
    text: `${lic.escola} (${lic.sala}): ${msg}`,
  }).catch(() => {});
  res.status(201).json({ ok: true, id: c.rows[0].id, prazo: 'Respondemos em até 24 horas.' });
});

// POST /lista { chave, hash } → { chamados: [{ id, tipo, assunto, status, criado_em, mensagens: [...] }], nao_lidas }
router.post('/lista', async (req, res) => {
  const lic = await validar(req, res); if (!lic) return;
  const cs = (await db.query(`SELECT id, tipo, assunto, status, criado_em, atualizado_em FROM sala_chamados WHERE licenca_id = $1 ORDER BY atualizado_em DESC LIMIT 50`, [lic.id])).rows;
  let naoLidas = 0;
  for (const c of cs) {
    c.mensagens = (await db.query(`SELECT autor, texto, criado_em, lida_cliente FROM sala_chamados_msgs WHERE chamado_id = $1 ORDER BY id ASC`, [c.id])).rows;
    naoLidas += c.mensagens.filter((m) => m.autor === 'f5' && !m.lida_cliente).length;
  }
  if (req.body.marcar_lido === true) await db.query(`UPDATE sala_chamados_msgs SET lida_cliente = TRUE WHERE autor = 'f5' AND lida_cliente = FALSE AND chamado_id IN (SELECT id FROM sala_chamados WHERE licenca_id = $1)`, [lic.id]);
  res.json({ ok: true, chamados: cs, nao_lidas: naoLidas });
});

// POST /responder { chave, hash, chamado_id, mensagem }
router.post('/responder', async (req, res) => {
  const lic = await validar(req, res); if (!lic) return;
  const msg = texto(req.body.mensagem, 4000);
  if (msg.length < 2) return res.status(400).json({ error: 'Escreva a sua mensagem.' });
  const c = await db.query(`SELECT id, assunto FROM sala_chamados WHERE id = $1 AND licenca_id = $2`, [Number(req.body.chamado_id) || 0, lic.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Chamado não encontrado.' });
  await db.query(`INSERT INTO sala_chamados_msgs (chamado_id, autor, texto, lida_cliente) VALUES ($1,'cliente',$2,TRUE)`, [c.rows[0].id, msg]);
  await db.query(`UPDATE sala_chamados SET status = 'aberto', atualizado_em = NOW() WHERE id = $1`, [c.rows[0].id]);
  L.enviarEmail({ to: AVISO_EMAIL, subject: `[F5 Sala] Resposta: ${c.rows[0].assunto} — ${lic.escola}`, html: L.caixaEmail('Resposta no chamado', `<p><b>${L.escapar(lic.escola)}</b> (${L.escapar(lic.sala)})</p><p style="white-space:pre-wrap">${L.escapar(msg)}</p>`), text: msg }).catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
