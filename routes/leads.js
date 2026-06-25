// Rotas de prospecção ativa — controla leads abordados pelo disparo automático
// Usado pelo fluxo "00" do n8n para impedir que a Ana responda prospectos
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/leads/check/:phone
// Retorna { found: true } se o número já recebeu mensagem de prospecção
router.get('/check/:phone', async (req, res) => {
  try {
    const telefone = (req.params.phone || '').replace(/\D/g, '');
    if (!telefone) return res.json({ found: false });

    const result = await db.query(
      `SELECT id FROM leads_prospectados
       WHERE REGEXP_REPLACE(telefone, '[^0-9]', '', 'g') = $1
       LIMIT 1`,
      [telefone]
    );
    res.json({ found: result.rows.length > 0 });
  } catch (e) {
    // Em caso de erro (ex: tabela ainda não existe), deixa a Ana responder
    res.json({ found: false });
  }
});

module.exports = router;
