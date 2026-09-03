const router = require('express').Router();
const db = require('../db');
const lixeira = require('../lib/lixeira');
const r2 = require('../lib/r2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
// Rate limiting simples sem dependência externa (Map em memória)
const _rlStore = new Map();
function _makeRateLimiter(windowMs, max, msg) {
  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = _rlStore.get(ip + req.path);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      _rlStore.set(ip + req.path, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: msg });
    }
    next();
  };
}

const loginLimiter   = _makeRateLimiter(15 * 60 * 1000, 10, 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.');
const cadastroLimiter = _makeRateLimiter(60 * 60 * 1000,  5, 'Muitos cadastros realizados. Tente novamente em 1 hora.');

const JWT_SECRET = process.env.EAD_JWT_SECRET || 'ead2026secret';
if (!process.env.EAD_JWT_SECRET) console.warn('[EAD] AVISO: EAD_JWT_SECRET não definida — usando valor padrão inseguro!');
const JWT_EXPIRY = '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '163041222391-rmnha7n1jcni0nu19bflgvpq6f6ufm0j.apps.googleusercontent.com';
const DIGITACAO_SLUG = 'curso-digitacao-f5';
const DIGITACAO_KIDS_SLUG = 'curso-digitacao-f5-kids';

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const adminAuth = require('../middleware/adminAuth');

const BASE_URL = process.env.BASE_URL || 'https://f5novacursos.com.br';

function criarTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
  });
}

// Normaliza texto: remove acento e baixa caixa (p/ casar nomes de turma/curso)
function _norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function normalizarNomeLogin(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Dado o nome da turma/curso presencial, retorna os TÍTULOS de cursos EAD elegíveis.
// Robusto a acento ("Informática") e sem o falso 'ia' (que pegava Excel/Design).
function cursosEadElegiveis(...nomes) {
  const t = _norm(nomes.filter(Boolean).join(' '));
  const titulos = [];
  if (t.includes('informatica')) titulos.push('Informática Profissional + IA EAD');
  if (t.includes('excel'))       titulos.push('Excel Profissional + IA EAD');
  return titulos;
}

// Garantir que a pasta privada de vídeos exista
const videosDir = path.join(__dirname, '../private/videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// ── AUTO-MIGRATION E SEEDING ──────────────────────────────────────────
async function initEadDatabase() {
  // 1. Cursos EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_cursos (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(200) NOT NULL,
      descricao TEXT,
      categoria VARCHAR(100) DEFAULT 'Informática',
      carga_horaria INTEGER NOT NULL DEFAULT 20,
      preco NUMERIC(10,2) NOT NULL DEFAULT 0.00,
      icone VARCHAR(20) DEFAULT '💻',
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 2. Módulos EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_modulos (
      id SERIAL PRIMARY KEY,
      curso_id INTEGER REFERENCES ead_cursos(id) ON DELETE CASCADE,
      titulo VARCHAR(200) NOT NULL,
      ordem INTEGER DEFAULT 0,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 3. Aulas EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_aulas (
      id SERIAL PRIMARY KEY,
      modulo_id INTEGER REFERENCES ead_modulos(id) ON DELETE CASCADE,
      titulo VARCHAR(200) NOT NULL,
      url VARCHAR(500),
      duracao INTEGER NOT NULL DEFAULT 10,
      material TEXT,
      gratis BOOLEAN DEFAULT false,
      ordem INTEGER DEFAULT 0,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 4. Usuários EAD (Alunos Públicos / Vendas Web)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      senha_hash VARCHAR(255) NOT NULL,
      cpf VARCHAR(14) UNIQUE NOT NULL,
      telefone VARCHAR(20),
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 5. Matrículas EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_matriculas (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES ead_usuarios(id) ON DELETE SET NULL,
      aluno_id INTEGER REFERENCES alunos(id) ON DELETE SET NULL,
      curso_id INTEGER REFERENCES ead_cursos(id) ON DELETE CASCADE,
      data_matricula TIMESTAMP DEFAULT NOW(),
      status VARCHAR(20) DEFAULT 'ativa',
      order_nsu VARCHAR(60),
      transaction_nsu VARCHAR(100),
      receipt_url VARCHAR(500),
      UNIQUE (usuario_id, curso_id),
      UNIQUE (aluno_id, curso_id)
    )
  `);

  // 6. Progresso do Aluno EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_progresso (
      id SERIAL PRIMARY KEY,
      matricula_id INTEGER REFERENCES ead_matriculas(id) ON DELETE CASCADE,
      aula_id INTEGER REFERENCES ead_aulas(id) ON DELETE CASCADE,
      concluida BOOLEAN DEFAULT true,
      data_conclusao TIMESTAMP DEFAULT NOW(),
      UNIQUE (matricula_id, aula_id)
    )
  `);

  // 7. Certificados EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_certificados (
      id SERIAL PRIMARY KEY,
      matricula_id INTEGER REFERENCES ead_matriculas(id) ON DELETE CASCADE UNIQUE,
      codigo VARCHAR(50) UNIQUE NOT NULL,
      data_emissao TIMESTAMP DEFAULT NOW()
    )
  `);

  // 8. Tokens de reset de senha
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_reset_tokens (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES ead_usuarios(id) ON DELETE CASCADE,
      token VARCHAR(64) UNIQUE NOT NULL,
      expira_em TIMESTAMPTZ NOT NULL,
      usado BOOLEAN DEFAULT FALSE,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Colunas adicionadas depois (idempotente)
  await db.query(`ALTER TABLE ead_cursos ADD COLUMN IF NOT EXISTS imagem VARCHAR(500)`);
  // imagem pode guardar URL OU a própria imagem (data URI base64) — precisa caber
  await db.query(`ALTER TABLE ead_cursos ALTER COLUMN imagem TYPE TEXT`);
  // EAD melhorias 2026-06-22: descrição da aula/módulo + material como ARQUIVO (chave R2 ou URL)
  await db.query(`ALTER TABLE ead_aulas ADD COLUMN IF NOT EXISTS descricao TEXT`);
  await db.query(`ALTER TABLE ead_aulas ADD COLUMN IF NOT EXISTS material_url TEXT`);
  await db.query(`ALTER TABLE ead_modulos ADD COLUMN IF NOT EXISTS descricao TEXT`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS deletado_em TIMESTAMP`);
  // Conta F5 unificada: aluno gratuito pode entrar sem CPF/senha local (Google).
  // Cadastros antigos permanecem intactos e continuam usando CPF quando disponível.
  await db.query(`ALTER TABLE ead_usuarios ALTER COLUMN cpf DROP NOT NULL`);
  await db.query(`ALTER TABLE ead_usuarios ALTER COLUMN senha_hash DROP NOT NULL`);
  await db.query(`ALTER TABLE ead_usuarios ALTER COLUMN email DROP NOT NULL`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS cidade VARCHAR(160)`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS nome_login VARCHAR(80)`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS perfil VARCHAR(20) NOT NULL DEFAULT 'adulto'`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS ranking_publico BOOLEAN NOT NULL DEFAULT TRUE`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ead_usuarios_google_sub_unique ON ead_usuarios (google_sub) WHERE google_sub IS NOT NULL`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ead_usuarios_nome_login_unique ON ead_usuarios (LOWER(nome_login)) WHERE nome_login IS NOT NULL AND deletado_em IS NULL`);
  await db.query(`ALTER TABLE ead_cursos ADD COLUMN IF NOT EXISTS slug VARCHAR(120)`);
  await db.query(`ALTER TABLE ead_cursos ADD COLUMN IF NOT EXISTS tipo_conteudo VARCHAR(30) NOT NULL DEFAULT 'ead'`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ead_cursos_slug_unique ON ead_cursos (slug) WHERE slug IS NOT NULL`);
  // venda_publica: chave por curso — DEFAULT false pra tudo que já existe (ninguém
  // vende pro público até o admin ligar curso por curso, conforme for terminando
  // a gravação). Aluno presencial elegível continua tendo acesso independente disso
  // (a matrícula dele é criada direto no login, nunca passa pelo checkout).
  await db.query(`ALTER TABLE ead_cursos ADD COLUMN IF NOT EXISTS venda_publica BOOLEAN DEFAULT false`);

  // Popular cursos iniciais se vazia
  const { rows } = await db.query('SELECT COUNT(*) FROM ead_cursos');
  if (parseInt(rows[0].count) === 0) {
    await db.query(`
      INSERT INTO ead_cursos (titulo, descricao, categoria, carga_horaria, preco, icone) VALUES
      ('Informática Profissional + IA EAD', 'Domine o computador, o sistema operacional e as principais ferramentas de Inteligência Artificial para alavancar seu currículo.', 'Informática', 60, 149.90, '💻'),
      ('Excel Profissional + IA EAD', 'Aprenda planilhas, fórmulas complexas, gráficos avançados e relatórios integrados com IA.', 'Excel / Office', 40, 90.00, '📊')
    `);
    console.log('[EAD] Cursos iniciais semeados no banco.');
  }

  await db.query(`
    INSERT INTO ead_cursos
      (titulo, descricao, categoria, carga_horaria, preco, icone, ativo, venda_publica, slug, tipo_conteudo)
    VALUES
      ('Curso de Digitação F5', 'Aprenda digitação profissional com teclado ABNT2, precisão, velocidade e situações reais de trabalho.', 'Digitação', 20, 0, '⌨️', TRUE, FALSE, $1, 'digitacao')
    ON CONFLICT DO NOTHING
  `, [DIGITACAO_SLUG]);
  await db.query(`
    INSERT INTO ead_cursos
      (titulo, descricao, categoria, carga_horaria, preco, icone, ativo, venda_publica, slug, tipo_conteudo)
    VALUES
      ('Digitação F5 Kids', 'Aprenda letras, palavras e o teclado brasileiro com atividades e jogos feitos para crianças e pré-adolescentes.', 'Digitação', 15, 0, '🌟', TRUE, FALSE, $1, 'digitacao-kids')
    ON CONFLICT DO NOTHING
  `, [DIGITACAO_KIDS_SLUG]);

  // 9. Suporte / Chat com Alunos
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_suporte_mensagens (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES ead_usuarios(id) ON DELETE CASCADE,
      aluno_id INTEGER REFERENCES alunos(id) ON DELETE CASCADE,
      curso_id INTEGER REFERENCES ead_cursos(id) ON DELETE SET NULL,
      contexto TEXT,
      categoria VARCHAR(50) DEFAULT 'duvida',
      remetente VARCHAR(20) NOT NULL,
      mensagem TEXT NOT NULL,
      lida_pelo_admin BOOLEAN DEFAULT FALSE,
      lida_pelo_aluno BOOLEAN DEFAULT FALSE,
      status VARCHAR(20) DEFAULT 'aberto',
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);
}
initEadDatabase().catch(err => console.error('[EAD] Erro na migração EAD:', err.message));


// ── MIDDLEWARE DE AUTENTICAÇÃO ────────────────────────────────────────
function eadAuthMiddleware(req, res, next) {
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

// Middleware de Admin
function eadAdminMiddleware(req, res, next) {
  eadAuthMiddleware(req, res, () => {
    if (req.user && req.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Acesso restrito ao administrador' });
    }
  });
}


async function obterCursoDigitacao(slug = DIGITACAO_SLUG) {
  const { rows } = await db.query(
    `SELECT id, titulo, slug, tipo_conteudo FROM ead_cursos WHERE slug = $1 AND ativo = TRUE LIMIT 1`,
    [slug]
  );
  if (!rows.length) throw new Error('Curso de Digitação não configurado.');
  return rows[0];
}

async function garantirMatriculaDigitacao(tipo, usuarioId, perfil = 'adulto') {
  const slug = perfil === 'kids' ? DIGITACAO_KIDS_SLUG : DIGITACAO_SLUG;
  const curso = await obterCursoDigitacao(slug);
  const campo = tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
  const conflito = tipo === 'presencial' ? '(aluno_id, curso_id)' : '(usuario_id, curso_id)';
  await db.query(
    `INSERT INTO ead_matriculas (${campo}, curso_id, status)
     VALUES ($1, $2, 'ativa')
     ON CONFLICT ${conflito} DO UPDATE SET status = 'ativa'`,
    [usuarioId, curso.id]
  );
  return curso.id;
}

async function cursosAtivosDaConta(tipo, usuarioId) {
  const campo = tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
  const { rows } = await db.query(
    `SELECT curso_id FROM ead_matriculas WHERE ${campo} = $1 AND status = 'ativa' ORDER BY curso_id`,
    [usuarioId]
  );
  return rows.map((row) => row.curso_id);
}

function assinarContaEad(usuario, tipo, cursos) {
  return jwt.sign(
    { id: usuario.id, nome: usuario.nome, cpf: usuario.cpf || null, tipo, role: 'student', cursos, perfil: usuario.perfil || 'adulto' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

async function validarCredencialGoogle(credential) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: controller.signal }
    );
    const payload = await response.json();
    const valido = response.ok && payload.aud === GOOGLE_CLIENT_ID
      && String(payload.email_verified) === 'true' && payload.email && payload.sub;
    if (!valido) throw new Error('Token Google inválido.');
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

// ── ROTAS DE AUTENTICAÇÃO ─────────────────────────────────────────────

// POST /api/ead/auth/login
router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { cpf, email, usuario, senha } = req.body;

    // Fluxo Aluno Acadêmico (Presencial) via CPF
    if (cpf && !senha && !email && !usuario) {
      const cpfLimpo = cpf.replace(/\D/g, '');
      if (cpfLimpo.length < 11) return res.status(400).json({ error: 'CPF inválido.' });

      // Busca na tabela alunos da escola
      const { rows: alunos } = await db.query(
        `SELECT a.*, t.nome AS turma_curso_nome
         FROM alunos a
         LEFT JOIN turmas t ON a.turma_id = t.id
         WHERE REPLACE(REPLACE(a.cpf, '.', ''), '-', '') = $1 AND a.status IN ('ativo', 'formado')`,
        [cpfLimpo]
      );

      if (!alunos.length) {
        return res.status(401).json({ error: 'Aluno não encontrado no sistema acadêmico ou inativo.' });
      }

      const aluno = alunos[0];

      // Mapear cursos ead elegíveis com base na turma (ou curso) do presencial
      const cursosElegiveis = cursosEadElegiveis(aluno.turma_curso_nome, aluno.curso);

      // Buscar os IDs correspondentes na tabela ead_cursos
      const eadCursos = cursosElegiveis.length
        ? (await db.query('SELECT id, titulo FROM ead_cursos WHERE titulo = ANY($1)', [cursosElegiveis])).rows
        : [];

      // Todo aluno presencial ativo ou formado recebe Digitação Profissional,
      // independentemente de a turma possuir outro equivalente no EAD.
      const digitacaoId = await garantirMatriculaDigitacao('presencial', aluno.id, 'adulto');
      const cursosLiberadosIds = [digitacaoId];

      // Inserir também as matrículas equivalentes à turma, quando existirem.
      for (const eadCurso of eadCursos) {
        if (!cursosLiberadosIds.includes(eadCurso.id)) cursosLiberadosIds.push(eadCurso.id);
        await db.query(
          `INSERT INTO ead_matriculas (aluno_id, curso_id, status)
           VALUES ($1, $2, 'ativa')
           ON CONFLICT (aluno_id, curso_id) DO NOTHING`,
          [aluno.id, eadCurso.id]
        );
      }

      // Gerar Token JWT
      const token = jwt.sign(
        { id: aluno.id, nome: aluno.nome, cpf: aluno.cpf, tipo: 'presencial', role: 'student', cursos: cursosLiberadosIds },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );

      return res.json({
        ok: true,
        token,
        usuario: {
          id: aluno.id,
          nome: aluno.nome,
          cpf: aluno.cpf,
          tipo: 'presencial',
          role: 'student',
          cursos: cursosLiberadosIds
        }
      });
    }

    // Fluxo Aluno Público (Web / Venda) via E-mail ou CPF + Senha
    const idRaw = (email || usuario || cpf || '').trim();
    if (!idRaw || !senha) {
      return res.status(400).json({ error: 'Preencha CPF, e-mail ou nome e senha.' });
    }
    const idEmail = idRaw.toLowerCase();        // casa por e-mail (mesmo com dígitos)
    const idNome = normalizarNomeLogin(idRaw);  // casa por nome Kids sem diferenciar acentos
    const idDigits = idRaw.replace(/\D/g, '');  // casa por CPF (só os números)

    const { rows: users } = await db.query(
      `SELECT * FROM ead_usuarios
       WHERE deletado_em IS NULL AND (
         LOWER(email) = $1 OR LOWER(nome_login) = $3 OR
         ($2 <> '' AND REPLACE(REPLACE(cpf, '.', ''), '-', '') = $2)
       )`,
      [idEmail, idDigits, idNome]
    );

    if (!users.length) {
      return res.status(401).json({ error: 'Usuário não encontrado ou senha inválida.' });
    }

    const user = users[0];
    const ok = user.senha_hash ? bcrypt.compareSync(senha, user.senha_hash) : false;
    if (!ok) return res.status(401).json({ error: 'Usuário não encontrado ou senha inválida.' });

    // O Curso de Digitação é gratuito e acompanha toda Conta F5.
    await garantirMatriculaDigitacao('web', user.id, user.perfil);

    // Buscar as matrículas ativas do usuário web
    const { rows: mats } = await db.query(
      "SELECT curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'",
      [user.id]
    );
    const cursosIds = mats.map(m => m.curso_id);

    const token = jwt.sign(
      { id: user.id, nome: user.nome, cpf: user.cpf, tipo: 'web', role: 'student', cursos: cursosIds, perfil: user.perfil || 'adulto' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      ok: true,
      token,
      usuario: {
        id: user.id,
        nome: user.nome,
        cpf: user.cpf,
        email: user.email,
        usuario: user.nome_login || null,
        cidade: user.cidade || null,
        avatar_url: user.avatar_url || null,
        tipo: 'web',
        role: 'student',
        perfil: user.perfil || 'adulto',
        cursos: cursosIds
      }
    });

  } catch(e) { next(e); }
});

// GET /api/ead/auth/me — renova a sessão e inclui matrículas criadas após o login.
router.get('/auth/me', eadAuthMiddleware, async (req, res, next) => {
  try {
    if (req.user.tipo !== 'web') {
      return res.json({ ok: true, token: req.headers.authorization.slice(7), usuario: req.user });
    }
    const { rows } = await db.query(
      'SELECT id, nome, email, cpf, cidade, avatar_url, nome_login, perfil FROM ead_usuarios WHERE id = $1 AND deletado_em IS NULL',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Conta indisponível.' });
    await garantirMatriculaDigitacao('web', user.id, user.perfil);
    const cursos = await cursosAtivosDaConta('web', user.id);
    const token = assinarContaEad(user, 'web', cursos);
    res.json({
      ok: true,
      token,
      usuario: {
        id: user.id, nome: user.nome, email: user.email, cpf: user.cpf || null,
        usuario: user.nome_login || null, perfil: user.perfil || 'adulto',
        cidade: user.cidade || null, avatar_url: user.avatar_url || null,
        tipo: 'web', role: 'student', cursos
      }
    });
  } catch (error) { next(error); }
});

// POST /api/ead/auth/admin-token — troca a sessão Google do ERP (adminAuth) por
// um JWT de admin do EAD. Existia antes como bypass público (POST /auth/login
// com cpf/nascimento fixos, valores que ficavam expostos no admin/js/ead.js do
// repositório público) — qualquer um conseguia virar admin do EAD sem senha
// nenhuma. Agora só emite o token pra quem já passou pelo login Google do ERP.
router.post('/auth/admin-token', adminAuth, async (req, res) => {
  const token = jwt.sign(
    { id: 0, nome: 'Administrador EAD', role: 'admin' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  res.json({ ok: true, token, usuario: { nome: 'Administrador EAD', role: 'admin' } });
});

// POST /api/ead/auth/cadastro
router.post('/auth/cadastro', cadastroLimiter, async (req, res, next) => {
  try {
    const { nome, email, senha, cpf, telefone } = req.body;
    if (!nome || !email || !senha || !cpf) {
      return res.status(400).json({ error: 'Nome, E-mail, Senha e CPF são obrigatórios.' });
    }

    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length < 11) return res.status(400).json({ error: 'CPF inválido.' });

    const hash = bcrypt.hashSync(senha, 10);

    const { rows } = await db.query(
      `INSERT INTO ead_usuarios (nome, email, senha_hash, cpf, telefone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, cpf, telefone`,
      [nome, email.toLowerCase().trim(), hash, cpfLimpo, telefone || null]
    );

    res.status(201).json({ ok: true, usuario: rows[0] });
  } catch(e) {
    if (e.message.includes('unique') || e.code === '23505') {
      return res.status(400).json({ error: 'E-mail ou CPF já cadastrado no sistema EAD.' });
    }
    next(e);
  }
});


// POST /api/ead/auth/esqueci-senha
router.post('/auth/esqueci-senha', loginLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail obrigatório.' });

    const { rows } = await db.query(
      `SELECT id, nome FROM ead_usuarios WHERE LOWER(email) = LOWER($1) AND deletado_em IS NULL`,
      [email.trim()]
    );

    // Resposta genérica — não revela se o e-mail existe ou não
    if (!rows.length) {
      return res.json({ ok: true, msg: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.' });
    }

    const usuario = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    // Invalida tokens anteriores deste usuário e insere novo
    await db.query(`DELETE FROM ead_reset_tokens WHERE usuario_id = $1`, [usuario.id]);
    await db.query(
      `INSERT INTO ead_reset_tokens (usuario_id, token, expira_em) VALUES ($1, $2, $3)`,
      [usuario.id, token, expira]
    );

    const link = `${BASE_URL}/ead.html?reset=${token}`;
    const transporter = criarTransporter();

    if (transporter) {
      await transporter.sendMail({
        from: `"F5 Nova Cursos" <${process.env.GMAIL_USER}>`,
        to: email.trim(),
        subject: 'Recuperação de senha — F5 Nova Cursos EAD',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto">
            <h2 style="color:#0a1628">Olá, ${usuario.nome}!</h2>
            <p>Recebemos uma solicitação para redefinir sua senha no portal EAD da F5 Nova Cursos.</p>
            <p>Clique no botão abaixo para criar uma nova senha. O link expira em <strong>1 hora</strong>.</p>
            <a href="${link}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#f3ad1c;color:#0a1628;font-weight:bold;border-radius:8px;text-decoration:none">Redefinir minha senha</a>
            <p style="color:#888;font-size:.85rem">Se você não solicitou isso, ignore este e-mail. Sua senha não será alterada.</p>
          </div>
        `
      });
    } else {
      console.warn('[EAD] GMAIL_USER/GMAIL_PASS não configurados — e-mail de reset não enviado. Token:', token);
    }

    res.json({ ok: true, msg: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.' });
  } catch(e) { next(e); }
});

// POST /api/ead/auth/reset-senha
router.post('/auth/reset-senha', async (req, res, next) => {
  try {
    const { token, senha } = req.body;
    if (!token || !senha) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
    if (senha.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });

    const { rows } = await db.query(
      `SELECT * FROM ead_reset_tokens WHERE token = $1 AND usado = FALSE AND expira_em > NOW()`,
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'Link inválido ou expirado. Solicite um novo.' });
    }

    const resetToken = rows[0];
    const hash = bcrypt.hashSync(senha, 10);

    await db.query(`UPDATE ead_usuarios SET senha_hash = $1 WHERE id = $2`, [hash, resetToken.usuario_id]);
    await db.query(`UPDATE ead_reset_tokens SET usado = TRUE WHERE id = $1`, [resetToken.id]);

    res.json({ ok: true, msg: 'Senha alterada com sucesso! Faça login com a nova senha.' });
  } catch(e) { next(e); }
});


// ── ROTAS DE CURSOS & AULAS ───────────────────────────────────────────

// GET /api/ead/cursos
router.get('/cursos', async (req, res, next) => {
  try {
    // Listar cursos EAD ativos
    const { rows: cursos } = await db.query('SELECT * FROM ead_cursos WHERE ativo = true ORDER BY id');

    // Obter árvore de módulos e aulas
    for (const curso of cursos) {
      const { rows: modulos } = await db.query(
        'SELECT * FROM ead_modulos WHERE curso_id = $1 ORDER BY ordem ASC, id ASC',
        [curso.id]
      );

      for (const modulo of modulos) {
        // NÃO expõe a.url (chave do vídeo é segredo) — só o booleano tem_video p/ o admin.
        // material_url é a chave/URL do PDF/arquivo (não é segredo de acesso); tem_material idem.
        const { rows: aulas } = await db.query(
          `SELECT id, modulo_id, titulo, descricao, duracao, material, material_url, gratis, ordem,
                  (url IS NOT NULL AND url <> '') AS tem_video
           FROM ead_aulas WHERE modulo_id = $1 ORDER BY ordem ASC, id ASC`,
          [modulo.id]
        );
        aulas.forEach(a => { a.tem_material = !!(a.material_url && String(a.material_url).trim()); });
        modulo.aulas = aulas;
      }

      curso.modulos = modulos;
    }

    res.json(cursos);
  } catch(e) { next(e); }
});

// POST /api/ead/cursos (Admin)
router.post('/cursos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { titulo, descricao, categoria, carga_horaria, preco, icone, imagem, venda_publica } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título do curso é obrigatório.' });

    const { rows } = await db.query(
      `INSERT INTO ead_cursos (titulo, descricao, categoria, carga_horaria, preco, icone, imagem, venda_publica)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [titulo, descricao || '', categoria || 'Informática', parseInt(carga_horaria) || 20, parseFloat(preco) || 0.00, icone || '💻', imagem || null, Boolean(venda_publica)]
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/cursos/:id (Admin)
router.put('/cursos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    const { titulo, descricao, categoria, carga_horaria, preco, icone, imagem } = b;
    const { rows } = await db.query(
      `UPDATE ead_cursos SET
         titulo = COALESCE($1, titulo),
         descricao = COALESCE($2, descricao),
         categoria = COALESCE($3, categoria),
         carga_horaria = COALESCE($4, carga_horaria),
         preco = COALESCE($5, preco),
         icone = COALESCE($6, icone),
         imagem = COALESCE($7, imagem),
         venda_publica = CASE WHEN $9::boolean THEN $10::boolean ELSE venda_publica END
       WHERE id = $8 RETURNING *`,
      [titulo, descricao, categoria, carga_horaria, preco, icone, imagem, req.params.id, has('venda_publica'), Boolean(b.venda_publica)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Curso não encontrado.' });
    res.json(rows[0]);
  } catch(e) { next(e); }
});

// DELETE /api/ead/cursos/:id (Admin) — manda o curso EAD (módulos+aulas) pra Lixeira
router.delete('/cursos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: c } = await db.query('SELECT * FROM ead_cursos WHERE id=$1', [id]);
    if (!c.length) return res.status(404).json({ error: 'Curso não encontrado.' });
    const curso = c[0];
    if (curso.tipo_conteudo === 'digitacao' || curso.tipo_conteudo === 'digitacao-kids'
        || curso.slug === DIGITACAO_SLUG || curso.slug === DIGITACAO_KIDS_SLUG) {
      return res.status(409).json({ error: 'O Curso de Digitação F5 é integrado ao sistema e não pode ser excluído.' });
    }
    const { rows: modulos } = await db.query('SELECT * FROM ead_modulos WHERE curso_id=$1', [id]);
    const { rows: aulas } = modulos.length
      ? await db.query('SELECT * FROM ead_aulas WHERE modulo_id = ANY($1)', [modulos.map(m => m.id)])
      : { rows: [] };
    await lixeira.guardar({
      entidade: 'ead_curso', ref_id: id, por: req,
      rotulo: `Curso EAD ${curso.titulo || ''}`.trim(),
      dados: { _curso: curso, _modulos: modulos, _aulas: aulas },
    });
    await db.query('DELETE FROM ead_cursos WHERE id = $1', [id]);
    res.json({ ok: true, msg: `Curso ${curso.titulo} removido com sucesso.` });
  } catch(e) { next(e); }
});

// POST /api/ead/modulos (Admin)
router.post('/modulos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { curso_id, titulo, ordem } = req.body;
    if (!curso_id || !titulo) return res.status(400).json({ error: 'curso_id e titulo são obrigatórios.' });

    const { rows } = await db.query(
      'INSERT INTO ead_modulos (curso_id, titulo, ordem) VALUES ($1, $2, $3) RETURNING *',
      [curso_id, titulo, parseInt(ordem) || 0]
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/modulos/:id (Admin) — renomeia / edita um módulo.
router.put('/modulos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { titulo, descricao, ordem } = req.body;
    const { rows } = await db.query(
      `UPDATE ead_modulos SET
         titulo = COALESCE($1, titulo),
         descricao = COALESCE($2, descricao),
         ordem = COALESCE($3, ordem)
       WHERE id = $4 RETURNING *`,
      [titulo, descricao, (ordem != null ? parseInt(ordem) : null), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json(rows[0]);
  } catch(e) { next(e); }
});

// DELETE /api/ead/modulos/:id (Admin) — manda o módulo (e suas aulas) pra Lixeira
router.delete('/modulos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: m } = await db.query('SELECT * FROM ead_modulos WHERE id=$1', [id]);
    if (m.length) {
      const modulo = m[0];
      const { rows: aulas } = await db.query('SELECT * FROM ead_aulas WHERE modulo_id=$1', [id]);
      await lixeira.guardar({
        entidade: 'ead_modulo', ref_id: id, por: req,
        rotulo: `Módulo EAD ${modulo.titulo || ''}`.trim(),
        dados: { _modulo: modulo, _aulas: aulas },
      });
    }
    await db.query('DELETE FROM ead_modulos WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// POST /api/ead/aulas (Admin)
router.post('/aulas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { modulo_id, titulo, url, descricao, duracao, material, material_url, gratis, ordem } = req.body;
    if (!modulo_id || !titulo) return res.status(400).json({ error: 'modulo_id e titulo são obrigatórios.' });

    const { rows } = await db.query(
      `INSERT INTO ead_aulas (modulo_id, titulo, url, descricao, duracao, material, material_url, gratis, ordem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [modulo_id, titulo, url || '', descricao || '', parseInt(duracao) || 10, material || '', material_url || '', Boolean(gratis), parseInt(ordem) || 0]
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/aulas/:id (Admin) — edita uma aula existente.
// Campos ausentes (undefined) são preservados; string vazia LIMPA o campo
// (ex.: apagar a URL do vídeo). url/material_url usam COALESCE só quando undefined.
router.put('/aulas/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    const { rows } = await db.query(
      `UPDATE ead_aulas SET
         titulo       = COALESCE($1, titulo),
         url          = CASE WHEN $2::boolean THEN $3 ELSE url END,
         descricao    = COALESCE($4, descricao),
         duracao      = COALESCE($5, duracao),
         material     = COALESCE($6, material),
         material_url = CASE WHEN $7::boolean THEN $8 ELSE material_url END,
         gratis       = COALESCE($9, gratis),
         ordem        = COALESCE($10, ordem)
       WHERE id = $11 RETURNING *`,
      [
        has('titulo') ? b.titulo : null,
        has('url'), has('url') ? (b.url || '') : null,
        has('descricao') ? b.descricao : null,
        has('duracao') ? (parseInt(b.duracao) || 10) : null,
        has('material') ? b.material : null,
        has('material_url'), has('material_url') ? (b.material_url || '') : null,
        has('gratis') ? Boolean(b.gratis) : null,
        has('ordem') ? (parseInt(b.ordem) || 0) : null,
        id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    res.json(rows[0]);
  } catch(e) { next(e); }
});

// DELETE /api/ead/aulas/:id (Admin) — manda a aula EAD pra Lixeira
router.delete('/aulas/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await db.query('SELECT * FROM ead_aulas WHERE id=$1', [id]);
    if (rows.length) {
      const a = rows[0];
      await lixeira.guardar({
        entidade: 'ead_aula', ref_id: id, por: req,
        rotulo: `Aula EAD ${a.titulo || ''}`.trim(),
        dados: a,
      });
    }
    await db.query('DELETE FROM ead_aulas WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});


// ── STREAMING SEGURO DE VÍDEOS (VPS) ──────────────────────────────────
router.get('/video/:aulaId', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aulaId } = req.params;

    // Buscar detalhes da aula e o curso_id correspondente
    const { rows: aulas } = await db.query(
      `SELECT a.*, m.curso_id
       FROM ead_aulas a
       JOIN ead_modulos m ON a.modulo_id = m.id
       WHERE a.id = $1`,
      [aulaId]
    );

    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    const aula = aulas[0];

    // Se for aula grátis (degustação), permite sem matrícula ativa
    if (!aula.gratis) {
      let matriculado = false;

      if (req.user.role === 'admin') {
        matriculado = true;
      } else if (req.user.tipo === 'presencial') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE aluno_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]
        );
        if (rows.length) matriculado = true;
      } else if (req.user.tipo === 'web') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE usuario_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]
        );
        if (rows.length) matriculado = true;
      }

      if (!matriculado) {
        return res.status(403).json({ error: 'Você não possui matrícula ativa neste curso para assistir a este vídeo.' });
      }
    }

    if (!aula.url) {
      return res.status(400).json({ error: 'Esta aula não possui arquivo de vídeo cadastrado.' });
    }

    // Servir stream do arquivo local .mp4 na VPS
    const videoPath = path.join(videosDir, aula.url);
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Arquivo de vídeo não encontrado no servidor.' });
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      fs.createReadStream(videoPath).pipe(res);
    }

  } catch(e) { next(e); }
});


// ── VÍDEO VIA CLOUDFLARE R2 (URL ASSINADA) ────────────────────────────
// GET /api/ead/video-url/:aulaId → { url } presigned (expira em minutos).
// aula.url guarda a CHAVE do objeto no R2 (ex: "curso1/aula123.mp4").
// A URL assinada vai direto no <video src> (resolve o <video> não mandar header).
router.get('/video-url/:aulaId', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aulaId } = req.params;
    const { rows: aulas } = await db.query(
      `SELECT a.*, m.curso_id
       FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id
       WHERE a.id = $1`,
      [aulaId]
    );
    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    const aula = aulas[0];

    // Mesma checagem de acesso do /video
    if (!aula.gratis) {
      let matriculado = false;
      if (req.user.role === 'admin') {
        matriculado = true;
      } else if (req.user.tipo === 'presencial') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE aluno_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      } else if (req.user.tipo === 'web') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE usuario_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      }
      if (!matriculado) {
        return res.status(403).json({ error: 'Você não possui matrícula ativa neste curso.' });
      }
    }

    if (!aula.url) return res.status(400).json({ error: 'Aula sem vídeo cadastrado.' });

    const raw = String(aula.url).trim();

    // YouTube → devolve a url original (o front monta o embed).
    if (raw.includes('youtube.com') || raw.includes('youtu.be')) {
      return res.json({ tipo: 'youtube', url: raw });
    }
    // URL http completa (vídeo direto ou outro embed) → devolve como está.
    if (/^https?:\/\//i.test(raw)) {
      return res.json({ tipo: 'http', url: raw });
    }
    // Caso contrário: é chave de objeto no R2 → URL assinada de curta duração.
    if (!r2.r2Configurado()) {
      return res.status(503).json({ error: 'Armazenamento de vídeo (R2) ainda não configurado.' });
    }
    const url = r2.presignGet(raw, 600); // 10 min
    res.json({ tipo: 'r2', url });
  } catch(e) { next(e); }
});

// GET /api/ead/material-url/:aulaId — devolve URL p/ abrir o ARQUIVO de material
// (PDF etc). Mesma checagem de matrícula do vídeo. http/https → como está; chave → presigned GET.
router.get('/material-url/:aulaId', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aulaId } = req.params;
    const { rows: aulas } = await db.query(
      `SELECT a.*, m.curso_id FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id WHERE a.id = $1`,
      [aulaId]
    );
    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    const aula = aulas[0];

    if (!aula.gratis) {
      let matriculado = false;
      if (req.user.role === 'admin') {
        matriculado = true;
      } else if (req.user.tipo === 'presencial') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE aluno_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      } else if (req.user.tipo === 'web') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE usuario_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      }
      if (!matriculado) return res.status(403).json({ error: 'Você não possui matrícula ativa neste curso.' });
    }

    const raw = String(aula.material_url || '').trim();
    if (!raw) return res.status(404).json({ error: 'Aula sem material de arquivo.' });
    if (/^https?:\/\//i.test(raw)) return res.json({ tipo: 'http', url: raw });
    if (!r2.r2Configurado()) return res.status(503).json({ error: 'Armazenamento (R2) não configurado.' });
    res.json({ tipo: 'r2', url: r2.presignGet(raw, 600) });
  } catch(e) { next(e); }
});

// POST /api/ead/upload-url (Admin) — gera URL assinada de UPLOAD (PUT) pro R2.
// Body: { filename, tipo } (tipo: 'video' | 'material'). Retorna { key, url, expira }.
// O admin faz fetch(url,{method:'PUT',body:arquivo}) e depois salva `key` no campo
// da aula (url do vídeo, ou material_url). Exige CORS configurado no bucket.
router.post('/upload-url', eadAdminMiddleware, async (req, res, next) => {
  try {
    if (!r2.r2Configurado()) {
      return res.status(503).json({ error: 'Armazenamento de vídeo (R2) ainda não configurado.' });
    }
    const { filename, tipo } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename é obrigatório.' });

    // Sanitiza o nome: tira acento, troca tudo que não for [a-z0-9.-] por '-'
    const base = String(filename)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'arquivo';
    const pasta = (tipo === 'material') ? 'materiais' : 'videos';
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `${pasta}/${Date.now()}-${rand}-${base}`;

    const url = r2.presignPut(key, 3600); // 1h p/ concluir o upload
    res.json({ ok: true, key, url, expira: 3600 });
  } catch(e) { next(e); }
});


// ── PROGRESSO E CERTIFICADOS DO ALUNO ─────────────────────────────────

// GET /api/ead/progresso
router.get('/progresso', eadAuthMiddleware, async (req, res, next) => {
  try {
    let matriculasQuery = '';
    const params = [];
    if (req.user.tipo === 'presencial') {
      matriculasQuery = "SELECT id, curso_id FROM ead_matriculas WHERE aluno_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    } else {
      matriculasQuery = "SELECT id, curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    }

    const { rows: mats } = await db.query(matriculasQuery, params);
    const progresso = {};

    for (const mat of mats) {
      const { rows: progs } = await db.query(
        'SELECT aula_id FROM ead_progresso WHERE matricula_id = $1',
        [mat.id]
      );
      progresso[mat.curso_id] = {};
      progs.forEach(p => {
        progresso[mat.curso_id][p.aula_id] = true;
      });
    }

    res.json(progresso);
  } catch(e) { next(e); }
});

// POST /api/ead/progresso
router.post('/progresso', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aula_id, concluida } = req.body;
    if (!aula_id) return res.status(400).json({ error: 'aula_id obrigatório' });

    // Obter o curso_id da aula
    const { rows: aulas } = await db.query(
      'SELECT a.*, m.curso_id FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id WHERE a.id = $1',
      [aula_id]
    );
    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada' });
    const cursoId = aulas[0].curso_id;

    // Buscar a matrícula ativa do aluno para este curso
    let matQuery = '';
    const params = [cursoId, req.user.id];
    if (req.user.tipo === 'presencial') {
      matQuery = "SELECT id FROM ead_matriculas WHERE curso_id = $1 AND aluno_id = $2 AND status = 'ativa'";
    } else {
      matQuery = "SELECT id FROM ead_matriculas WHERE curso_id = $1 AND usuario_id = $2 AND status = 'ativa'";
    }

    const { rows: mats } = await db.query(matQuery, params);
    if (!mats.length) {
      return res.status(403).json({ error: 'Aluno não possui matrícula ativa para este curso.' });
    }
    const matriculaId = mats[0].id;

    if (concluida) {
      await db.query(
        'INSERT INTO ead_progresso (matricula_id, aula_id) VALUES ($1, $2) ON CONFLICT (matricula_id, aula_id) DO NOTHING',
        [matriculaId, aula_id]
      );
    } else {
      await db.query(
        'DELETE FROM ead_progresso WHERE matricula_id = $1 AND aula_id = $2',
        [matriculaId, aula_id]
      );
    }

    // Checar se completou 100% para gerar certificado
    const { rows: totalAulasRows } = await db.query(
      'SELECT COUNT(a.id) FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id WHERE m.curso_id = $1',
      [cursoId]
    );
    const { rows: aulasConcluidasRows } = await db.query(
      'SELECT COUNT(*) FROM ead_progresso WHERE matricula_id = $1',
      [matriculaId]
    );

    const total = parseInt(totalAulasRows[0].count) || 0;
    const concluidas = parseInt(aulasConcluidasRows[0].count) || 0;

    let certCriado = null;

    if (total > 0 && concluidas === total) {
      // Gerar Certificado EAD
      const { rows: certsExistentes } = await db.query(
        'SELECT * FROM ead_certificados WHERE matricula_id = $1',
        [matriculaId]
      );
      if (!certsExistentes.length) {
        // Encontrar contagem de certificados para o código sequencial
        const { rows: contagem } = await db.query('SELECT COUNT(*) FROM ead_certificados');
        const sequencia = String(parseInt(contagem[0].count) + 1).padStart(4, '0');
        const codigo = `F5-EAD-${new Date().getFullYear()}-${sequencia}`;

        const { rows: novoCert } = await db.query(
          'INSERT INTO ead_certificados (matricula_id, codigo) VALUES ($1, $2) RETURNING *',
          [matriculaId, codigo]
        );
        certCriado = novoCert[0];
      }
    }

    res.json({ ok: true, concluida, certificado: certCriado });

  } catch(e) { next(e); }
});

// POST /api/ead/progresso/kids
router.post('/progresso/kids', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { modulo, exercicio, passed, stars, ppm, accuracy } = req.body;
    if (!modulo || !exercicio) return res.status(400).json({ error: 'modulo e exercicio obrigatórios' });

    let matQuery = '';
    const params = [req.user.id];
    if (req.user.tipo === 'presencial') {
      matQuery = "SELECT m.id, m.curso_id FROM ead_matriculas m JOIN ead_cursos c ON m.curso_id = c.id WHERE m.aluno_id = $1 AND (c.slug = 'curso-digitacao-f5-kids' OR c.tipo_conteudo = 'digitacao-kids') AND m.status = 'ativa' LIMIT 1";
    } else {
      matQuery = "SELECT m.id, m.curso_id FROM ead_matriculas m JOIN ead_cursos c ON m.curso_id = c.id WHERE m.usuario_id = $1 AND (c.slug = 'curso-digitacao-f5-kids' OR c.tipo_conteudo = 'digitacao-kids') AND m.status = 'ativa' LIMIT 1";
    }

    let { rows: mats } = await db.query(matQuery, params);
    if (!mats.length && req.user.tipo === 'web') {
      const { rows: anyMat } = await db.query(
        "SELECT id, curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa' ORDER BY id ASC LIMIT 1",
        [req.user.id]
      );
      mats = anyMat;
    }

    if (mats.length && passed) {
      const matriculaId = mats[0].id;
      const aulaKey = ((Number(modulo) - 1) * 12) + Number(exercicio);
      await db.query(
        `INSERT INTO ead_progresso (matricula_id, aula_id, data_conclusao)
         VALUES ($1, $2, NOW())
         ON CONFLICT (matricula_id, aula_id) DO UPDATE SET data_conclusao = NOW()`,
        [matriculaId, aulaKey]
      );
    }

    // Se o usuário for web, registra também em digitacao_resultados
    if (passed && req.user.tipo === 'web') {
      try {
        let { rows: du } = await db.query(
          "SELECT id FROM digitacao_usuarios WHERE ead_usuario_id = $1 OR id = $1 LIMIT 1",
          [req.user.id]
        );
        let digUserId = du[0]?.id;
        if (!digUserId) {
          const { rows: newDu } = await db.query(
            "INSERT INTO digitacao_usuarios (nome, email, ead_usuario_id, status) VALUES ($1, $2, $3, 'ativo') RETURNING id",
            [req.user.nome, req.user.email || `${req.user.nome_login || req.user.id}@kids.f5`, req.user.id]
          );
          digUserId = newDu[0]?.id;
        }
        if (digUserId) {
          await db.query(
            `INSERT INTO digitacao_resultados (usuario_id, modulo, exercicio, melhor_precisao, melhor_ppm, melhor_duracao_ms, aprovado_em, atualizado_em)
             VALUES ($1, $2, $3, $4, $5, 10000, NOW(), NOW())
             ON CONFLICT (usuario_id, modulo, exercicio) DO UPDATE SET
               melhor_precisao = GREATEST(digitacao_resultados.melhor_precisao, EXCLUDED.melhor_precisao),
               melhor_ppm = GREATEST(digitacao_resultados.melhor_ppm, EXCLUDED.melhor_ppm),
               atualizado_em = NOW()`,
            [digUserId, Number(modulo), Number(exercicio), Number(accuracy) || 100, Number(ppm) || 0]
          );
        }
      } catch (err) {
        console.warn('Falha ao espelhar resultado kids:', err.message);
      }
    }

    res.json({ ok: true });
  } catch(e) { next(e); }
});

// GET /api/ead/certificados
router.get('/certificados', eadAuthMiddleware, async (req, res, next) => {
  try {
    let matsQuery = '';
    const params = [];
    if (req.user.tipo === 'presencial') {
      matsQuery = "SELECT id, curso_id FROM ead_matriculas WHERE aluno_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    } else {
      matsQuery = "SELECT id, curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    }

    const { rows: mats } = await db.query(matsQuery, params);
    if (!mats.length) return res.json([]);

    const matsIds = mats.map(m => m.id);
    const { rows: certs } = await db.query(
      `SELECT c.*, cur.titulo AS curso_titulo, cur.carga_horaria
       FROM ead_certificados c
       JOIN ead_matriculas m ON c.matricula_id = m.id
       JOIN ead_cursos cur ON m.curso_id = cur.id
       WHERE c.matricula_id = ANY($1)`,
      [matsIds]
    );

    res.json(certs.map(c => ({
      id: c.id,
      codigo: c.codigo,
      nomeAluno: req.user.nome,
      nomeCurso: c.curso_titulo,
      carga: c.carga_horaria,
      emissao: c.data_emissao
    })));

  } catch(e) { next(e); }
});

// GET /api/ead/certificados/validar/:codigo
router.get('/certificados/validar/:codigo', async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { rows } = await db.query(
      `SELECT c.*, cur.titulo AS curso_titulo, cur.carga_horaria,
              u.nome AS usuario_nome, a.nome AS aluno_nome
       FROM ead_certificados c
       JOIN ead_matriculas m ON c.matricula_id = m.id
       JOIN ead_cursos cur ON m.curso_id = cur.id
       LEFT JOIN ead_usuarios u ON m.usuario_id = u.id
       LEFT JOIN alunos a ON m.aluno_id = a.id
       WHERE UPPER(c.codigo) = $1`,
      [codigo.toUpperCase().trim()]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Certificado não encontrado.' });
    }

    const cert = rows[0];
    res.json({
      ok: true,
      codigo: cert.codigo,
      nomeAluno: cert.usuario_nome || cert.aluno_nome || '—',
      nomeCurso: cert.curso_titulo,
      carga: cert.carga_horaria,
      emissao: cert.data_emissao
    });
  } catch(e) { next(e); }
});


// ── INTEGRAÇÃO VENDAS E CHECKOUT INFINITEPAY ──────────────────────────

// POST /api/ead/checkout
router.post('/checkout', eadAuthMiddleware, async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { curso_id } = req.body;
    if (!curso_id) return res.status(400).json({ error: 'curso_id é obrigatório.' });

    const { rows: cursos } = await client.query('SELECT * FROM ead_cursos WHERE id = $1', [curso_id]);
    if (!cursos.length) return res.status(404).json({ error: 'Curso não encontrado.' });
    const curso = cursos[0];

    const isPresencial = req.user.tipo === 'presencial';

    // Curso ainda não liberado pro público (venda_publica=false) — só aluno
    // presencial (via CPF) ou admin conseguem comprar/liberar. Aluno presencial
    // elegível pela turma nem passa por aqui (matrícula já sai pronta no login);
    // isso cobre o caso de ele querer um curso EAD adicional antes do lançamento.
    if (!curso.venda_publica && !isPresencial && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Este curso ainda não está disponível para compra pública.' });
    }

    const colId = isPresencial ? 'aluno_id' : 'usuario_id';

    // Buscar dados completos do usuário (email e telefone não estão no JWT)
    let userEmail = '', userPhone = '';
    if (isPresencial) {
      const { rows: ua } = await client.query('SELECT email, whatsapp AS telefone FROM alunos WHERE id=$1', [req.user.id]);
      if (ua.length) { userEmail = ua[0].email || ''; userPhone = ua[0].telefone || ''; }
    } else {
      const { rows: ua } = await client.query('SELECT email, telefone FROM ead_usuarios WHERE id=$1', [req.user.id]);
      if (ua.length) { userEmail = ua[0].email || ''; userPhone = ua[0].telefone || ''; }
    }

    if (parseFloat(curso.preco) <= 0) {
      // Liberar gratuitamente
      await client.query(
        `INSERT INTO ead_matriculas (${colId}, curso_id, status)
         VALUES ($1, $2, 'ativa')
         ON CONFLICT (${colId}, curso_id) DO UPDATE SET status = 'ativa'`,
        [req.user.id, curso.id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, status: 'ativa', msg: 'Curso gratuito liberado.' });
    }

    // Criar/Obter matrícula pendente
    const { rows: mats } = await client.query(
      `INSERT INTO ead_matriculas (${colId}, curso_id, status)
       VALUES ($1, $2, 'pendente')
       ON CONFLICT (${colId}, curso_id) DO UPDATE SET status = ead_matriculas.status
       RETURNING *`,
      [req.user.id, curso.id]
    );
    const matricula = mats[0];

    const order_nsu = `ead-mat-${matricula.id}-${Date.now()}`;
    const preco_centavos = Math.round(parseFloat(curso.preco) * 100);

    const HANDLE = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
    const IP_URL = 'https://api.checkout.infinitepay.io/links';
    const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: curso.titulo }],
      redirect_url: `https://f5novacursos.com.br/ead.html?pago=1`,
      webhook_url: `${BASE_URL}/webhook/infinitepay`,
      customer: {
        name: req.user.nome,
        ...(userEmail && { email: userEmail }),
        ...(userPhone && { phone_number: '+55' + userPhone.replace(/\D/g, '') })
      }
    };

    const ipRes = await fetch(IP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!ipRes.ok) {
      const errText = await ipRes.text();
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'Erro no checkout InfinitePay', detail: errText });
    }

    const data = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;

    await client.query(
      'UPDATE ead_matriculas SET order_nsu = $1, receipt_url = $2 WHERE id = $3',
      [order_nsu, checkout_url, matricula.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, status: 'pendente', checkout_url, order_nsu });

  } catch(e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// POST /api/ead/checkout-publico  (SEM login prévio)
// O comprador preenche os dados NA HORA da compra; criamos/achamos a conta e
// geramos o pagamento. Após pagar (webhook), ele acessa logando com e-mail+senha.
router.post('/checkout-publico', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { curso_id, nome, email, cpf, telefone, senha } = req.body;
    if (!curso_id || !nome || !email || !cpf || !senha || !telefone) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Preencha nome, e-mail, CPF, telefone e senha.' });
    }
    const cpfLimpo = String(cpf).replace(/\D/g, '');
    if (cpfLimpo.length < 11) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'CPF inválido.' });
    }
    const emailLower = String(email).toLowerCase().trim();

    const { rows: cursos } = await client.query('SELECT * FROM ead_cursos WHERE id = $1', [curso_id]);
    if (!cursos.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Curso não encontrado.' }); }
    const curso = cursos[0];

    // checkout-publico é sempre visitante anônimo (sem login) — se o curso ainda
    // não está liberado pro público, não tem exceção possível aqui.
    if (!curso.venda_publica) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Este curso ainda não está disponível para compra pública.' });
    }

    // Achar conta existente (por e-mail ou CPF) ou criar uma nova
    const { rows: existentes } = await client.query(
      `SELECT * FROM ead_usuarios
       WHERE LOWER(email) = $1 OR REPLACE(REPLACE(cpf,'.',''),'-','') = $2`,
      [emailLower, cpfLimpo]
    );
    let usuario, contaExistente = false;
    if (existentes.length) {
      usuario = existentes[0];
      contaExistente = true; // mantém a senha antiga
    } else {
      const hash = bcrypt.hashSync(senha, 10);
      const { rows: novo } = await client.query(
        `INSERT INTO ead_usuarios (nome, email, senha_hash, cpf, telefone)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [nome, emailLower, hash, cpfLimpo, telefone || null]
      );
      usuario = novo[0];
    }

    // Curso grátis: libera direto
    if (parseFloat(curso.preco) <= 0) {
      await client.query(
        `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
         VALUES ($1, $2, 'ativa')
         ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = 'ativa'`,
        [usuario.id, curso.id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, status: 'ativa', conta_existente: contaExistente, email: usuario.email });
    }

    // Matrícula pendente + link InfinitePay
    const { rows: mats } = await client.query(
      `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
       VALUES ($1, $2, 'pendente')
       ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = ead_matriculas.status
       RETURNING *`,
      [usuario.id, curso.id]
    );
    const matricula = mats[0];
    const order_nsu = `ead-mat-${matricula.id}-${Date.now()}`;
    const preco_centavos = Math.round(parseFloat(curso.preco) * 100);

    const HANDLE = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
    const IP_URL = 'https://api.checkout.infinitepay.io/links';
    const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: curso.titulo }],
      redirect_url: `https://f5novacursos.com.br/ead.html?pago=1`,
      webhook_url: `${BASE_URL}/webhook/infinitepay`,
      customer: { name: usuario.nome, email: usuario.email },
    };

    const ipRes = await fetch(IP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!ipRes.ok) {
      const errText = await ipRes.text();
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'Erro no checkout InfinitePay', detail: errText });
    }
    const data = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;

    await client.query(
      'UPDATE ead_matriculas SET order_nsu = $1, receipt_url = $2 WHERE id = $3',
      [order_nsu, checkout_url, matricula.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, status: 'pendente', checkout_url, order_nsu, conta_existente: contaExistente, email: usuario.email });

    // Email "finalize o pagamento" — enviado após commit, não bloqueia resposta
    try {
      const tr = criarTransporter();
      if (tr) {
        await tr.sendMail({
          from: `"F5 Nova Cursos" <${process.env.GMAIL_USER}>`,
          to: usuario.email,
          subject: `Finalize sua inscrição — ${curso.titulo}`,
          html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0c1729;color:#e8eaf0;border-radius:12px;overflow:hidden">
  <div style="background:#f3ad1c;padding:20px 28px;text-align:center">
    <span style="font-size:2rem;font-weight:900;color:#0c1729;letter-spacing:.04em">F5 NOVA CURSOS</span>
  </div>
  <div style="padding:32px 28px">
    <p style="font-size:1.1rem;font-weight:700;margin:0 0 8px">Olá, ${usuario.nome.split(' ')[0]}!</p>
    <p style="color:#a0aec0;margin:0 0 24px">Seu cadastro foi criado com sucesso. Clique no botão abaixo para finalizar o pagamento e liberar seu acesso ao curso.</p>
    <div style="background:#131f35;border-radius:8px;padding:16px 20px;margin-bottom:24px">
      <p style="margin:0;font-size:.85rem;color:#a0aec0">Curso</p>
      <p style="margin:4px 0 0;font-weight:700;font-size:1rem">${curso.titulo}</p>
    </div>
    <a href="${checkout_url}" style="display:block;background:#f3ad1c;color:#0c1729;text-align:center;padding:14px;border-radius:8px;font-weight:800;font-size:1rem;text-decoration:none">Finalizar Pagamento →</a>
    <p style="margin:24px 0 0;font-size:.8rem;color:#4a5568;text-align:center">Após o pagamento, você acessa o portal com o e-mail e senha que cadastrou.</p>
  </div>
</div>`
        });
      }
    } catch(emailErr) { console.error('[EAD checkout email]', emailErr.message); }

  } catch(e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// Listar alunos do EAD (Admin)
// Mostra: usuários web (com matrícula) E presenciais ELEGÍVEIS pela turma
// (mesmo que ainda não tenham logado no portal — acesso é automático por CPF).
router.get('/alunos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { search } = req.query;

    // mapa titulo -> id dos cursos EAD
    const { rows: eadCursos } = await db.query('SELECT id, titulo FROM ead_cursos');
    const tituloToId = {};
    eadCursos.forEach(c => { tituloToId[c.titulo] = c.id; });

    const lista = [];

    // 1) Usuários web (vendas online) + suas matrículas ativas
    const { rows: webs } = await db.query(
      'SELECT id, nome, nome_login, email, cpf, telefone, cidade, perfil, criado_em FROM ead_usuarios WHERE deletado_em IS NULL ORDER BY nome'
    );
    for (const u of webs) {
      const { rows: mats } = await db.query(
        "SELECT curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'",
        [u.id]
      );
      lista.push({
        id: u.id, nome: u.nome, usuario: u.nome_login, email: u.email, cpf: u.cpf,
        telefone: u.telefone, cidade: u.cidade, perfil: u.perfil || 'adulto', criado_em: u.criado_em, tipo: 'web',
        cursos: mats.map(m => m.curso_id),
      });
    }

    // 2) Presenciais ativos/formados, elegíveis pela turma (independe de já ter logado)
    const { rows: pres } = await db.query(`
      SELECT a.id, a.nome, a.email, a.cpf, a.whatsapp AS telefone, a.pagamento AS criado_em,
             a.curso, t.nome AS turma_nome
      FROM alunos a
      LEFT JOIN turmas t ON a.turma_id = t.id
      WHERE a.status IN ('ativo', 'formado')
      ORDER BY a.nome
    `);
    for (const a of pres) {
      const titulos = cursosEadElegiveis(a.turma_nome, a.curso);
      if (!titulos.length) continue; // turma sem equivalente EAD (ex: Design) — pula
      const cursosIds = titulos.map(t => tituloToId[t]).filter(Boolean);
      lista.push({
        id: a.id, nome: a.nome, email: a.email, cpf: a.cpf,
        telefone: a.telefone, criado_em: a.criado_em, tipo: 'presencial',
        turma: a.turma_nome || null,
        cursos: cursosIds,
      });
    }

    // Filtro de busca (nome / cpf / email)
    let result = lista;
    if (search) {
      const s = String(search).toLowerCase();
      const sNum = s.replace(/\D/g, '');
      result = lista.filter(x =>
        (x.nome || '').toLowerCase().includes(s) ||
        (x.usuario || '').toLowerCase().includes(s) ||
        (x.email || '').toLowerCase().includes(s) ||
        (sNum && (x.cpf || '').replace(/\D/g, '').includes(sNum))
      );
    }

    res.json(result);
  } catch(e) { next(e); }
});

// POST /api/ead/alunos/avulso — cria aluno web + libera cursos (admin, sem pagamento)
router.post('/alunos/avulso', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { nome, email, cpf, senha, telefone, curso_ids } = req.body;
    if (!nome || !email || !cpf || !senha) {
      return res.status(400).json({ error: 'nome, email, cpf e senha são obrigatórios' });
    }
    const cursos = Array.isArray(curso_ids) ? curso_ids.map(Number).filter(Boolean) : [];
    const hash = await bcrypt.hash(String(senha), 10);
    const cpfLimpo = String(cpf).replace(/\D/g, '');
    const cpfFmt = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    const { rows: eu } = await db.query(
      `INSERT INTO ead_usuarios (nome, email, cpf, senha_hash, telefone)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [nome.trim(), email.trim().toLowerCase(), cpfFmt, hash, telefone || null]
    );
    const usuarioId = eu[0].id;
    for (const cursoId of cursos) {
      await db.query(
        `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
         VALUES ($1,$2,'ativa') ON CONFLICT (usuario_id, curso_id) DO NOTHING`,
        [usuarioId, cursoId]
      );
    }
    res.status(201).json({ ok: true, usuario_id: usuarioId });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail ou CPF já cadastrado' });
    next(e);
  }
});

// DELETE /api/ead/alunos/web/:id — soft-delete usuário web (admin)
router.delete('/alunos/web/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await db.query(`UPDATE ead_usuarios SET deletado_em = NOW() WHERE id = $1`, [id]);
    await db.query(`UPDATE ead_matriculas SET status = 'inativa' WHERE usuario_id = $1`, [id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// GET /api/ead/alunos/web/:id/matriculas — matrículas ativas de um usuário web (admin)
router.get('/alunos/web/:id/matriculas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT m.id AS matricula_id, c.id AS curso_id, c.titulo, c.icone
         FROM ead_matriculas m
         JOIN ead_cursos c ON c.id = m.curso_id
        WHERE m.usuario_id = $1 AND m.status = 'ativa'
        ORDER BY c.titulo`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { next(e); }
});

// GET /api/ead/alunos/presencial/:id/matriculas — matrículas EAD de um aluno presencial (admin)
router.get('/alunos/presencial/:id/matriculas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT m.id AS matricula_id, c.id AS curso_id, c.titulo, c.icone
         FROM ead_matriculas m
         JOIN ead_cursos c ON c.id = m.curso_id
        WHERE m.aluno_id = $1 AND m.status = 'ativa'
        ORDER BY c.titulo`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { next(e); }
});

// POST /api/ead/matriculas — libera um curso para um aluno (admin)
router.post('/matriculas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { tipo, id, curso_id } = req.body; // tipo='web'|'presencial'
    if (!tipo || !id || !curso_id) return res.status(400).json({ error: 'tipo, id e curso_id obrigatórios' });
    const campo = tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
    const conflict = tipo === 'presencial' ? '(aluno_id, curso_id)' : '(usuario_id, curso_id)';
    await db.query(
      `INSERT INTO ead_matriculas (${campo}, curso_id, status)
       VALUES ($1,$2,'ativa')
       ON CONFLICT ${conflict} DO UPDATE SET status='ativa', data_matricula=NOW()`,
      [id, curso_id]
    );
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// DELETE /api/ead/matriculas/:matriculaId — revoga acesso a um curso (admin)
router.delete('/matriculas/:matriculaId', eadAdminMiddleware, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE ead_matriculas SET status='inativa' WHERE id=$1`,
      [req.params.matriculaId]
    );
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// GET /api/ead/certificados/admin/todos — lista TODOS os certificados emitidos (Admin)
router.get('/certificados/admin/todos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.codigo, c.data_emissao, cur.titulo AS curso_titulo, cur.carga_horaria,
              COALESCE(u.nome, a.nome) AS aluno_nome
       FROM ead_certificados c
       JOIN ead_matriculas m ON c.matricula_id = m.id
       JOIN ead_cursos cur ON m.curso_id = cur.id
       LEFT JOIN ead_usuarios u ON m.usuario_id = u.id
       LEFT JOIN alunos a ON m.aluno_id = a.id
       ORDER BY c.data_emissao DESC`
    );
    res.json(rows.map(r => ({
      nomeAluno: r.aluno_nome || '—',
      nomeCurso: r.curso_titulo,
      codigo: r.codigo,
      emissao: r.data_emissao,
      carga: r.carga_horaria
    })));
  } catch(e) { next(e); }
});

// ── PERFIL DETALHADO DO ALUNO EAD (Admin) ──────────────────────────────
router.get('/admin/alunos/:tipo/:id/perfil', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { tipo, id } = req.params;
    const numId = parseInt(id);
    if (!numId) return res.status(400).json({ error: 'ID inválido' });

    let aluno = null;
    if (tipo === 'web') {
      const { rows } = await db.query(
        `SELECT id, nome, email, cpf, telefone, cidade, perfil, nome_login, criado_em, avatar_url, 'web' AS tipo
         FROM ead_usuarios WHERE id = $1 AND deletado_em IS NULL`,
        [numId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Aluno web não encontrado' });
      aluno = rows[0];
    } else {
      const { rows } = await db.query(
        `SELECT a.id, a.nome, a.email, a.cpf, a.whatsapp AS telefone, a.pagamento AS criado_em,
                a.status, a.curso, t.nome AS turma_nome, 'presencial' AS tipo
         FROM alunos a
         LEFT JOIN turmas t ON a.turma_id = t.id
         WHERE a.id = $1`,
        [numId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Aluno presencial não encontrado' });
      aluno = rows[0];
    }

    // Buscar matrículas ativas do aluno
    const colId = tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
    const { rows: mats } = await db.query(
      `SELECT m.id AS matricula_id, m.curso_id, m.data_matricula, m.status,
              c.titulo, c.icone, c.carga_horaria, c.tipo_conteudo, c.slug, c.descricao,
              cert.codigo AS cert_codigo, cert.data_emissao AS cert_emissao
       FROM ead_matriculas m
       JOIN ead_cursos c ON c.id = m.curso_id
       LEFT JOIN ead_certificados cert ON cert.matricula_id = m.id
       WHERE m.${colId} = $1 AND m.status = 'ativa'
       ORDER BY m.data_matricula DESC`,
      [numId]
    );

    // Para cada matrícula, calcular progresso detalhado
    const cursosComProgresso = [];
    for (const mat of mats) {
      // Total de aulas do curso
      const { rows: totalAulasRows } = await db.query(
        `SELECT COUNT(a.id) AS total
         FROM ead_aulas a
         JOIN ead_modulos m ON a.modulo_id = m.id
         WHERE m.curso_id = $1`,
        [mat.curso_id]
      );
      const totalAulas = parseInt(totalAulasRows[0]?.total || 0);

      // Aulas concluídas no ead_progresso
      const { rows: concluidasRows } = await db.query(
        `SELECT COUNT(p.id) AS concluidas, MAX(p.data_conclusao) AS ultima_atividade
         FROM ead_progresso p
         WHERE p.matricula_id = $1`,
        [mat.matricula_id]
      );
      let concluidas = parseInt(concluidasRows[0]?.concluidas || 0);
      let ultimaAtividade = concluidasRows[0]?.ultima_atividade || null;

      // Se for curso de digitação (adulto ou kids), buscar também em digitacao_resultados
      const isKids = mat.tipo_conteudo === 'digitacao-kids' || (mat.slug && mat.slug.includes('kids'));
      const isDigitacao = isKids || mat.tipo_conteudo === 'digitacao' || (mat.slug && mat.slug.includes('digitacao'));

      if (isDigitacao) {
        try {
          const { rows: digRows } = await db.query(
            `SELECT COUNT(r.id) AS total_aprovados, MAX(r.atualizado_em) AS ultima_atividade_dig
             FROM digitacao_resultados r
             JOIN digitacao_usuarios du ON r.usuario_id = du.id
             WHERE du.ead_usuario_id = $1
                OR du.id = $1
                OR (du.email IS NOT NULL AND $2::text IS NOT NULL AND LOWER(du.email) = LOWER($2::text))
                OR (du.nome IS NOT NULL AND $3::text IS NOT NULL AND LOWER(du.nome) = LOWER($3::text))`,
            [numId, aluno.email || null, aluno.nome || null]
          );
          const totalDig = parseInt(digRows[0]?.total_aprovados || 0);
          const dataDig = digRows[0]?.ultima_atividade_dig || null;
          
          if (totalDig > concluidas) {
            concluidas = totalDig;
          }
          if (dataDig && (!ultimaAtividade || new Date(dataDig) > new Date(ultimaAtividade))) {
            ultimaAtividade = dataDig;
          }
        } catch (_) {}
      }

      const totalDoCurso = isKids ? 36 : (isDigitacao ? 72 : (totalAulas > 0 ? totalAulas : 1));
      let progressoPct = Math.min(100, Math.round((concluidas / totalDoCurso) * 100));

      cursosComProgresso.push({
        matricula_id: mat.matricula_id,
        curso_id: mat.curso_id,
        titulo: mat.titulo,
        icone: mat.icone || (isKids ? '🌟' : (isDigitacao ? '⌨️' : '📚')),
        carga_horaria: mat.carga_horaria,
        tipo_conteudo: mat.tipo_conteudo,
        slug: mat.slug,
        data_matricula: mat.data_matricula,
        total_aulas: totalDoCurso,
        aulas_concluidas: concluidas,
        progresso_pct: progressoPct,
        ultima_atividade: ultimaAtividade,
        certificado: mat.cert_codigo ? { codigo: mat.cert_codigo, data_emissao: mat.cert_emissao } : null
      });
    }

    // Histórico de Suporte deste aluno
    const { rows: suporte } = await db.query(
      `SELECT s.*, c.titulo AS curso_titulo
       FROM ead_suporte_mensagens s
       LEFT JOIN ead_cursos c ON s.curso_id = c.id
       WHERE s.${colId} = $1
       ORDER BY s.criado_em DESC
       LIMIT 30`,
      [numId]
    );

    res.json({
      aluno,
      cursos: cursosComProgresso,
      suporte
    });
  } catch (e) { next(e); }
});


// ── SUPORTE & CHAT AO VIVO — ROTAS DO ALUNO ────────────────────────────

// GET /api/ead/suporte/mensagens (Aluno)
router.get('/suporte/mensagens', eadAuthMiddleware, async (req, res, next) => {
  try {
    const colId = req.user.tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
    const { rows } = await db.query(
      `SELECT s.*, c.titulo AS curso_titulo
       FROM ead_suporte_mensagens s
       LEFT JOIN ead_cursos c ON s.curso_id = c.id
       WHERE s.${colId} = $1
       ORDER BY s.criado_em ASC`,
      [req.user.id]
    );
    const naoLidas = rows.filter(r => r.remetente === 'admin' && !r.lida_pelo_aluno).length;
    res.json({ mensagens: rows, naoLidas });
  } catch (e) { next(e); }
});

// POST /api/ead/suporte/mensagens (Aluno envia dúvida/chamado)
router.post('/suporte/mensagens', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { mensagem, curso_id, contexto, categoria } = req.body;
    if (!mensagem || !mensagem.trim()) {
      return res.status(400).json({ error: 'Digite uma mensagem antes de enviar.' });
    }
    const isPresencial = req.user.tipo === 'presencial';
    const usuario_id = isPresencial ? null : req.user.id;
    const aluno_id = isPresencial ? req.user.id : null;

    const { rows } = await db.query(
      `INSERT INTO ead_suporte_mensagens (usuario_id, aluno_id, curso_id, contexto, categoria, remetente, mensagem, lida_pelo_aluno, lida_pelo_admin, status)
       VALUES ($1, $2, $3, $4, $5, 'aluno', $6, true, false, 'aberto')
       RETURNING *`,
      [usuario_id, aluno_id, curso_id || null, contexto || null, categoria || 'duvida', mensagem.trim()]
    );
    res.status(201).json({ ok: true, mensagem: rows[0] });
  } catch (e) { next(e); }
});

// PUT /api/ead/suporte/marcar-lido (Aluno marca respostas como lidas)
router.put('/suporte/marcar-lido', eadAuthMiddleware, async (req, res, next) => {
  try {
    const colId = req.user.tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
    await db.query(
      `UPDATE ead_suporte_mensagens SET lida_pelo_aluno = true
       WHERE ${colId} = $1 AND remetente = 'admin' AND lida_pelo_aluno = false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/ead/suporte/contador (Aluno: contador de respostas não lidas)
router.get('/suporte/contador', eadAuthMiddleware, async (req, res, next) => {
  try {
    const colId = req.user.tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
    const { rows } = await db.query(
      `SELECT COUNT(id) AS nao_lidas
       FROM ead_suporte_mensagens
       WHERE ${colId} = $1 AND remetente = 'admin' AND lida_pelo_aluno = false`,
      [req.user.id]
    );
    res.json({ naoLidas: parseInt(rows[0]?.nao_lidas || 0) });
  } catch (e) { next(e); }
});


// ── SUPORTE & CHAT AO VIVO — ROTAS DO ADMIN ────────────────────────────

// GET /api/ead/admin/suporte/conversas (Admin: lista de todos os chamados/alunos)
router.get('/admin/suporte/conversas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const { rows } = await db.query(`
      SELECT DISTINCT ON (COALESCE(s.usuario_id, s.aluno_id), CASE WHEN s.usuario_id IS NOT NULL THEN 'web' ELSE 'presencial' END)
             s.id AS ultima_mensagem_id,
             s.usuario_id,
             s.aluno_id,
             CASE WHEN s.usuario_id IS NOT NULL THEN 'web' ELSE 'presencial' END AS aluno_tipo,
             COALESCE(u.nome, a.nome) AS aluno_nome,
             COALESCE(u.email, a.email) AS aluno_email,
             COALESCE(u.telefone, a.whatsapp) AS aluno_telefone,
             COALESCE(u.nome_login, '') AS aluno_usuario,
             u.perfil AS aluno_perfil,
             s.curso_id,
             c.titulo AS curso_titulo,
             s.contexto,
             s.categoria,
             s.remetente,
             s.mensagem,
             s.status,
             s.lida_pelo_admin,
             s.criado_em AS ultima_mensagem_em,
             (SELECT COUNT(*) FROM ead_suporte_mensagens sm
               WHERE sm.usuario_id IS NOT DISTINCT FROM s.usuario_id
                 AND sm.aluno_id IS NOT DISTINCT FROM s.aluno_id
                 AND sm.remetente = 'aluno'
                 AND sm.lida_pelo_admin = false) AS nao_lidas
      FROM ead_suporte_mensagens s
      LEFT JOIN ead_usuarios u ON s.usuario_id = u.id
      LEFT JOIN alunos a ON s.aluno_id = a.id
      LEFT JOIN ead_cursos c ON s.curso_id = c.id
      ORDER BY COALESCE(s.usuario_id, s.aluno_id), CASE WHEN s.usuario_id IS NOT NULL THEN 'web' ELSE 'presencial' END, s.criado_em DESC
    `);

    // Ordenar pelas conversas com mensagens mais recentes
    let conversas = rows.sort((a, b) => new Date(b.ultima_mensagem_em) - new Date(a.ultima_mensagem_em));

    if (status) {
      conversas = conversas.filter(c => c.status === status);
    }
    if (search) {
      const s = String(search).toLowerCase();
      conversas = conversas.filter(c =>
        (c.aluno_nome || '').toLowerCase().includes(s) ||
        (c.aluno_email || '').toLowerCase().includes(s) ||
        (c.aluno_telefone || '').includes(s)
      );
    }

    res.json(conversas);
  } catch (e) { next(e); }
});

// GET /api/ead/admin/suporte/conversa/:tipo/:id (Admin: histórico de um aluno)
router.get('/admin/suporte/conversa/:tipo/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { tipo, id } = req.params;
    const numId = parseInt(id);
    const colId = tipo === 'presencial' ? 'aluno_id' : 'usuario_id';

    const { rows } = await db.query(
      `SELECT s.*, c.titulo AS curso_titulo
       FROM ead_suporte_mensagens s
       LEFT JOIN ead_cursos c ON s.curso_id = c.id
       WHERE s.${colId} = $1
       ORDER BY s.criado_em ASC`,
      [numId]
    );

    // Marca como lidas pelo admin
    await db.query(
      `UPDATE ead_suporte_mensagens SET lida_pelo_admin = true
       WHERE ${colId} = $1 AND remetente = 'aluno' AND lida_pelo_admin = false`,
      [numId]
    );

    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/ead/admin/suporte/responder (Admin responde aluno)
router.post('/admin/suporte/responder', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { tipo, id, mensagem, curso_id } = req.body;
    if (!tipo || !id || !mensagem || !mensagem.trim()) {
      return res.status(400).json({ error: 'tipo, id e mensagem são obrigatórios' });
    }
    const numId = parseInt(id);
    const isPresencial = tipo === 'presencial';
    const usuario_id = isPresencial ? null : numId;
    const aluno_id = isPresencial ? numId : null;
    const colId = isPresencial ? 'aluno_id' : 'usuario_id';

    const { rows } = await db.query(
      `INSERT INTO ead_suporte_mensagens (usuario_id, aluno_id, curso_id, remetente, mensagem, lida_pelo_admin, lida_pelo_aluno, status)
       VALUES ($1, $2, $3, 'admin', $4, true, false, 'respondido')
       RETURNING *`,
      [usuario_id, aluno_id, curso_id || null, mensagem.trim()]
    );

    // Atualiza status dos chamados abertos desse aluno para 'respondido'
    await db.query(
      `UPDATE ead_suporte_mensagens SET status = 'respondido', lida_pelo_admin = true
       WHERE ${colId} = $1 AND status = 'aberto'`,
      [numId]
    );

    res.status(201).json({ ok: true, mensagem: rows[0] });
  } catch (e) { next(e); }
});

// PUT /api/ead/admin/suporte/status/:id (Admin altera status: 'resolvido' | 'aberto')
router.put('/admin/suporte/status/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    await db.query(`UPDATE ead_suporte_mensagens SET status = $1 WHERE id = $2`, [status || 'resolvido', id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/ead/admin/suporte/contador (Admin: total de mensagens pendentes/não lidas)
router.get('/admin/suporte/contador', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(id) AS total_nao_lidas
       FROM ead_suporte_mensagens
       WHERE remetente = 'aluno' AND lida_pelo_admin = false`
    );
    res.json({ naoLidas: parseInt(rows[0]?.total_nao_lidas || 0) });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.eadAuthMiddleware = eadAuthMiddleware;

