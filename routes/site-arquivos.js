const router = require('express').Router();
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');

const CHAVE_VALIDA = /^[a-z0-9-]{3,100}$/;
const MIME_VALIDO = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TAMANHO_MAXIMO = 5 * 1024 * 1024;

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS site_arquivos (
        chave VARCHAR(100) PRIMARY KEY,
        mime VARCHAR(100) NOT NULL,
        dados BYTEA NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.error('[site-arquivos] migration error:', e.message);
  }
})();

function chaveValida(chave) {
  return CHAVE_VALIDA.test(String(chave || ''));
}

router.get('/:chave', async (req, res, next) => {
  if (!chaveValida(req.params.chave)) return res.status(400).json({ error: 'Chave de arquivo inválida' });
  try {
    const { rows } = await db.query(
      'SELECT mime, dados, atualizado_em FROM site_arquivos WHERE chave = $1',
      [req.params.chave]
    );
    if (!rows.length) return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Last-Modified', new Date(rows[0].atualizado_em).toUTCString());
    res.send(rows[0].dados);
  } catch (err) { next(err); }
});

router.put('/:chave', adminAuth, async (req, res, next) => {
  if (!chaveValida(req.params.chave)) return res.status(400).json({ error: 'Chave de arquivo inválida' });
  try {
    const dataUrl = String(req.body?.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Envie uma imagem JPG, PNG ou WEBP válida' });
    const mime = match[1];
    const dados = Buffer.from(match[2], 'base64');
    if (!MIME_VALIDO.has(mime) || !dados.length || dados.length > TAMANHO_MAXIMO) {
      return res.status(400).json({ error: 'A imagem deve ter até 5 MB e estar em JPG, PNG ou WEBP' });
    }
    await db.query(
      `INSERT INTO site_arquivos (chave, mime, dados, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (chave) DO UPDATE SET mime = EXCLUDED.mime, dados = EXCLUDED.dados, atualizado_em = NOW()`,
      [req.params.chave, mime, dados]
    );
    res.json({ ok: true, url: `/api/site-arquivos/${req.params.chave}` });
  } catch (err) { next(err); }
});

module.exports = router;
