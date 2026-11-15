// F5 Sala — e-mails bonitos para o cliente: "sua licença chegou" (com chave e botão de baixar), pagamento confirmado e chave de demonstração.
// HTML simples (tabelas e estilo na própria tag) para funcionar em qualquer leitor de e-mail.
const db = require('../db');
const L = require('./salaLicenca');

const API = () => process.env.SALA_PUBLIC_URL || 'https://api.f5novacursos.com.br';
const SITE = () => process.env.SALA_SITE_URL || 'https://f5sala.com.br';
const dataBR = (iso) => String(iso || '').slice(0, 10).split('-').reverse().join('/');
const esc = L.escapar;

const botao = (url, texto, escuro = false) => `<a href="${url}" style="display:inline-block;background:${escuro ? '#0c0f0d' : '#c9ff2f'};color:${escuro ? '#ffffff' : '#0c0f0d'};font:800 17px Arial,Helvetica,sans-serif;text-decoration:none;padding:16px 30px;border-radius:999px">${texto}</a>`;

function layout(titulo, corpo) {
  return `<div style="background:#f2efe6;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#0c0f0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden">
    <tr><td style="background:#0c0f0d;padding:22px 30px"><span style="font:900 26px Arial Black,Arial,sans-serif;letter-spacing:1px;color:#ffffff;text-transform:uppercase">F5 <span style="color:#c9ff2f">Sala</span></span></td></tr>
    <tr><td style="padding:34px 30px 8px"><h1 style="margin:0 0 14px;font:900 30px/1.05 Arial Black,Arial,sans-serif;text-transform:uppercase">${titulo}</h1>${corpo}</td></tr>
    <tr><td style="padding:10px 30px 30px;color:#6d7168;font-size:12px;line-height:1.5">F5 Sala · um sistema da F5 Nova Cursos, João Pessoa/PB.<br>Dúvidas? É só responder pelo próprio programa (aba Suporte) — respondemos em até 24 horas.</td></tr>
  </table></div>`;
}
const caixaChave = (chave) => `<div style="background:#0c0f0d;border-radius:14px;padding:20px;text-align:center;margin:20px 0"><div style="color:#a8ac9f;font:12px Arial;letter-spacing:2px;text-transform:uppercase">sua chave de licença</div><div style="color:#c9ff2f;font:900 28px/1.2 Arial Black,Arial;letter-spacing:3px;margin-top:8px;word-break:break-all">${esc(chave)}</div></div>`;
const passos = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;font-size:15px;line-height:1.5">
  <tr><td style="padding:6px 12px 6px 0;font:900 22px Arial Black;color:#0c0f0d;vertical-align:top">1</td><td style="padding:6px 0"><b>Baixe e instale</b> o F5 Sala no computador do professor.</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font:900 22px Arial Black;vertical-align:top">2</td><td style="padding:6px 0">Ao abrir, <b>digite a chave</b> acima.</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font:900 22px Arial Black;vertical-align:top">3</td><td style="padding:6px 0">Instale o mesmo programa nos computadores dos alunos e escolha <b>“Aluno”</b>.</td></tr></table>`;

// e-mail de entrega: licença paga ou demonstração
function htmlEntrega({ cliente, lic, demo, vencimento }) {
  const nome = esc((cliente.responsavel || '').split(' ')[0] || 'tudo bem');
  const intro = demo
    ? `<p style="font-size:16px;line-height:1.55;margin:0 0 6px">Olá, ${nome}! Sua demonstração de ${L.DEMO_DIAS} dias (com 1 aluno) está liberada para a <b>${esc(cliente.escola)}</b>.</p>`
    : `<p style="font-size:16px;line-height:1.55;margin:0 0 6px">Olá, ${nome}! O pagamento foi confirmado e a licença da <b>${esc(cliente.escola)}</b> (sala <b>${esc(lic.sala)}</b>) já está ativa${vencimento ? ` até <b>${dataBR(vencimento)}</b>` : ''}.</p>`;
  return layout(demo ? 'Sua demonstração chegou' : 'Sua licença chegou', `${intro}${caixaChave(lic.chave)}
    <div style="text-align:center;margin:8px 0 24px">${botao(`${API()}/api/sala/licenca/download`, 'Baixar o F5 Sala')}</div>
    ${passos}
    <p style="margin:22px 0 4px;font-size:14px;color:#6d7168">Guarde este e-mail: a chave é da escola e fica sempre disponível na <a href="${SITE()}/cliente.html" style="color:#0c0f0d;font-weight:700">Área do cliente</a>.</p>
    <div style="margin:6px 0 20px">${botao(`${SITE()}/cliente.html`, 'Abrir a Área do cliente', true)}</div>`);
}
function textoEntrega({ cliente, lic, demo, vencimento }) {
  return `${demo ? 'Demonstração liberada' : 'Licença ativa'} — ${cliente.escola} (${lic.sala})${vencimento ? ' até ' + dataBR(vencimento) : ''}.\nChave: ${lic.chave}\nBaixar: ${API()}/api/sala/licenca/download\nÁrea do cliente: ${SITE()}/cliente.html`;
}
const entrega = (dados) => L.enviarEmail({ to: dados.cliente.email, subject: dados.demo ? 'Sua demonstração do F5 Sala chegou' : 'Sua licença do F5 Sala chegou', html: htmlEntrega(dados), text: textoEntrega(dados) });

// Depois de um pagamento aplicado: o 1º pagamento manda a entrega (chave + baixar); os seguintes mandam só a confirmação
async function aposPagamento(lic, nova) {
  const { rows } = await db.query('SELECT entrega_enviada_em FROM sala_licencas WHERE id = $1', [lic.id]);
  const cliente = { escola: lic.escola, email: lic.email, responsavel: lic.responsavel };
  if (rows.length && !rows[0].entrega_enviada_em) {
    await db.query('UPDATE sala_licencas SET entrega_enviada_em = NOW() WHERE id = $1', [lic.id]);
    return entrega({ cliente, lic, demo: false, vencimento: nova });
  }
  return L.enviarEmail({
    to: lic.email, subject: 'Pagamento confirmado — F5 Sala',
    html: layout('Pagamento confirmado', `<p style="font-size:16px;line-height:1.55">Recebemos o pagamento da licença <b>${esc(lic.sala)}</b> (${esc(lic.escola)}). Ela está ativa até <b>${dataBR(nova)}</b>. Obrigado!</p><div style="margin:18px 0 20px">${botao(`${SITE()}/cliente.html`, 'Abrir a Área do cliente', true)}</div>`),
    text: `Pagamento confirmado. Licença ${lic.sala} ativa até ${dataBR(nova)}.`,
  });
}

module.exports = { entrega, aposPagamento, htmlEntrega, layout, botao, SITE };
