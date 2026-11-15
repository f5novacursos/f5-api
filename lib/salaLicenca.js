// F5 Sala — regras da licença: estado (ativo / carência / vencido / suspenso), recibo assinado (Ed25519), códigos por e-mail e envio de e-mails.
// O recibo é um JSON assinado pelo SERVIDOR: o programa do professor confere a assinatura com a chave pública (sem internet) e
// só confia no que está assinado. A chave privada fica no banco (sala_config) e nunca sai do servidor.
const crypto = require('crypto');
const db = require('../db');
const { lerConfig, gravarConfig } = require('./salaDb');

const DIA = 86400000;
const VALIDADE_RECIBO_DIAS = 14; // sem internet, o programa continua valendo por até 14 dias
const CARENCIA_DIAS = { mensal: 5, anual: 10 }; // depois do vencimento ainda funciona (com aviso)
const DEMO_DIAS = Number(process.env.SALA_DEMO_DIAS) || 14;
const DEMO_ALUNOS = 1;
const LIMITE_PADRAO = 35;
const TROCAS_POR_ANO = 3;

const PRECOS_PADRAO = { mensal: 100, anual: 1000 }; // ponto de partida: pode mudar em admin → F5 Sala → Configurações
async function precos() {
  const m = Number(await lerConfig('preco_mensal', PRECOS_PADRAO.mensal));
  const a = Number(await lerConfig('preco_anual', PRECOS_PADRAO.anual));
  return { mensal: m > 0 ? m : PRECOS_PADRAO.mensal, anual: a > 0 ? a : PRECOS_PADRAO.anual };
}

// ---------- chave de assinatura ----------
let chaves = null;
async function carregarChaves() {
  if (chaves) return chaves;
  let priv = await lerConfig('recibo_privada', '');
  let pub = await lerConfig('recibo_publica', '');
  if (!priv || !pub) {
    const par = crypto.generateKeyPairSync('ed25519');
    priv = par.privateKey.export({ type: 'pkcs8', format: 'pem' });
    pub = par.publicKey.export({ type: 'spki', format: 'pem' });
    // se dois processos criarem ao mesmo tempo, vale o primeiro que gravou
    await db.query(`INSERT INTO sala_config (chave, valor) VALUES ('recibo_privada',$1) ON CONFLICT (chave) DO NOTHING`, [priv]);
    await db.query(`INSERT INTO sala_config (chave, valor) VALUES ('recibo_publica',$1) ON CONFLICT (chave) DO NOTHING`, [pub]);
    priv = await lerConfig('recibo_privada'); pub = await lerConfig('recibo_publica');
  }
  chaves = { privada: crypto.createPrivateKey(priv), publicaPem: pub };
  return chaves;
}
async function chavePublica() { return (await carregarChaves()).publicaPem; }
async function assinar(dados) {
  const texto = JSON.stringify(dados);
  const { privada } = await carregarChaves();
  return { dados: texto, sig: crypto.sign(null, Buffer.from(texto, 'utf8'), privada).toString('base64') };
}

// ---------- estado da licença ----------
// coluna DATE do pg vem como Date à meia-noite LOCAL do servidor: lê pelos componentes locais (não pelo UTC), senão o dia pode voltar um
const diaISO = (d) => {
  if (d instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    // meia-noite UTC (alguns drivers/bancos) → componentes UTC; senão → componentes locais (o pg entrega DATE como meia-noite local)
    if (d.getHours() !== 0 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return String(d || '').slice(0, 10);
};
function carenciaDe(lic) { return CARENCIA_DIAS[lic.ciclo] || CARENCIA_DIAS.mensal; }
// 'ativo' | 'carencia' | 'vencido' | 'suspenso'  (+ limite efetivo de alunos)
function situacao(lic, agora = new Date()) {
  if (lic.status === 'suspenso' || lic.status === 'cancelado') return { estado: 'suspenso', limite: 0 };
  if (lic.vitalicia) return { estado: 'ativo', limite: lic.limite_alunos };
  if (lic.plano === 'demo') {
    if (lic.demo_ate && new Date(lic.demo_ate) > agora) return { estado: 'ativo', limite: DEMO_ALUNOS, demo: true };
    return { estado: 'vencido', limite: DEMO_ALUNOS, demo: true };
  }
  if (!lic.proximo_vencimento) return { estado: 'vencido', limite: DEMO_ALUNOS };
  const fim = new Date(diaISO(lic.proximo_vencimento) + 'T23:59:59-03:00');
  if (agora <= fim) return { estado: 'ativo', limite: lic.limite_alunos };
  if (agora <= new Date(fim.getTime() + carenciaDe(lic) * DIA)) return { estado: 'carencia', limite: lic.limite_alunos };
  return { estado: 'vencido', limite: DEMO_ALUNOS }; // sem pagar: volta ao modo demonstração (1 aluno)
}

async function dadosDoRecibo(lic, cliente, extra = {}) {
  const s = situacao(lic);
  const agora = new Date();
  return {
    v: 1,
    chave: lic.chave,
    licenca_id: lic.id,
    escola: cliente.escola,
    sala: lic.sala,
    plano: lic.vitalicia ? 'interna' : lic.plano,
    ciclo: lic.ciclo,
    estado: s.estado,
    demo: !!s.demo,
    limite_alunos: s.limite,
    vencimento: lic.vitalicia ? null : (lic.plano === 'demo' ? diaISO(lic.demo_ate) : diaISO(lic.proximo_vencimento) || null),
    vitalicia: !!lic.vitalicia,
    carencia_dias: carenciaDe(lic),
    site: cliente.site || '',
    instagram: cliente.instagram || '',
    emitido: agora.toISOString(),
    valido_ate: new Date(agora.getTime() + VALIDADE_RECIBO_DIAS * DIA).toISOString(),
    ...extra,
  };
}
async function recibo(lic, cliente, extra) { return assinar(await dadosDoRecibo(lic, cliente, extra)); }

// ---------- limite de pedidos (memória; reiniciar o servidor só zera a contagem) ----------
const marcas = new Map();
function limitar(chave, max, janelaMs) {
  const agora = Date.now();
  const lista = (marcas.get(chave) || []).filter((t) => agora - t < janelaMs);
  if (lista.length >= max) { marcas.set(chave, lista); return false; }
  lista.push(agora); marcas.set(chave, lista);
  return true;
}
setInterval(() => { const agora = Date.now(); for (const [k, v] of marcas) { const f = v.filter((t) => agora - t < 3600000); if (f.length) marcas.set(k, f); else marcas.delete(k); } }, 10 * 60 * 1000).unref();

// ---------- e-mail (Resend) ----------
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails'; // RESEND_URL só existe para testes
const RESEND_FROM = process.env.RESEND_FROM || 'F5 Sala <nao-responder@f5novacursos.com.br>';
const escapar = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, '');
async function enviarEmail({ to, subject, html, text }) {
  const chave = process.env.RESEND_API_KEY || '';
  if (!chave) { console.warn('[sala] RESEND_API_KEY ausente: e-mail não enviado:', subject); return false; }
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(RESEND_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: RESEND_FROM, to: Array.isArray(to) ? to : [to], subject, html, text }), signal: ctrl.signal });
    if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
    return true;
  } catch (e) { console.error('[sala] falha ao enviar e-mail:', e.message); return false; } finally { clearTimeout(t); }
}
function caixaEmail(titulo, corpoHtml) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0a1628"><h2 style="margin:0 0 12px">${titulo}</h2>${corpoHtml}<p style="color:#64748b;font-size:12px;margin-top:22px">F5 Nova Cursos · João Pessoa/PB</p></div>`;
}

// ---------- códigos de 6 dígitos por e-mail (guardados no banco: valem 15 min, 5 tentativas) ----------
const SEGREDO = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const hashCodigo = (email, fin, codigo) => crypto.createHmac('sha256', SEGREDO).update(`${email}:${fin}:${codigo}`).digest('hex');
async function criarCodigo(email, finalidade, dados = null) {
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(
    `INSERT INTO sala_codigos (email, finalidade, hash, expira, tentativas, dados) VALUES ($1,$2,$3,$4,0,$5)
     ON CONFLICT (email, finalidade) DO UPDATE SET hash = EXCLUDED.hash, expira = EXCLUDED.expira, tentativas = 0, dados = EXCLUDED.dados`,
    [email, finalidade, hashCodigo(email, finalidade, codigo), new Date(Date.now() + 15 * 60000), dados ? JSON.stringify(dados) : null]
  );
  return codigo;
}
// devolve { ok, dados } ou { ok:false, erro }
async function conferirCodigo(email, finalidade, codigo) {
  const { rows } = await db.query('SELECT * FROM sala_codigos WHERE email = $1 AND finalidade = $2', [email, finalidade]);
  const c = rows[0];
  if (!c || new Date(c.expira) < new Date()) return { ok: false, erro: 'O código expirou ou não foi pedido. Peça um código novo.' };
  if (c.tentativas >= 5) { await db.query('DELETE FROM sala_codigos WHERE email = $1 AND finalidade = $2', [email, finalidade]); return { ok: false, erro: 'Muitas tentativas. Peça um código novo.' }; }
  const esperado = Buffer.from(c.hash, 'hex'); const recebido = Buffer.from(hashCodigo(email, finalidade, String(codigo || '').replace(/\D/g, '')), 'hex');
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) {
    await db.query('UPDATE sala_codigos SET tentativas = tentativas + 1 WHERE email = $1 AND finalidade = $2', [email, finalidade]);
    return { ok: false, erro: 'Código incorreto.' };
  }
  await db.query('DELETE FROM sala_codigos WHERE email = $1 AND finalidade = $2', [email, finalidade]);
  return { ok: true, dados: c.dados ? JSON.parse(c.dados) : null };
}

// ---------- utilidades ----------
const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const normalizarEmail = (e) => String(e || '').trim().toLowerCase();
const telefoneBR = (t) => { const d = String(t || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) return '55' + d; if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d; return ''; };
const mascararEmail = (e) => { const [u, d] = String(e).split('@'); return (u.slice(0, 2) + '***@' + d); };
const somarDias = (base, dias) => new Date(base.getTime() + dias * DIA);

module.exports = {
  DIA, DEMO_DIAS, DEMO_ALUNOS, LIMITE_PADRAO, TROCAS_POR_ANO, VALIDADE_RECIBO_DIAS, CARENCIA_DIAS,
  precos, chavePublica, assinar, situacao, recibo, dadosDoRecibo, limitar, enviarEmail, caixaEmail, escapar,
  criarCodigo, conferirCodigo, emailOk, normalizarEmail, telefoneBR, mascararEmail, somarDias, diaISO,
};
