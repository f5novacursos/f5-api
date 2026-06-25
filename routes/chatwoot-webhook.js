const express = require('express');
const router = express.Router();

const CHATWOOT_URL = 'https://chat.f5novacursos.com.br';
const CHATWOOT_TOKEN = '873b5TyRgZMfkZXpphxZgH4z';
const CHATWOOT_ACCOUNT = 1;

// POST /webhook/chatwoot
// Recebe eventos do Chatwoot e propaga label humano_ativo da conversa para o contato
router.post('/', async (req, res) => {
  try {
    const { event, label, conversation } = req.body;

    // Só nos interessa conversation_label_created com label humano_ativo
    if (event !== 'conversation_label_created') return res.sendStatus(200);
    if (label !== 'humano_ativo') return res.sendStatus(200);

    const contactId = conversation?.meta?.sender?.id;
    if (!contactId) {
      console.warn('[chatwoot-webhook] humano_ativo sem contact_id', req.body);
      return res.sendStatus(200);
    }

    // Buscar labels atuais do contato
    const getRes = await fetch(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT}/contacts/${contactId}/labels`,
      { headers: { 'api_access_token': CHATWOOT_TOKEN } }
    );
    const { payload: currentLabels = [] } = await getRes.json();

    if (currentLabels.includes('humano_ativo')) {
      return res.sendStatus(200); // já tem, nada a fazer
    }

    // Adicionar humano_ativo ao contato
    await fetch(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT}/contacts/${contactId}/labels`,
      {
        method: 'POST',
        headers: {
          'api_access_token': CHATWOOT_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ labels: [...currentLabels, 'humano_ativo'] })
      }
    );

    console.log(`[chatwoot-webhook] humano_ativo propagado para contato ${contactId} (conversa ${conversation?.id})`);
    res.sendStatus(200);
  } catch (err) {
    console.error('[chatwoot-webhook] erro:', err.message);
    res.sendStatus(200); // sempre 200 para o Chatwoot não ficar retentando
  }
});

module.exports = router;
