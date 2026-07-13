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
    if (telefone.length < 8) return res.json({ found: false });

    // Casa pelos últimos 8 dígitos (miolo do número). Assim o filtro funciona
    // mesmo quando o número salvo (Google Maps) difere do que chega no WhatsApp
    // por 9º dígito, código do país ou formatação — evita a Ana responder prospecto.
    const sufixo = telefone.slice(-8);
    const result = await db.query(
      `SELECT id FROM leads_prospectados
       WHERE RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 8) = $1
       LIMIT 1`,
      [sufixo]
    );
    res.json({ found: result.rows.length > 0 });
  } catch (e) {
    // Em caso de erro (ex: tabela ainda não existe), deixa a Ana responder
    res.json({ found: false });
  }
});

module.exports = router;
