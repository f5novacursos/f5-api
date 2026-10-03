// F5 Leads: detecta respostas dos leads de prospecção.
// POST /webhook/f5leads-resposta — webhook do Chatwoot (evento message_created).
// Mensagem RECEBIDA de um número que é lead:
//   - "sair", "parar", "não quero"... → status nao_enviar (nunca mais recebe disparo)
//   - qualquer outra mensagem          → status respondeu
// Não regride quem já é respondeu/cliente/nao_enviar/ignorado (exceto opt-out, que sempre vale).
const express = require('express');
const router = express.Router();
const db = require('../db');

const NAO_REGRIDE = ['respondeu', 'cliente', 'nao_enviar', 'ignorado'];
const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|remover|descadastrar|n[aã]o\s+quero|n[aã]o\s+tenho\s+interesse|sem\s+interesse|n[aã]o\s+me\s+mande)\b/i;

router.post('/', async (req, res) => {
  // Responde logo: o Chatwoot não precisa esperar o processamento
  res.sendStatus(200);
  try {
    const b = req.body || {};
    if (b.event !== 'message_created' || b.message_type !== 'incoming' || b.private) return;

    const telefone = String(b.sender?.phone_number || b.conversation?.meta?.sender?.phone_number || '').replace(/\D/g, '');
    if (telefone.length < 8 || telefone.length > 13) return; // sem telefone ou grupo

    const lead = (await db.query(
      `SELECT id, nome, status FROM leads_empresas
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(whatsapp, telefone, ''), '[^0-9]', '', 'g'), 8) = $1
       ORDER BY (status = 'mensagem_enviada') DESC, id
       LIMIT 1`,
      [telefone.slice(-8)]
    )).rows[0];
    if (!lead) return;

    const conteudo = String(b.content || '[mídia]').slice(0, 300);
    const optOut = OPT_OUT.test(conteudo);
    const novoStatus = optOut ? 'nao_enviar' : 'respondeu';

    if (lead.status === novoStatus) return;
    if (!optOut && NAO_REGRIDE.includes(lead.status)) return;

    // Marca TODOS os cadastros com esse número (a mesma empresa pode ter vindo em buscas diferentes)
    const r = await db.query(
      `UPDATE leads_empresas SET status = $1, atualizado_em = NOW()
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(whatsapp, telefone, ''), '[^0-9]', '', 'g'), 8) = $2
         AND ($3 OR status <> ALL($4::text[]))
       RETURNING id`,
      [novoStatus, telefone.slice(-8), optOut, NAO_REGRIDE]
    );
    for (const { id } of r.rows) {
      await db.query(
        `INSERT INTO leads_historico (empresa_id, tipo, descricao, dados) VALUES ($1, $2, $3, $4)`,
        [id, novoStatus, optOut ? 'Pediu para não receber mais mensagens' : 'Respondeu no WhatsApp',
         JSON.stringify({ telefone, mensagem: conteudo, nome: b.sender?.name || null })]
      ).catch(e => console.error('[f5leads resposta] historico:', e.message));
    }
    console.log(`[f5leads resposta] ${lead.nome} → ${novoStatus} (${r.rows.length} cadastro(s))`);
  } catch (e) {
    console.error('[f5leads resposta]', e.message);
  }
});

module.exports = router;
