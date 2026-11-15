// F5 Sala — lembretes de vencimento por WhatsApp (Evolution) e e-mail (Resend), enviados pelo próprio servidor uma vez por dia.
// Mensal: 5 dias antes, no dia e 2 dias depois. Anual: 30, 15, 7 e 1 dia antes, no dia e 3 dias depois. Cada aviso é enviado UMA vez (tabela sala_avisos).
// Desligar tudo: variável SALA_LEMBRETES=off. Sem WhatsApp configurado, vai só o e-mail.
const db = require('../db');
const L = require('./salaLicenca');
const { garantirTabelas } = require('./salaDb');

const API_PUBLICA = process.env.SALA_PUBLIC_URL || 'https://api.f5novacursos.com.br';
const DIAS = { mensal: [5, 0, -2], anual: [30, 15, 7, 1, 0, -3] };

function linkPagamento(lic, ciclo) { return `${API_PUBLICA}/api/sala/pagar/ir/${lic.token_pagamento}?ciclo=${ciclo || lic.ciclo || 'mensal'}`; }
const dataBR = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');

function montarTexto(lic, dias) {
  const nome = String(lic.responsavel || '').split(' ')[0] || 'tudo bem';
  const quando = dias > 1 ? `vence em ${dias} dias, dia ${dataBR(lic.proximo_vencimento)}` : dias === 1 ? `vence amanhã, dia ${dataBR(lic.proximo_vencimento)}` : dias === 0 ? 'vence hoje' : `venceu há ${-dias} dia${-dias > 1 ? 's' : ''} (ainda funciona por alguns dias)`;
  return `Olá, ${nome}! A licença do F5 Sala da ${lic.escola} (${lic.sala}) ${quando}.\n\nPara renovar é só pagar por aqui (Pix ou cartão):\n${linkPagamento(lic)}\n\nQualquer dúvida é só responder esta mensagem. 😊`;
}

// Envia o lembrete (WhatsApp + e-mail). Devolve os canais que funcionaram.
async function enviar(lic, dias) {
  const canais = [];
  const texto = montarTexto(lic, dias);
  if (lic.telefone && lic.aceite_avisos !== false) {
    try { await require('./evolution').enviarTexto(lic.telefone, texto); canais.push('whatsapp'); } catch (e) { console.warn('[sala lembrete] WhatsApp falhou:', e.message); }
  }
  if (lic.email && lic.aceite_avisos !== false) {
    const ok = await L.enviarEmail({
      to: lic.email, subject: dias >= 0 ? 'Sua licença do F5 Sala vence em breve' : 'Sua licença do F5 Sala venceu',
      html: L.caixaEmail('Licença do F5 Sala', `<p style="white-space:pre-line">${L.escapar(texto).replace(linkPagamento(lic), '')}</p><p><a href="${linkPagamento(lic)}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Renovar agora</a></p>`),
      text: texto,
    });
    if (ok) canais.push('email');
  }
  return canais;
}

// Roda todos os dias úteis a partir das 9h (horário de Fortaleza): procura as licenças que cruzaram um dos marcos de aviso.
async function rodar(agora = new Date()) {
  await garantirTabelas();
  const hoje = new Date(agora.getTime() - 3 * 3600000).toISOString().slice(0, 10); // dia em Fortaleza (UTC-3)
  const { rows } = await db.query(
    `SELECT l.*, c.escola, c.responsavel, c.email, c.telefone, c.aceite_avisos FROM sala_licencas l JOIN sala_clientes c ON c.id = l.cliente_id
      WHERE l.plano = 'sala' AND l.vitalicia = FALSE AND l.status = 'ativo' AND l.proximo_vencimento IS NOT NULL`);
  let enviados = 0;
  for (const lic of rows) {
    const venc = new Date(L.diaISO(lic.proximo_vencimento) + 'T00:00:00Z');
    const dias = Math.round((venc.getTime() - new Date(hoje + 'T00:00:00Z').getTime()) / L.DIA);
    if (!(DIAS[lic.ciclo] || DIAS.mensal).includes(dias)) continue;
    const jaAvisado = await db.query('SELECT id FROM sala_avisos WHERE licenca_id = $1 AND dia = $2 AND data = $3', [lic.id, dias, hoje]);
    if (jaAvisado.rows.length) continue; // já avisado hoje
    const ins = await db.query(`INSERT INTO sala_avisos (licenca_id, dia, data, canal) VALUES ($1,$2,$3,'pendente') ON CONFLICT (licenca_id, dia, data) DO NOTHING RETURNING id`, [lic.id, dias, hoje]);
    if (!ins.rows.length) continue; // já avisado hoje
    const canais = await enviar(lic, dias);
    await db.query(`UPDATE sala_avisos SET canal = $1 WHERE id = $2`, [canais.join('+') || 'nenhum', ins.rows[0].id]);
    if (canais.length) enviados++;
  }
  return { enviados, verificadas: rows.length };
}

let timer = null;
function iniciar() {
  if (process.env.SALA_LEMBRETES === 'off' || timer) return;
  timer = setInterval(() => {
    const hora = new Date(Date.now() - 3 * 3600000).getUTCHours();
    if (hora < 9 || hora > 19) return;
    rodar().then((r) => { if (r.enviados) console.log(`[sala] lembretes de vencimento enviados: ${r.enviados}`); }).catch((e) => console.error('[sala] lembretes:', e.message));
  }, 30 * 60 * 1000);
  timer.unref();
}

module.exports = { rodar, enviar, iniciar, linkPagamento, montarTexto, DIAS };
