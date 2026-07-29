const router = require('express').Router();
const evolution = require('../lib/evolution');

// GET /api/whatsapp/status — estado atual da conexão (zapf5cursos)
router.get('/status', async (req, res) => {
  try {
    const estado = await evolution.estadoConexao();
    res.json({ conectado: estado === 'open', estado });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/whatsapp/conectar — gera o QR code pro admin escanear
router.post('/conectar', async (req, res) => {
  try {
    const qrcode = await evolution.obterQrCode();
    if (!qrcode) return res.status(502).json({ error: 'A Evolution não devolveu o QR code. Tente novamente.' });
    res.json({ qrcode });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/whatsapp/desconectar
router.post('/desconectar', async (req, res) => {
  try {
    await evolution.desconectarInstancia();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
