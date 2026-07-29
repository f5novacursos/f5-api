/**
 * Integração com a Evolution API (WhatsApp) do F5 Nova Cursos.
 *
 * A chave NUNCA vai para o navegador: todo disparo passa por aqui, no
 * servidor. Antes essas chamadas eram feitas direto do JS do painel
 * (admin/js/turmas.js e admin/js/frequencia.js), o que deixava a apikey
 * visível pra qualquer um que abrisse o "view-source" do site.
 *
 * Configure no Coolify (nunca aqui no código):
 *   EVOLUTION_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE
 * Sem a chave, o sistema segue funcionando — só o envio de WhatsApp fica off.
 */
const EVO_URL    = process.env.EVOLUTION_URL || 'https://evo.f5novacursos.com.br';
const EVO_APIKEY = process.env.EVOLUTION_API_KEY || '';
const INSTANCE    = process.env.EVOLUTION_INSTANCE || 'zapf5cursos';

if (!EVO_APIKEY) {
  console.warn('[Evolution] EVOLUTION_API_KEY não configurada — envio de WhatsApp desativado.');
}

/** Chamada crua na Evolution, sempre com a apikey do servidor. */
async function evoFetch(caminho, opcoes = {}) {
  if (!EVO_APIKEY) {
    throw new Error('WhatsApp não configurado nesta instalação. Avise a administração do sistema.');
  }
  const res = await fetch(`${EVO_URL}${caminho}`, {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVO_APIKEY,
      ...(opcoes.headers || {})
    }
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = dados?.response?.message || dados?.message || `Evolution respondeu ${res.status}`;
    throw new Error(Array.isArray(msg) ? msg.join(', ') : msg);
  }
  return dados;
}

/** Cria um grupo com os participantes informados e devolve o JID. */
async function criarGrupo({ nome, descricao, participantes }) {
  const resp = await evoFetch(`/group/create/${INSTANCE}`, {
    method: 'POST',
    body: JSON.stringify({ subject: nome, description: descricao || '', participants: participantes }),
  });
  const jid = resp.id || resp.groupJid || resp.groupId || resp.data?.id || null;
  return { jid, resposta: resp };
}

/** Lista os grupos existentes na conta conectada — usado pra "vincular grupo já criado". */
async function listarGrupos() {
  const resp = await evoFetch(`/chat/findChats/${INSTANCE}`, { method: 'POST', body: '{}' });
  const arr = Array.isArray(resp) ? resp : (resp.chats || resp.data || []);
  return arr
    .filter(c => String(c.remoteJid || c.id || c.jid || '').includes('@g.us'))
    .map(c => ({ jid: c.remoteJid || c.id || c.jid, nome: c.name || c.subject || c.pushName || c.remoteJid }));
}

/** Link de convite de um grupo já criado/vinculado, pra abrir direto no WhatsApp. */
async function obterConviteGrupo(groupJid) {
  const resp = await evoFetch(`/group/inviteCode/${INSTANCE}?groupJid=${encodeURIComponent(groupJid)}`);
  return resp.inviteUrl || (resp.inviteCode ? `https://chat.whatsapp.com/${resp.inviteCode}` : null);
}

/** Envia texto para um número ou para o JID de um grupo. */
async function enviarTexto(destino, texto) {
  return evoFetch(`/message/sendText/${INSTANCE}`, {
    method: 'POST',
    body: JSON.stringify({ number: destino, text: texto, delay: 800 }),
  });
}

/** Envia mídia (PDF, imagem etc.) — `media` é a URL pública do arquivo. */
async function enviarMidia(destino, { media, fileName, caption, mediatype }) {
  return evoFetch(`/message/sendMedia/${INSTANCE}`, {
    method: 'POST',
    body: JSON.stringify({ number: destino, mediatype: mediatype || 'document', media, fileName, caption }),
  });
}

module.exports = { criarGrupo, listarGrupos, obterConviteGrupo, enviarTexto, enviarMidia };
