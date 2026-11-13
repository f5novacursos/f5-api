const express = require('express');
const crypto = require('crypto');
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

router.post('/kids/cadastro', async (req, res, next) => {
  let client;
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Cadastro ainda não configurado no servidor.' });
    const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
    const nomeLogin = normalizeLoginName(nome);
    const senha = String(req.body.senha || '');
    const cidade = String(req.body.cidade || '').trim().replace(/\s+/g, ' ');

    if (nome.length < 2 || nome.length > 40 || !/^[\p{L}\p{N} _.-]+$/u.test(nome)) {
      return res.status(400).json({ error: 'Use um nome ou apelido de 2 a 40 caracteres (prefira sem espaços para não esquecer).' });
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
      return res.status(409).json({ error: 'Esse nome já existe, escolha outro.' });
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
    if (error.code === '23505') return res.status(409).json({ error: 'Esse nome já existe, escolha outro.' });
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

// ── Recuperação de senha da Conta F5 (adulto) por código enviado via Resend ──
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'F5 Nova Cursos <nao-responder@f5novacursos.com.br>';
const RESET_CODE_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_SECONDS = 60;

let resetTableReady = null;
function ensureResetTable() {
  if (!resetTableReady) {
    resetTableReady = db.query(`
      CREATE TABLE IF NOT EXISTS conta_f5_reset_codigos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES ead_usuarios(id) ON DELETE CASCADE,
        codigo_hash VARCHAR(64) NOT NULL,
        expira_em TIMESTAMP NOT NULL,
        tentativas INTEGER NOT NULL DEFAULT 0,
        usado BOOLEAN NOT NULL DEFAULT FALSE,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `).catch((error) => { resetTableReady = null; throw error; });
  }
  return resetTableReady;
}

function hashResetCode(userId, code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(userId + ':' + code).digest('hex');
}

async function sendResetEmail(to, nome, code, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const primeiroNome = String(nome || '').split(' ')[0] || 'aluno';
    const subject = opts.subject || 'Seu código para redefinir a senha — F5 Nova Cursos';
    const intro = opts.intro || 'Use o código abaixo para criar uma nova senha na sua Conta F5.';
    const aviso = opts.aviso || 'Se você não pediu isso, ignore este e-mail. Sua senha não será alterada.';
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0a1628">
            <h2>Olá, ${primeiroNome.replace(/[<>&"]/g, '')}!</h2>
            <p>${intro} Ele vale por <strong>${RESET_CODE_MINUTES} minutos</strong>.</p>
            <p style="font-size:34px;letter-spacing:8px;font-weight:bold;background:#f4f6fa;padding:16px;text-align:center;border-radius:10px">${code}</p>
            <p style="color:#666;font-size:13px">${aviso}</p>
          </div>`,
        text: `${intro} Código: ${code}. Ele vale por ${RESET_CODE_MINUTES} minutos. ${aviso}`
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('Resend ' + response.status + ' ' + detail.slice(0, 200));
    }
  } finally {
    clearTimeout(timeout);
  }
}

// POST /api/conta-f5/esqueci-senha — envia um código de 6 dígitos para o e-mail da Conta F5
router.post('/esqueci-senha', authLimiter, async (req, res, next) => {
  const generic = { ok: true, msg: 'Se este e-mail tiver uma Conta F5, enviamos um código de 6 dígitos. Confira também o spam.' };
  try {
    if (!JWT_SECRET || !RESEND_API_KEY) {
      return res.status(503).json({ error: 'Recuperação por e-mail ainda não está disponível. Fale com a F5 pelo WhatsApp.' });
    }
    const email = normalizeEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });

    await ensureResetTable();
    const { rows } = await db.query(
      `SELECT id, nome, email FROM ead_usuarios
       WHERE LOWER(email) = $1 AND deletado_em IS NULL AND COALESCE(perfil, 'adulto') <> 'kids'
       LIMIT 1`,
      [email]
    );
    if (!rows.length) return res.json(generic);
    const user = rows[0];

    const recent = await db.query(
      `SELECT 1 FROM conta_f5_reset_codigos
       WHERE usuario_id = $1 AND criado_em > NOW() - ($2 || ' seconds')::interval`,
      [user.id, String(RESET_RESEND_SECONDS)]
    );
    if (recent.rows.length) return res.json(generic);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.query('DELETE FROM conta_f5_reset_codigos WHERE usuario_id = $1', [user.id]);
    await db.query(
      `INSERT INTO conta_f5_reset_codigos (usuario_id, codigo_hash, expira_em)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [user.id, hashResetCode(user.id, code), String(RESET_CODE_MINUTES)]
    );
    try {
      await sendResetEmail(user.email, user.nome, code);
    } catch (error) {
      await db.query('DELETE FROM conta_f5_reset_codigos WHERE usuario_id = $1', [user.id]).catch(() => {});
      console.error('[CONTA F5] Falha ao enviar e-mail de recuperação:', error.message);
      return res.status(502).json({ error: 'Não foi possível enviar o e-mail agora. Tente novamente em instantes.' });
    }
    res.json(generic);
  } catch (error) {
    next(error);
  }
});

// POST /api/conta-f5/redefinir-senha — valida o código e define a nova senha
router.post('/redefinir-senha', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Recuperação ainda não configurada no servidor.' });
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.codigo || '').replace(/\D/g, '');
    const novaSenha = String(req.body.nova_senha || '');
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (code.length !== 6) return res.status(400).json({ error: 'Digite o código de 6 dígitos que chegou no e-mail.' });
    if (novaSenha.length < 8 || novaSenha.length > 100) {
      return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
    }

    await ensureResetTable();
    const invalid = { error: 'Código inválido ou expirado. Peça um novo código.' };
    const found = await db.query(
      `SELECT * FROM ead_usuarios
       WHERE LOWER(email) = $1 AND deletado_em IS NULL AND COALESCE(perfil, 'adulto') <> 'kids'
       LIMIT 1`,
      [email]
    );
    if (!found.rows.length) return res.status(400).json(invalid);
    const user = found.rows[0];

    const stored = await db.query(
      `SELECT id, codigo_hash, tentativas FROM conta_f5_reset_codigos
       WHERE usuario_id = $1 AND usado = FALSE AND expira_em > NOW()
       ORDER BY id DESC LIMIT 1`,
      [user.id]
    );
    if (!stored.rows.length) return res.status(400).json(invalid);
    const record = stored.rows[0];
    if (record.tentativas >= RESET_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Muitas tentativas erradas. Peça um novo código.' });
    }

    const expected = Buffer.from(record.codigo_hash, 'hex');
    const received = Buffer.from(hashResetCode(user.id, code), 'hex');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      await db.query('UPDATE conta_f5_reset_codigos SET tentativas = tentativas + 1 WHERE id = $1', [record.id]);
      return res.status(400).json(invalid);
    }

    const hash = await bcrypt.hash(novaSenha, 12);
    await db.query('UPDATE ead_usuarios SET senha_hash = $1 WHERE id = $2', [hash, user.id]);
    await db.query('UPDATE digitacao_usuarios SET senha_hash = $1 WHERE ead_usuario_id = $2', [hash, user.id]).catch(() => {});
    await db.query('DELETE FROM conta_f5_reset_codigos WHERE usuario_id = $1', [user.id]);

    const courses = await cursosAtivos(user.id);
    res.json({
      ok: true,
      msg: 'Senha alterada com sucesso! Entrando...',
      token: signToken(user, courses),
      usuario: publicUser(user, courses)
    });
  } catch (error) {
    next(error);
  }
});

// ── Troca de e-mail da Conta F5 (aluno logado) com código enviado ao e-mail NOVO ──
let emailTableReady = null;
function ensureEmailChangeTable() {
  if (!emailTableReady) {
    emailTableReady = db.query(`
      CREATE TABLE IF NOT EXISTS conta_f5_email_codigos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES ead_usuarios(id) ON DELETE CASCADE,
        novo_email VARCHAR(180) NOT NULL,
        codigo_hash VARCHAR(64) NOT NULL,
        expira_em TIMESTAMP NOT NULL,
        tentativas INTEGER NOT NULL DEFAULT 0,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `).catch((error) => { emailTableReady = null; throw error; });
  }
  return emailTableReady;
}

function alunoAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !JWT_SECRET) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || payload.role === 'admin' || !payload.id) return res.status(403).json({ error: 'Acesso não permitido.' });
    req.aluno = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
  }
}

// E-mail já usado por outra conta (EAD ou Digitação)?
async function emailEmUso(email, usuarioId) {
  const ead = await db.query(
    'SELECT 1 FROM ead_usuarios WHERE LOWER(email) = $1 AND deletado_em IS NULL AND id <> $2 LIMIT 1',
    [email, usuarioId]
  );
  if (ead.rows.length) return true;
  const dig = await db.query(
    'SELECT 1 FROM digitacao_usuarios WHERE LOWER(email) = $1 AND ead_usuario_id IS DISTINCT FROM $2 LIMIT 1',
    [email, usuarioId]
  ).catch(() => ({ rows: [] }));
  return dig.rows.length > 0;
}

function hashEmailCode(userId, novoEmail, code) {
  return crypto.createHmac('sha256', JWT_SECRET).update('email:' + userId + ':' + novoEmail + ':' + code).digest('hex');
}

// POST /api/conta-f5/email/solicitar — envia código para o e-mail novo
router.post('/email/solicitar', authLimiter, alunoAuth, async (req, res, next) => {
  try {
    if (!RESEND_API_KEY) return res.status(503).json({ error: 'Troca de e-mail ainda não está disponível. Fale com a F5 pelo WhatsApp.' });
    const novoEmail = normalizeEmail(req.body.novo_email);
    const senha = String(req.body.senha || '');
    if (!validEmail(novoEmail) || novoEmail.length > 180) return res.status(400).json({ error: 'Informe um e-mail válido.' });

    await ensureEmailChangeTable();
    const found = await db.query('SELECT * FROM ead_usuarios WHERE id = $1 AND deletado_em IS NULL', [req.aluno.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Conta não encontrada.' });
    const user = found.rows[0];
    if (user.perfil === 'kids') return res.status(400).json({ error: 'Contas Kids usam o e-mail do responsável. Peça ajuda ao professor.' });
    if (normalizeEmail(user.email) === novoEmail) return res.status(400).json({ error: 'Esse já é o e-mail da sua conta.' });

    // Quem tem senha precisa confirmá-la. Conta criada só com Google já está autenticada pelo Google.
    if (user.senha_hash) {
      if (!senha || !(await bcrypt.compare(senha, user.senha_hash))) {
        return res.status(403).json({ error: 'Senha atual incorreta.' });
      }
    }
    if (await emailEmUso(novoEmail, user.id)) {
      return res.status(409).json({ error: 'Este e-mail já está em uso por outra conta.' });
    }

    const recent = await db.query(
      `SELECT 1 FROM conta_f5_email_codigos
       WHERE usuario_id = $1 AND criado_em > NOW() - ($2 || ' seconds')::interval`,
      [user.id, String(RESET_RESEND_SECONDS)]
    );
    if (recent.rows.length) return res.status(429).json({ error: 'Aguarde um minuto para pedir um novo código.' });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.query('DELETE FROM conta_f5_email_codigos WHERE usuario_id = $1', [user.id]);
    await db.query(
      `INSERT INTO conta_f5_email_codigos (usuario_id, novo_email, codigo_hash, expira_em)
       VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
      [user.id, novoEmail, hashEmailCode(user.id, novoEmail, code), String(RESET_CODE_MINUTES)]
    );
    try {
      await sendResetEmail(novoEmail, user.nome, code, {
        subject: 'Confirme seu novo e-mail — F5 Nova Cursos',
        intro: 'Use o código abaixo para confirmar este e-mail como o novo e-mail da sua Conta F5.',
        aviso: 'Se você não pediu isso, ignore este e-mail. Nada será alterado.'
      });
    } catch (error) {
      await db.query('DELETE FROM conta_f5_email_codigos WHERE usuario_id = $1', [user.id]).catch(() => {});
      console.error('[CONTA F5] Falha ao enviar código de troca de e-mail:', error.message);
      return res.status(502).json({ error: 'Não foi possível enviar o e-mail agora. Confira se digitou certo e tente de novo.' });
    }
    res.json({ ok: true, msg: 'Enviamos um código de 6 dígitos para ' + novoEmail + '. Confira também o spam.' });
  } catch (error) {
    next(error);
  }
});

// POST /api/conta-f5/email/confirmar — valida o código e troca o e-mail
router.post('/email/confirmar', authLimiter, alunoAuth, async (req, res, next) => {
  try {
    const code = String(req.body.codigo || '').replace(/\D/g, '');
    if (code.length !== 6) return res.status(400).json({ error: 'Digite o código de 6 dígitos que chegou no e-mail novo.' });

    await ensureEmailChangeTable();
    const invalid = { error: 'Código inválido ou expirado. Peça um novo código.' };
    const stored = await db.query(
      `SELECT * FROM conta_f5_email_codigos
       WHERE usuario_id = $1 AND expira_em > NOW() ORDER BY id DESC LIMIT 1`,
      [req.aluno.id]
    );
    if (!stored.rows.length) return res.status(400).json(invalid);
    const record = stored.rows[0];
    if (record.tentativas >= RESET_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Muitas tentativas erradas. Peça um novo código.' });
    }

    const expected = Buffer.from(record.codigo_hash, 'hex');
    const received = Buffer.from(hashEmailCode(record.usuario_id, record.novo_email, code), 'hex');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      await db.query('UPDATE conta_f5_email_codigos SET tentativas = tentativas + 1 WHERE id = $1', [record.id]);
      return res.status(400).json(invalid);
    }

    if (await emailEmUso(record.novo_email, record.usuario_id)) {
      await db.query('DELETE FROM conta_f5_email_codigos WHERE usuario_id = $1', [record.usuario_id]);
      return res.status(409).json({ error: 'Este e-mail passou a ser usado por outra conta.' });
    }

    const before = await db.query('SELECT email FROM ead_usuarios WHERE id = $1', [record.usuario_id]);
    const emailAntigo = before.rows[0] ? before.rows[0].email : null;
    const updated = await db.query(
      'UPDATE ead_usuarios SET email = $1 WHERE id = $2 AND deletado_em IS NULL RETURNING *',
      [record.novo_email, record.usuario_id]
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'Conta não encontrada.' });
    await db.query('UPDATE digitacao_usuarios SET email = $1 WHERE ead_usuario_id = $2', [record.novo_email, record.usuario_id]).catch(() => {});
    await db.query('DELETE FROM conta_f5_email_codigos WHERE usuario_id = $1', [record.usuario_id]);
    await db.query('DELETE FROM conta_f5_reset_codigos WHERE usuario_id = $1', [record.usuario_id]).catch(() => {});

    // Avisa o e-mail antigo (melhor esforço): protege contra troca indevida.
    if (emailAntigo && RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [emailAntigo],
          subject: 'O e-mail da sua Conta F5 foi alterado',
          html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0a1628"><p>O e-mail da sua Conta F5 foi alterado para <strong>' +
            record.novo_email.replace(/[<>&"]/g, '') + '</strong>.</p><p style="color:#666;font-size:13px">Se não foi você, fale com a F5 pelo WhatsApp.</p></div>'
        })
      }).catch(() => {});
    }

    const user = updated.rows[0];
    const courses = await cursosAtivos(user.id);
    res.json({ ok: true, msg: 'E-mail alterado com sucesso!', usuario: publicUser(user, courses) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

