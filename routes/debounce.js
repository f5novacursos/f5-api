const express = require('express');
const router = express.Router();

// Estado em memória: phone → { uid, ts }
// Dura enquanto o processo estiver rodando — suficiente para o debounce de 6-8s
const state = new Map();

// Limpa entradas antigas a cada 2 minutos (evita vazamento de memória)
setInterval(() => {
  const limite = Date.now() - 120_000;
  for (const [k, v] of state) {
    if (v.ts < limite) state.delete(k);
  }
}, 120_000);

// POST /api/debounce/set  { phone, uid }
// Sobrescreve o uid atual para este telefone (a última escrita vence)
router.post('/set', (req, res) => {
  const { phone, uid } = req.body || {};
  if (!phone || !uid) return res.status(400).json({ error: 'phone e uid obrigatórios' });
  state.set(phone, { uid, ts: Date.now() });
  res.json({ ok: true });
});

// GET /api/debounce/check/:phone/:uid
// Retorna { isLatest: true } se este uid ainda é o mais recente e limpa o estado
router.get('/check/:phone/:uid', (req, res) => {
  const { phone, uid } = req.params;
  const current = state.get(phone);
  if (!current || current.uid !== uid) {
    return res.json({ isLatest: false });
  }
  state.delete(phone); // Limpa após confirmar
  res.json({ isLatest: true });
});

module.exports = router;
