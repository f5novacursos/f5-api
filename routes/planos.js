const router = require('express').Router();
const db = require('../db');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave   VARCHAR(50) PRIMARY KEY,
      valor   JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Seed planos padrão se não existir
  await db.query(`
    INSERT INTO configuracoes (chave, valor) VALUES ('planos_web', $1)
    ON CONFLICT (chave) DO NOTHING
  `, [JSON.stringify({
    vitrine:    { label:'Vitrine',    emoji:'🌐', setup:197, mensal:27,  anual:270, descricao:'Sua empresa no mapa digital' },
    lancamento: { label:'Lançamento', emoji:'🚀', setup:297, mensal:37,  anual:370, descricao:'O primeiro passo profissional' },
    presenca:   { label:'Presença',   emoji:'📱', setup:497, mensal:47,  anual:470, descricao:'Landing page profissional completa' },
    autoridade: { label:'Autoridade', emoji:'🏆', setup:797, mensal:67,  anual:670, descricao:'Controle total do seu negócio' },
  })]);
}
migrate();

// GET /api/planos — retorna planos atuais
router.get('/', async (req, res) => {
  try {
    const r = await db.query("SELECT valor FROM configuracoes WHERE chave='planos_web'");
    res.json(r.rows[0]?.valor || {});
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/planos — salva planos (admin)
router.put('/', async (req, res) => {
  try {
    const planos = req.body;
    await db.query(`
      INSERT INTO configuracoes (chave, valor, updated_at)
      VALUES ('planos_web', $1, NOW())
      ON CONFLICT (chave) DO UPDATE SET valor=$1, updated_at=NOW()
    `, [JSON.stringify(planos)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
