const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.EAD_JWT_SECRET || '';
const JWT_EXPIRY = '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '163041222391-rmnha7n1jcni0nu19bflgvpq6f6ufm0j.apps.googleusercontent.com';
const DIGITACAO_SLUG = 'curso-digitacao-f5';
const DIGITACAO_KIDS_SLUG = 'curso-digitacao-f5-kids';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizeLoginName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .replace(/\s+/g, ' ')
  .toLowerCase();

async function ensureTypingEnrollment(usuarioId, slug = DIGITACAO_SLUG, queryable = db) {
  const { rows } = await queryable.query(
    'SELECT id FROM ead_cursos WHERE slug = $1 AND ativo = TRUE LIMIT 1',
    [slug]
  );
  if (!rows.length) throw new Error('Curso de Digitação não configurado no EAD.');
  await queryable.query(
    "INSERT INTO ead_matriculas (usuario_id, curso_id, status) VALUES ($1, $2, 'ativa') " +
    "ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = 'ativa'",
    [usuarioId, rows[0].id]
  );
  return rows[0].id;
}

async function cursosAtivos(usuarioId) {
  const { rows } = await db.query(
    "SELECT curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa' ORDER BY curso_id",
    [usuarioId]
  );
  return rows.map((row) => row.curso_id);
}

function signToken(user, courses) {
  if (!JWT_SECRET) throw new Error('EAD_JWT_SECRET não configurada.');
  return jwt.sign({
    id: user.id,
    nome: user.nome,
    cpf: user.cpf || null,
    tipo: 'web',
    role: 'student',
    cursos: courses,
    perfil: user.perfil || 'adulto'
  }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function publicUser(user, courses) {
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    email_responsavel: user.email_responsavel || null,
    cpf: user.cpf || null,
    avatar_url: user.avatar_url || null,
    cidade: user.cidade || null,
    usuario: user.nome_login || null,
    tipo: 'web',
    role: 'student',
    perfil: user.perfil || 'adulto',
    cursos: courses
  };
}

async function verifyGoogleCredential(credential) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: controller.signal }
    );
    const payload = await response.json();
    const valid = response.ok && payload.aud === GOOGLE_CLIENT_ID
      && String(payload.email_verified) === 'true' && payload.email && payload.sub;
    if (!valid) throw new Error('Token Google inválido.');
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

router.post('/cadastro', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Cadastro ainda não configurado no servidor.' });
    const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
    const email = normalizeEmail(req.body.email);
    const senha = String(req.body.senha || '');
    const cidade = String(req.body.cidade || '').trim().replace(/\s+/g, ' ');
    if (nome.length < 2 || nome.length > 200) return res.status(400).json({ error: 'Informe seu nome.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (senha.length < 8 || senha.length > 100) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (cidade.length < 2 || cidade.length > 160) return res.status(400).json({ error: 'Informe sua cidade.' });

    const existing = await db.query(
      'SELECT id FROM ead_usuarios WHERE LOWER(email) = $1 AND deletado_em IS NULL',
      [email]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Este e-mail já possui uma Conta F5. Entre com sua senha.' });

    const hash = await bcrypt.hash(senha, 12);
    const { rows } = await db.query(
      `INSERT INTO ead_usuarios (nome, email, senha_hash, cpf, cidade)
       VALUES ($1, $2, $3, NULL, $4)
       RETURNING id, nome, email, cpf, avatar_url, cidade`,
      [nome, email, hash, cidade]
    );
    const user = rows[0];
    await ensureTypingEnrollment(user.id);
    const courses = await cursosAtivos(user.id);
    res.status(201).json({ token: signToken(user, courses), usuario: publicUser(user, courses) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Este e-mail já possui uma Conta F5.' });
    next(error);
  }
});

router.post('/kids/cadastro', authLimiter, async (req, res, next) => {
  let client;
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Cadastro ainda não configurado no servidor.' });
    const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
    const nomeLogin = normalizeLoginName(nome);
    const senha = String(req.body.senha || '');
    const cidade = String(req.body.cidade || '').trim().replace(/\s+/g, ' ');

    if (nome.length < 2 || nome.length > 40 || !/^[\p{L}\p{N} _.-]+$/u.test(nome)) {
      return res.status(400).json({ error: 'Use um nome ou apelido de 2 a 40 caracteres.' });
    }
    if (senha.length < 6 || senha.length > 100) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
    }
    if (cidade.length < 2 || cidade.length > 160) {
      return res.status(400).json({ error: 'Informe sua cidade.' });
    }

    client = await db.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM ead_usuarios WHERE LOWER(nome_login) = $1 AND deletado_em IS NULL LIMIT 1',
      [nomeLogin]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esse nome já existe. Escolha outro.' });
    }

    const hash = await bcrypt.hash(senha, 12);
    const { rows } = await client.query(
      `INSERT INTO ead_usuarios
        (nome, nome_login, email, senha_hash, cpf, cidade, perfil, ranking_publico)
       VALUES ($1, $2, NULL, $3, NULL, $4, 'kids', FALSE)
       RETURNING id, nome, nome_login, email, cpf, avatar_url, cidade, perfil`,
      [nome, nomeLogin, hash, cidade]
    );
    const user = rows[0];
    await ensureTypingEnrollment(user.id, DIGITACAO_KIDS_SLUG, client);
    await client.query('COMMIT');
    const courses = await cursosAtivos(user.id);
    res.status(201).json({ token: signToken(user, courses), usuario: publicUser(user, courses) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505') return res.status(409).json({ error: 'Esse nome já existe. Escolha outro.' });
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post('/google', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Login ainda não configurado no servidor.' });
    const credential = String(req.body.credential || '');
    if (!credential || credential.length > 5000) return res.status(400).json({ error: 'Credencial Google ausente.' });
    const google = await verifyGoogleCredential(credential);
    const email = normalizeEmail(google.email);
    const cidade = String(req.body.cidade || '').trim().replace(/\s+/g, ' ');
    if (cidade && (cidade.length < 2 || cidade.length > 160)) {
      return res.status(400).json({ error: 'Informe uma cidade válida.' });
    }

    let result = await db.query(
      `SELECT * FROM ead_usuarios
       WHERE deletado_em IS NULL AND (LOWER(email) = $1 OR google_sub = $2)
       LIMIT 1`,
      [email, google.sub]
    );
    let user = result.rows[0];
    if (!user) {
      if (cidade.length < 2 || cidade.length > 160) {
        return res.status(422).json({ error: 'Informe sua cidade para concluir o primeiro acesso com Google.', cidade_required: true });
      }
      result = await db.query(
        `INSERT INTO ead_usuarios (nome, email, senha_hash, cpf, google_sub, avatar_url, cidade)
         VALUES ($1, $2, NULL, NULL, $3, $4, $5)
         RETURNING *`,
        [google.name || email.split('@')[0], email, google.sub, google.picture || null, cidade]
      );
      user = result.rows[0];
    } else {
      if (!user.cidade && !cidade) {
        return res.status(422).json({ error: 'Informe sua cidade para completar sua Conta F5.', cidade_required: true });
      }
      result = await db.query(
        `UPDATE ead_usuarios
         SET google_sub = COALESCE(google_sub, $2), avatar_url = COALESCE($3, avatar_url),
             cidade = COALESCE(NULLIF($4, ''), cidade)
         WHERE id = $1 RETURNING *`,
        [user.id, google.sub, google.picture || null, cidade]
      );
      user = result.rows[0];
    }

    await ensureTypingEnrollment(user.id);
    const courses = await cursosAtivos(user.id);
    res.json({ token: signToken(user, courses), usuario: publicUser(user, courses) });
  } catch (error) {
    if (/Google|Token/.test(error.message)) return res.status(401).json({ error: 'Não foi possível confirmar sua Conta Google.' });
    next(error);
  }
});

// POST /api/conta-f5/kids/recuperar-senha — Recuperação amigável por Nome + Cidade OU E-mail do responsável
router.post('/kids/recuperar-senha', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Recuperação ainda não configurada no servidor.' });
    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
    const nomeLogin = normalizeLoginName(nome);
    const cidade = String(req.body.cidade || '').trim().replace(/\s+/g, ' ');
    const novaSenha = String(req.body.nova_senha || '');

    if (!novaSenha || novaSenha.length < 6 || novaSenha.length > 100) {
      return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    }

    let users = [];
    if (email && validEmail(email)) {
      // Busca pelo e-mail da conta ou e-mail de recuperação do responsável
      const q = await db.query(
        `SELECT * FROM ead_usuarios
         WHERE deletado_em IS NULL
           AND perfil = 'kids'
           AND (LOWER(email) = $1 OR LOWER(email_responsavel) = $1)
         LIMIT 1`,
        [email]
      );
      users = q.rows;
    } else {
      if (!nome || nome.length < 2) {
        return res.status(400).json({ error: 'Informe seu nome ou apelido (ou o e-mail cadastrado).' });
      }
      if (!cidade || cidade.length < 2) {
        return res.status(400).json({ error: 'Informe sua cidade cadastrada.' });
      }

      // Busca aluno Kids comparando nome e cidade (case-insensitive)
      const q = await db.query(
        `SELECT * FROM ead_usuarios
         WHERE deletado_em IS NULL
           AND perfil = 'kids'
           AND (LOWER(nome_login) = $1 OR LOWER(nome) = LOWER($2))
           AND LOWER(TRIM(cidade)) = LOWER(TRIM($3))
         LIMIT 1`,
        [nomeLogin, nome, cidade]
      );
      users = q.rows;
    }

    if (!users.length) {
      return res.status(404).json({
        error: email
          ? 'Nenhuma conta infantil foi encontrada com esse e-mail. Confira a digitação.'
          : 'Nome ou cidade não coincidem com os dados cadastrados. Confira como escreveu ou peça ajuda ao professor.'
      });
    }

    const user = users[0];
    const hash = await bcrypt.hash(novaSenha, 12);
    await db.query(
      'UPDATE ead_usuarios SET senha_hash = $1 WHERE id = $2',
      [hash, user.id]
    );

    // Se existir registro em digitacao_usuarios, atualiza também
    await db.query(
      'UPDATE digitacao_usuarios SET senha_hash = $1 WHERE ead_usuario_id = $2',
      [hash, user.id]
    ).catch(() => {});

    const courses = await cursosAtivos(user.id);
    const token = signToken(user, courses);

    res.json({
      ok: true,
      msg: 'Senha alterada com sucesso! Entrando...',
      token,
      usuario: publicUser(user, courses)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

