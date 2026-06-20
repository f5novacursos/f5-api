// routes/lixeira.js — API da Lixeira central do sistema
const router  = require('express').Router();
const lixeira = require('../lib/lixeira');

// GET /api/lixeira — lista tudo que está na lixeira (já limpa o expirado)
router.get('/', async (req, res, next) => {
  try {
    res.json(await lixeira.listar());
  } catch (err) { next(err); }
});

// POST /api/lixeira/:id/restaurar — devolve o item ao sistema
router.post('/:id/restaurar', async (req, res, next) => {
  try {
    res.json(await lixeira.restaurar(parseInt(req.params.id)));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/lixeira/:id — exclui DE VEZ um item
router.delete('/:id', async (req, res, next) => {
  try {
    res.json(await lixeira.purgar(parseInt(req.params.id)));
  } catch (err) { next(err); }
});

// DELETE /api/lixeira — esvazia a lixeira inteira
router.delete('/', async (req, res, next) => {
  try {
    res.json(await lixeira.esvaziar());
  } catch (err) { next(err); }
});

module.exports = router;
