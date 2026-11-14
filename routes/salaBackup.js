// F5 Sala — backup dos dados do professor enviado por e-mail (Resend).
// Segurança: ninguém consegue mandar e-mail para um endereço que não é seu. Primeiro o programa pede um CÓDIGO de 6 dígitos
// (enviado para o e-mail do professor); só com o código certo o backup é enviado — sempre para esse mesmo e-mail.
// Estado fica em memória (códigos valem 15 min; reiniciar o servidor só obriga a pedir um código novo). Sem banco de dados.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails'; // RESEND_URL só existe para testes locais
const RESEND_FROM = process.env.RESEND_FROM || 'F5 Nova Cursos <nao-responder@f5novacursos.com.br>';
const SEGREDO = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const CODIGO_MINUTOS = 15;
const MAX_TENTATIVAS = 5;
const MAX_ENVIOS_POR_CODIGO = 5;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB já decodificado (um backup típico tem poucas dezenas de KB)

const codigos = new Map(); // e-mail -> { hash, expira, tentativas, envios }
const marcas = new Map(); // chave de limite -> [horários]

function limitar(chave, max, janelaMs) {
  const agora = Date.now();
  const lista = (marcas.get(chave) || []).filter((t) => agora - t < janelaMs);
  if (lista.length >= max) { marcas.set(chave, lista); return false; }
  lista.push(agora);
  marcas.set(chave, lista);
  return true;
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of codigos) if (v.expira < agora) codigos.delete(k);
  for (const [k, v] of marcas) { const f = v.filter((t) => agora - t < 3600000); if (f.length) marcas.set(k, f); else marcas.delete(k); }
}, 10 * 60 * 1000).unref();

const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const normalizar = (e) => String(e || '').trim().toLowerCase();
const hash = (email, codigo) => crypto.createHmac('sha256', SEGREDO).update(email + ':' + codigo).digest('hex');
const escapar = (s) => String(s).replace(/[<>&"']/g, '');

async function enviarResend(corpo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, ...corpo }),
      signal: controller.signal,
    });
    if (!r.ok) { const d = await r.text().catch(() => ''); throw new Error('Resend ' + r.status + ' ' + d.slice(0, 200)); }
  } finally { clearTimeout(timeout); }
}

// POST /api/sala/codigo  { email, nome }  → manda um código de 6 dígitos para o e-mail
router.post('/codigo', async (req, res) => {
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'O envio por e-mail ainda não está disponível. Salve o backup em arquivo.' });
  const email = normalizar(req.body && req.body.email);
  const nome = String((req.body && req.body.nome) || '').split(' ')[0].slice(0, 40) || 'professor';
  if (!emailOk(email)) return res.status(400).json({ error: 'Digite um e-mail válido.' });
  if (!limitar('cod-ip:' + req.ip, 10, 3600000) || !limitar('cod-em:' + email, 3, 3600000)) {
    return res.status(429).json({ error: 'Muitos pedidos de código. Tente de novo daqui a pouco.' });
  }
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  codigos.set(email, { hash: hash(email, codigo), expira: Date.now() + CODIGO_MINUTOS * 60000, tentativas: 0, envios: 0 });
  try {
    await enviarResend({
      to: [email],
      subject: 'Seu código para enviar o backup do F5 Sala',
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0a1628"><h2>Olá, ${escapar(nome)}!</h2><p>Use o código abaixo no F5 Sala para enviar o backup dos seus dados para este e-mail. Ele vale por <strong>${CODIGO_MINUTOS} minutos</strong>.</p><p style="font-size:34px;letter-spacing:8px;font-weight:bold;background:#f4f6fa;padding:16px;text-align:center;border-radius:10px">${codigo}</p><p style="color:#666;font-size:13px">Se você não pediu isso, ignore este e-mail.</p></div>`,
      text: `Código do F5 Sala: ${codigo}. Vale por ${CODIGO_MINUTOS} minutos. Se você não pediu, ignore este e-mail.`,
    });
  } catch (e) {
    codigos.delete(email);
    console.error('[sala] falha ao enviar código:', e.message);
    return res.status(502).json({ error: 'Não consegui enviar o e-mail agora. Tente de novo em instantes.' });
  }
  res.json({ ok: true, minutos: CODIGO_MINUTOS });
});

// POST /api/sala/backup  { email, codigo, nome, arquivo: { nome, base64 } }  → manda o backup anexado, só para o próprio e-mail
router.post('/backup', async (req, res) => {
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'O envio por e-mail ainda não está disponível. Salve o backup em arquivo.' });
  const b = req.body || {};
  const email = normalizar(b.email);
  const codigo = String(b.codigo || '').replace(/\D/g, '');
  if (!emailOk(email) || codigo.length !== 6) return res.status(400).json({ error: 'Informe o e-mail e o código de 6 dígitos.' });
  if (!limitar('bk-ip:' + req.ip, 30, 3600000)) return res.status(429).json({ error: 'Muitos envios. Tente de novo daqui a pouco.' });
  const c = codigos.get(email);
  if (!c || c.expira < Date.now()) return res.status(400).json({ error: 'O código expirou ou não foi pedido. Peça um código novo.' });
  if (c.tentativas >= MAX_TENTATIVAS) { codigos.delete(email); return res.status(429).json({ error: 'Muitas tentativas. Peça um código novo.' }); }
  const esperado = Buffer.from(c.hash, 'hex'); const recebido = Buffer.from(hash(email, codigo), 'hex');
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) {
    c.tentativas++;
    return res.status(400).json({ error: 'Código incorreto.' });
  }
  if (c.envios >= MAX_ENVIOS_POR_CODIGO) return res.status(429).json({ error: 'Limite de envios deste código atingido. Peça um código novo.' });

  const arq = b.arquivo || {};
  const base64 = String(arq.base64 || '');
  if (!base64 || base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return res.status(413).json({ error: 'O arquivo é grande demais para enviar por e-mail.' });
  let texto;
  try { texto = Buffer.from(base64, 'base64').toString('utf8'); } catch { return res.status(400).json({ error: 'Arquivo inválido.' }); }
  if (Buffer.byteLength(texto, 'utf8') > MAX_BYTES) return res.status(413).json({ error: 'O arquivo é grande demais para enviar por e-mail.' });
  let conteudo;
  try { conteudo = JSON.parse(texto); } catch { return res.status(400).json({ error: 'Este arquivo não é um backup do F5 Sala.' }); }
  if (!conteudo || (conteudo.app !== 'f5sala-backup' && conteudo.app !== 'f5sala-atividade')) return res.status(400).json({ error: 'Este arquivo não é um backup do F5 Sala.' });

  const ext = conteudo.app === 'f5sala-atividade' ? 'f5sala' : 'f5backup';
  const base = String(arq.nome || 'Backup F5 Sala').replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^\.+/, '').slice(0, 80).trim() || 'Backup F5 Sala';
  const nome = String(b.nome || '').split(' ')[0].slice(0, 40) || 'professor';
  try {
    await enviarResend({
      to: [email],
      subject: 'Backup dos seus dados do F5 Sala',
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0a1628"><h2>Olá, ${escapar(nome)}!</h2><p>Segue em anexo o backup dos seus dados do F5 Sala (turmas, provas, listas e modelos).</p><p><strong>Guarde este e-mail.</strong> Para recuperar tudo em outro computador: instale o F5 Sala, entre com este e-mail, baixe o anexo e use <em>Ajustes → Restaurar um backup</em>.</p><p style="color:#666;font-size:13px">O arquivo contém nomes e e-mails dos seus alunos: não compartilhe com quem não deve ter acesso.</p></div>`,
      text: 'Backup dos seus dados do F5 Sala em anexo. Para recuperar: instale o F5 Sala, entre com este e-mail e use Ajustes > Restaurar um backup.',
      attachments: [{ filename: `${base}.${ext}`, content: base64 }],
    });
  } catch (e) {
    console.error('[sala] falha ao enviar backup:', e.message);
    return res.status(502).json({ error: 'Não consegui enviar o e-mail agora. Tente de novo em instantes.' });
  }
  c.envios++;
  res.json({ ok: true });
});

module.exports = router;
