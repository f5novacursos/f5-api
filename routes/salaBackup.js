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

// ---------------------------------------------------------------------------------------------------------------------------------
// BACKUP SEMANAL AUTOMÁTICO: o professor confirma o e-mail UMA vez com o código e recebe uma AUTORIZAÇÃO (token assinado, 400 dias)
// que só vale para aquele e-mail. Com ela o programa manda o backup toda semana sem pedir código. Mesmo roubada, a autorização só
// consegue mandar e-mail para o próprio dono do endereço (e no máximo 3 por dia). Não há banco de dados: o token é verificável pela assinatura.
const AUTORIZACAO_DIAS = 400;
const MAX_AUTO_POR_DIA = 3;
const assinarAuto = (email, exp) => crypto.createHmac('sha256', SEGREDO).update('auto:' + email + '|' + exp).digest('hex');
function criarToken(email) {
  const exp = Date.now() + AUTORIZACAO_DIAS * 86400000;
  return Buffer.from(email + '|' + exp).toString('base64url') + '.' + assinarAuto(email, exp);
}
function lerToken(token, email) { // devolve true se o token é válido, não expirou e é deste e-mail
  const partes = String(token || '').split('.');
  if (partes.length !== 2) return false;
  let texto; try { texto = Buffer.from(partes[0], 'base64url').toString('utf8'); } catch { return false; }
  const i = texto.lastIndexOf('|'); if (i < 1) return false;
  const emTok = texto.slice(0, i); const exp = Number(texto.slice(i + 1));
  if (emTok !== email || !Number.isFinite(exp) || exp < Date.now()) return false;
  const esperado = Buffer.from(assinarAuto(emTok, exp), 'hex'); const recebido = Buffer.from(partes[1], 'hex');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}
// valida o arquivo de backup enviado (base64 de um JSON "f5sala-backup"); devolve { erro, status } ou { base64, ext, base }
function lerArquivoBackup(arq) {
  const a = arq || {}; const base64 = String(a.base64 || '');
  if (!base64 || base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return { status: 413, erro: 'O arquivo é grande demais para enviar por e-mail.' };
  let texto; try { texto = Buffer.from(base64, 'base64').toString('utf8'); } catch { return { status: 400, erro: 'Arquivo inválido.' }; }
  if (Buffer.byteLength(texto, 'utf8') > MAX_BYTES) return { status: 413, erro: 'O arquivo é grande demais para enviar por e-mail.' };
  let conteudo; try { conteudo = JSON.parse(texto); } catch { return { status: 400, erro: 'Este arquivo não é um backup do F5 Sala.' }; }
  if (!conteudo || conteudo.app !== 'f5sala-backup') return { status: 400, erro: 'Este arquivo não é um backup do F5 Sala.' };
  const base = String(a.nome || 'Backup F5 Sala').replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^\.+/, '').slice(0, 80).trim() || 'Backup F5 Sala';
  return { base64, ext: 'f5backup', base };
}

// POST /api/sala/backup-autorizar  { email, codigo }  → confere o código e devolve a autorização do envio semanal
router.post('/backup-autorizar', (req, res) => {
  const b = req.body || {};
  const email = normalizar(b.email);
  const codigo = String(b.codigo || '').replace(/\D/g, '');
  if (!emailOk(email) || codigo.length !== 6) return res.status(400).json({ error: 'Informe o e-mail e o código de 6 dígitos.' });
  if (!limitar('aut-ip:' + req.ip, 30, 3600000)) return res.status(429).json({ error: 'Muitas tentativas. Tente de novo daqui a pouco.' });
  const c = codigos.get(email);
  if (!c || c.expira < Date.now()) return res.status(400).json({ error: 'O código expirou ou não foi pedido. Peça um código novo.' });
  if (c.tentativas >= MAX_TENTATIVAS) { codigos.delete(email); return res.status(429).json({ error: 'Muitas tentativas. Peça um código novo.' }); }
  const esperado = Buffer.from(c.hash, 'hex'); const recebido = Buffer.from(hash(email, codigo), 'hex');
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) { c.tentativas++; return res.status(400).json({ error: 'Código incorreto.' }); }
  codigos.delete(email); // o código vale uma vez só
  res.json({ ok: true, token: criarToken(email), dias: AUTORIZACAO_DIAS });
});

// POST /api/sala/backup-auto  { email, token, nome, arquivo: { nome, base64 } }  → manda o backup semanal (sem código), só para o próprio e-mail
router.post('/backup-auto', async (req, res) => {
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'O envio por e-mail ainda não está disponível.' });
  const b = req.body || {};
  const email = normalizar(b.email);
  if (!emailOk(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (!limitar('auto-ip:' + req.ip, 30, 3600000)) return res.status(429).json({ error: 'Muitos envios. Tente de novo daqui a pouco.' });
  if (!lerToken(b.token, email)) return res.status(401).json({ error: 'A autorização do envio automático expirou ou não vale para este e-mail. Ative de novo na aba Backup.', reautorizar: true });
  if (!limitar('auto-em:' + email, MAX_AUTO_POR_DIA, 86400000)) return res.status(429).json({ error: 'Limite de envios por dia atingido. Tente amanhã.' });
  const a = lerArquivoBackup(b.arquivo);
  if (a.erro) return res.status(a.status).json({ error: a.erro });
  const nome = String(b.nome || '').split(' ')[0].slice(0, 40) || 'professor';
  try {
    await enviarResend({
      to: [email],
      subject: 'Backup semanal dos seus dados do F5 Sala',
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0a1628"><h2>Olá, ${escapar(nome)}!</h2><p>Este é o seu <strong>backup semanal</strong> do F5 Sala, em anexo: turmas, alunos, chamadas, provas, listas e modos de aula.</p><p><strong>Guarde este e-mail.</strong> Se você trocar de notebook ou precisar reinstalar tudo: instale o F5 Sala, cadastre-se com este e-mail e use <em>Ajustes → Backup → Restaurar um backup</em>, escolhendo o arquivo anexo.</p><p style="color:#64748b;font-size:13px">Você pode desligar o envio semanal quando quiser em Ajustes → Backup.</p></div>`,
      text: 'Backup semanal dos seus dados do F5 Sala em anexo. Para recuperar: instale o F5 Sala, cadastre-se com este e-mail e use Ajustes > Backup > Restaurar um backup.',
      attachments: [{ filename: `${a.base}.${a.ext}`, content: a.base64 }],
    });
  } catch (e) {
    console.error('[sala] falha ao enviar backup semanal:', e.message);
    return res.status(502).json({ error: 'Não consegui enviar o e-mail agora. O programa tenta de novo mais tarde.' });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// GABARITO DA PROVA POR E-MAIL: o professor (com a mesma AUTORIZAÇÃO do e-mail dele usada no backup) manda o resultado de UM aluno
// para o e-mail que o aluno digitou na prova. O modelo do e-mail é fixo: só entram os dados da prova. Limites por IP, por professor e por aluno.
const MAX_PROVA_POR_DIA = 400; // e-mails de prova por professor por dia
const MAX_PROVA_POR_ALUNO_DIA = 6; // por endereço de aluno por dia
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LETRAS_OP = 'ABCDEFGH';
const indiceOk = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : -1);

function itensDaProva(lista) {
  return (Array.isArray(lista) ? lista : []).slice(0, 100).map((i) => {
    const opcoes = (Array.isArray(i && i.opcoes) ? i.opcoes : []).slice(0, 8).map((o) => String(o == null ? '' : o).slice(0, 300));
    return { q: String((i && i.q) || '').slice(0, 500), opcoes, marcada: indiceOk(Number(i && i.marcada), opcoes.length), certa: indiceOk(Number(i && i.certa), opcoes.length) };
  }).filter((i) => i.q && i.opcoes.length >= 2 && i.certa >= 0);
}

function montarEmailProva({ titulo, nome, nota, acertos, total, mostrarNota, itens, professor }) {
  const primeiro = String(nome || '').split(' ')[0].slice(0, 40) || 'aluno';
  const caixaNota = mostrarNota ? `<div style="background:#eef4ff;border:1px solid #c7d8f5;border-radius:12px;padding:14px 18px;margin:14px 0;text-align:center"><div style="font-size:15px;color:#334155">Você acertou <b>${acertos}</b> de <b>${total}</b></div><div style="font-size:34px;font-weight:800;color:#1d4ed8">Nota ${escHtml(String(nota).replace('.', ','))}</div></div>` : '';
  let html = '';
  let texto = `Olá, ${primeiro}! Segue o gabarito da prova "${titulo}".\n`;
  if (mostrarNota) texto += `Você acertou ${acertos} de ${total}. Nota ${String(nota).replace('.', ',')}.\n`;
  itens.forEach((it, n) => {
    const certaMarcada = it.marcada === it.certa;
    html += `<div style="border:1px solid #d8dee9;border-radius:12px;padding:12px 14px;margin:12px 0"><div style="font-weight:700;margin-bottom:8px">${n + 1}. ${escHtml(it.q)}</div>`;
    texto += `\n${n + 1}) ${it.q}\n`;
    it.opcoes.forEach((op, k) => {
      let estilo = 'color:#475569'; let marca = ''; let nota2 = '';
      if (k === it.certa) { estilo = 'background:#e8f7ee;color:#14532d;font-weight:700'; marca = '✅ '; nota2 = certaMarcada ? ' — sua resposta (certa)' : ' — resposta certa'; }
      else if (k === it.marcada) { estilo = 'background:#fdecec;color:#7f1d1d;font-weight:700'; marca = '❌ '; nota2 = ' — sua resposta'; }
      html += `<div style="padding:6px 10px;border-radius:8px;margin:3px 0;${estilo}">${marca}${LETRAS_OP[k]}) ${escHtml(op)}${nota2}</div>`;
      texto += `${marca}${LETRAS_OP[k]}) ${op}${nota2}\n`;
    });
    if (it.marcada < 0) { html += '<div style="color:#92400e;font-size:13px;margin-top:6px">Você não respondeu esta questão.</div>'; texto += 'Você não respondeu esta questão.\n'; }
    html += '</div>';
  });
  const rodape = professor ? `Enviado pelo F5 Sala a pedido de ${escHtml(professor)}.` : 'Enviado pelo F5 Sala.';
  const corpo = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#0a1628"><h2 style="margin-bottom:4px">${escHtml(titulo)}</h2><p style="margin-top:0;color:#475569">Olá, ${escHtml(primeiro)}! Aqui estão as suas respostas e o gabarito da prova.</p>${caixaNota}${html}<p style="color:#64748b;font-size:12px;margin-top:18px">${rodape} Se você não esperava este e-mail, pode ignorar.</p></div>`;
  texto += `\n${professor ? 'Enviado pelo F5 Sala a pedido de ' + professor + '.' : 'Enviado pelo F5 Sala.'} Se você não esperava este e-mail, ignore.`;
  return { html: corpo, text: texto };
}

// POST /api/sala/prova-email  { email, token, professor, aluno: { email, nome }, prova: { titulo, mostrarNota, nota, acertos, total, itens: [{ q, opcoes, marcada, certa }] } }
router.post('/prova-email', async (req, res) => {
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'O envio por e-mail ainda não está disponível.' });
  const b = req.body || {};
  const prof = normalizar(b.email);
  const alunoEmail = normalizar(b.aluno && b.aluno.email);
  if (!emailOk(prof) || !emailOk(alunoEmail)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (!limitar('pv-ip:' + req.ip, 600, 3600000)) return res.status(429).json({ error: 'Muitos envios. Tente de novo daqui a pouco.' });
  if (!lerToken(b.token, prof)) return res.status(401).json({ error: 'A autorização do seu e-mail expirou ou não vale para este e-mail. Ative de novo em Ajustes → Backup.', reautorizar: true });
  if (!limitar('pv-prof:' + prof, MAX_PROVA_POR_DIA, 86400000)) return res.status(429).json({ error: 'Limite de e-mails de prova por dia atingido. Tente amanhã.' });
  if (!limitar('pv-al:' + alunoEmail, MAX_PROVA_POR_ALUNO_DIA, 86400000)) return res.status(429).json({ error: 'Este e-mail já recebeu muitos resultados hoje.' });
  const p = b.prova || {};
  const itens = itensDaProva(p.itens);
  if (!itens.length) return res.status(400).json({ error: 'A prova está vazia.' });
  const titulo = String(p.titulo || 'Prova').slice(0, 120);
  const nome = String((b.aluno && b.aluno.nome) || '').slice(0, 60);
  const dados = {
    titulo, nome, itens, mostrarNota: !!p.mostrarNota,
    nota: String(p.nota == null ? '' : p.nota).slice(0, 8), acertos: Math.max(0, Math.min(100, Number(p.acertos) || 0)), total: Math.max(0, Math.min(100, Number(p.total) || itens.length)),
    professor: String(b.professor || '').slice(0, 60),
  };
  const { html, text } = montarEmailProva(dados);
  try {
    await enviarResend({ to: [alunoEmail], reply_to: [prof], subject: `Seu resultado: ${titulo}`.slice(0, 150), html, text });
  } catch (e) {
    console.error('[sala] falha ao enviar gabarito da prova:', e.message);
    return res.status(502).json({ error: 'Não consegui enviar o e-mail agora. Tente de novo em instantes.' });
  }
  res.json({ ok: true });
});

module.exports = router;
