const express = require('express');
const router = express.Router();

const state = new Map();

setInterval(() => {
  const limite = Date.now() - 120000;
  for (const [k, v] of state) {
    if (v.ts < limite) state.delete(k);
  }
}, 120000);

router.post('/set', (req, res) => {
  const { phone, uid } = req.body || {};
  if (!phone || !uid) return res.status(400).json({ error: 'phone e uid obrigatorios' });
  state.set(phone, { uid, ts: Date.now() });
  res.json({ ok: true });
});

router.get('/check/:phone/:uid', (req, res) => {
  const { phone, uid } = req.params;
  const current = state.get(phone);
  if (!current || current.uid !== uid) {
    return res.json({ isLatest: false });
  }
  state.delete(phone);
  res.json({ isLatest: true });
});

module.exports = router;

// GET /api/debounce/humano/:phone
router.get('/humano/:phone', (req, res) => {
  const current = state.get(req.params.phone);
  res.json({ humano: !!(current && current.uid && current.uid.startsWith('HUMANO_ASSUMIU_')) });
});

router.get('/humano/:phone', (req, res) => {
  const current = state.get(req.params.phone);
  res.json({ humano: !!(current && current.uid && current.uid.startsWith('HUMANO_ASSUMIU_')) });
});
