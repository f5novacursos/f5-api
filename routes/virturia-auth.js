const router = require('express').Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.VIRTURIA_JWT_SECRET || process.env.VIRTURIA_CHAVE || 'virturia2026secret';
const JWT_EXPIRY = '7d';

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_usuarios (
      id        SERIAL PRIMARY KEY,
      email     VARCHAR(100) UNIQUE NOT NULL,
      senha     VARCHAR(200) NOT NULL,
      nome      VARCHAR(100),
      ativo     BOOLEAN DEFAULT true,
      plano     VARCHAR(20) DEFAULT 'basico',
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);
}
initTable().catch(e => console.error('[virturia-auth] init error:', e.message));

// Middleware JWT — exportado para uso em outras rotas
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// POST /api/virturia/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const { rows } = await db.query(
      'SELECT * FROM virturia_usuarios WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user || !user.ativo) return res.status(401).json({ error: 'Credenciais inválidas' });

    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

    const token = jwt.sign(
      { id: user.id, email: user.email, nome: user.nome, plano: user.plano },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({ ok: true, token, nome: user.nome, plano: user.plano });
  } catch(e) {
    next(e);
  }
});

// POST /api/virturia/usuarios — cria usuário (protegido por VIRTURIA_CHAVE)
router.post('/usuarios', async (req, res, next) => {
  try {
    const { chave, email, senha, nome, plano } = req.body;
    if (chave !== process.env.VIRTURIA_CHAVE) return res.status(401).json({ error: 'Não autorizado' });
    if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const hash = await bcrypt.hash(senha, 10);
    const { rows } = await db.query(
      `INSERT INTO virturia_usuarios (email, senha, nome, plano)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET senha = $2, nome = $3, plano = $4, ativo = true
       RETURNING id, email, nome, plano`,
      [email.toLowerCase().trim(), hash, nome || null, plano || 'basico']
    );
    res.json({ ok: true, usuario: rows[0] });
  } catch(e) {
    next(e);
  }
});

// GET /api/virturia/me — valida token e retorna dados do usuário
router.get('/me', authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// PUT /api/virturia/senha — troca senha do usuário autenticado
router.put('/senha', authMiddleware, async (req, res, next) => {
  try {
    const { senhaAtual, senhaNova } = req.body;
    if (!senhaAtual || !senhaNova) return res.status(400).json({ error: 'Campos obrigatórios' });
    if (senhaNova.length < 6) return res.status(400).json({ error: 'Nova senha deve ter 6+ caracteres' });

    const { rows } = await db.query('SELECT * FROM virturia_usuarios WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });

    const ok = await bcrypt.compare(senhaAtual, rows[0].senha);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });

    const hash = await bcrypt.hash(senhaNova, 10);
    await db.query('UPDATE virturia_usuarios SET senha = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
