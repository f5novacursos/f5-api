const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const curriculum = require('../data/digitacao-curriculo.json');

const router = express.Router();
const JWT_SECRET = process.env.DIGITACAO_JWT_SECRET || process.env.EAD_JWT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '163041222391-rmnha7n1jcni0nu19bflgvpq6f6ufm0j.apps.googleusercontent.com';
const TOTAL_EXERCISES = curriculum.course.totalExercises;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});
const attemptLimiter = rateLimit({
  windowMs: 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas solicitações de treino. Aguarde um instante.' }
});

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS digitacao_usuarios (
      id BIGSERIAL PRIMARY KEY,
      nome VARCHAR(160) NOT NULL,
      email VARCHAR(180) NOT NULL,
      senha_hash VARCHAR(255),
      google_sub VARCHAR(255) UNIQUE,
      avatar_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'ativo',
      ranking_publico BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ultimo_acesso TIMESTAMPTZ
    )`);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS digitacao_usuarios_email_unique ON digitacao_usuarios (LOWER(email))');
  await db.query(`
    CREATE TABLE IF NOT EXISTS digitacao_tentativas (
      id UUID PRIMARY KEY,
      usuario_id BIGINT NOT NULL REFERENCES digitacao_usuarios(id) ON DELETE CASCADE,
      modulo SMALLINT NOT NULL CHECK (modulo BETWEEN 1 AND 3),
      exercicio SMALLINT NOT NULL CHECK (exercicio BETWEEN 1 AND 24),
      versao VARCHAR(40) NOT NULL,
      conteudo_hash CHAR(64) NOT NULL,
      caracteres_esperados INTEGER NOT NULL,
      meta_precisao SMALLINT NOT NULL,
      meta_ppm SMALLINT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'em_andamento',
      iniciado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalizado_em TIMESTAMPTZ,
      tentativas INTEGER, acertos INTEGER, precisao SMALLINT, ppm SMALLINT,
      duracao_ms INTEGER, aprovado BOOLEAN, motivo VARCHAR(60), rastro JSONB
    )`);
  await db.query('CREATE INDEX IF NOT EXISTS digitacao_tentativas_usuario_idx ON digitacao_tentativas (usuario_id, iniciado_em DESC)');
  await db.query(`
    CREATE TABLE IF NOT EXISTS digitacao_resultados (
      id BIGSERIAL PRIMARY KEY,
      usuario_id BIGINT NOT NULL REFERENCES digitacao_usuarios(id) ON DELETE CASCADE,
      modulo SMALLINT NOT NULL,
      exercicio SMALLINT NOT NULL,
      tentativa_id UUID REFERENCES digitacao_tentativas(id) ON DELETE SET NULL,
      melhor_precisao SMALLINT NOT NULL,
      melhor_ppm SMALLINT NOT NULL,
      melhor_duracao_ms INTEGER NOT NULL,
      aprovado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (usuario_id, modulo, exercicio)
    )`);
  await db.query('CREATE INDEX IF NOT EXISTS digitacao_resultados_ranking_idx ON digitacao_resultados (melhor_ppm DESC, melhor_precisao DESC)');
  await db.query(`
    CREATE TABLE IF NOT EXISTS digitacao_certificados (
      id BIGSERIAL PRIMARY KEY,
      usuario_id BIGINT NOT NULL UNIQUE REFERENCES digitacao_usuarios(id) ON DELETE RESTRICT,
      codigo VARCHAR(50) NOT NULL UNIQUE,
      curso VARCHAR(180) NOT NULL,
      carga_horaria INTEGER NOT NULL,
      emitido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revogado_em TIMESTAMPTZ
    )`);
}

const migrationReady = migrate().catch((error) => {
  console.error('[Digitação] Falha ao preparar banco:', error.message);
  throw error;
});
async function ensureReady(req, res, next) {
  try { await migrationReady; next(); }
  catch (error) { res.status(503).json({ error: 'O Curso de Digitação está sendo preparado. Tente novamente em instantes.' }); }
}
router.use(ensureReady);

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const initials = (name) => String(name || 'F5').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
function publicName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return !parts.length ? 'Aluno F5' : (parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`);
}
function signToken(user) {
  return jwt.sign({ id: user.id, tipo: 'digitacao', role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
}
async function auth(req, res, next) {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Autenticação ainda não configurada no servidor.' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'digitacao') throw new Error('tipo inválido');
    const { rows } = await db.query(
      `SELECT id, nome, email, avatar_url, status, ranking_publico, criado_em
       FROM digitacao_usuarios WHERE id = $1`, [payload.id]);
    if (!rows.length || rows[0].status !== 'ativo') return res.status(401).json({ error: 'Conta indisponível.' });
    req.digitacaoUser = rows[0];
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' });
  }
}
function exerciseRule(moduleNumber, lessonNumber) {
  return curriculum.modules[String(moduleNumber)]?.[String(lessonNumber)] || null;
}
const globalExercise = (moduleNumber, lessonNumber) => (moduleNumber - 1) * 24 + lessonNumber;

async function getProgress(userId, queryable = db) {
  const { rows } = await queryable.query(
    `SELECT modulo, exercicio, melhor_precisao, melhor_ppm, melhor_duracao_ms, aprovado_em
     FROM digitacao_resultados WHERE usuario_id = $1 ORDER BY modulo, exercicio`, [userId]);
  const approved = new Map(rows.map((row) => [globalExercise(row.modulo, row.exercicio), row]));
  let completed = 0;
  for (let number = 1; number <= TOTAL_EXERCISES; number += 1) {
    if (!approved.has(number)) break;
    completed = number;
  }
  const modules = [1, 2, 3].map((moduleNumber) => {
    const moduleRows = rows.filter((row) => row.modulo === moduleNumber);
    const moduleStart = (moduleNumber - 1) * 24;
    let unlockedThrough = 0;
    if (completed >= moduleStart) unlockedThrough = Math.min(24, Math.max(1, completed - moduleStart + 1));
    if (completed >= moduleStart + 24) unlockedThrough = 24;
    return {
      module: moduleNumber, completed: moduleRows.length, unlockedThrough,
      percent: Math.round(moduleRows.length / 24 * 100)
    };
  });
  const bestPpm = rows.reduce((best, row) => Math.max(best, row.melhor_ppm), 0);
  const averageAccuracy = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.melhor_precisao, 0) / rows.length) : 100;
  const nextGlobal = completed < TOTAL_EXERCISES ? completed + 1 : null;
  const next = nextGlobal ? { module: Math.ceil(nextGlobal / 24), exercise: ((nextGlobal - 1) % 24) + 1 } : null;
  const certificates = await queryable.query(
    `SELECT codigo, curso, carga_horaria, emitido_em FROM digitacao_certificados
     WHERE usuario_id = $1 AND revogado_em IS NULL`, [userId]);
  return {
    completed, total: TOTAL_EXERCISES, percent: Math.round(completed / TOTAL_EXERCISES * 100),
    modules, next, bestPpm, averageAccuracy, certificate: certificates.rows[0] || null
  };
}

function verifyGoogleCredential(credential) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const payload = JSON.parse(body);
            const valid = response.statusCode === 200 && payload.aud === GOOGLE_CLIENT_ID
              && String(payload.email_verified) === 'true' && payload.email;
            if (!valid) return reject(new Error('Token Google inválido.'));
            resolve(payload);
          } catch (error) { reject(new Error('Não foi possível validar a Conta Google.')); }
        });
      });
    request.setTimeout(7000, () => request.destroy(new Error('Tempo de validação esgotado.')));
    request.on('error', reject);
  });
}


router.post('/auth/cadastro', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Cadastro ainda não configurado no servidor.' });
    const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
    const email = normalizeEmail(req.body.email);
    const senha = String(req.body.senha || '');
    if (nome.length < 2 || nome.length > 160) return res.status(400).json({ error: 'Informe seu nome.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (senha.length < 8 || senha.length > 100) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    const exists = await db.query('SELECT id FROM digitacao_usuarios WHERE LOWER(email) = $1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Este e-mail já possui uma conta. Entre com sua senha.' });
    const hash = await bcrypt.hash(senha, 12);
    const { rows } = await db.query(
      'INSERT INTO digitacao_usuarios (nome, email, senha_hash, ultimo_acesso) VALUES ($1, $2, $3, NOW()) RETURNING id, nome, email, avatar_url, criado_em',
      [nome, email, hash]);
    const user = rows[0];
    res.status(201).json({ token: signToken(user), user, progress: await getProgress(user.id) });
  } catch (error) { next(error); }
});

router.post('/auth/login', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Login ainda não configurado no servidor.' });
    const email = normalizeEmail(req.body.email);
    const senha = String(req.body.senha || '');
    const { rows } = await db.query('SELECT * FROM digitacao_usuarios WHERE LOWER(email) = $1', [email]);
    const user = rows[0];
    const valid = user?.senha_hash ? await bcrypt.compare(senha, user.senha_hash) : false;
    if (!user || !valid || user.status !== 'ativo') return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    await db.query('UPDATE digitacao_usuarios SET ultimo_acesso = NOW() WHERE id = $1', [user.id]);
    res.json({ token: signToken(user), user: { id: user.id, nome: user.nome, email: user.email, avatar_url: user.avatar_url }, progress: await getProgress(user.id) });
  } catch (error) { next(error); }
});

router.post('/auth/google', authLimiter, async (req, res, next) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Login ainda não configurado no servidor.' });
    const credential = String(req.body.credential || '');
    if (!credential || credential.length > 5000) return res.status(400).json({ error: 'Credencial Google ausente.' });
    const google = await verifyGoogleCredential(credential);
    const email = normalizeEmail(google.email);
    let result = await db.query('SELECT * FROM digitacao_usuarios WHERE LOWER(email) = $1 OR google_sub = $2 LIMIT 1', [email, google.sub]);
    let user = result.rows[0];
    if (!user) {
      result = await db.query(
        'INSERT INTO digitacao_usuarios (nome, email, google_sub, avatar_url, ultimo_acesso) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [google.name || email.split('@')[0], email, google.sub, google.picture || null]);
      user = result.rows[0];
    } else {
      result = await db.query(
        'UPDATE digitacao_usuarios SET google_sub = COALESCE(google_sub, $2), avatar_url = COALESCE($3, avatar_url), ultimo_acesso = NOW(), atualizado_em = NOW() WHERE id = $1 RETURNING *',
        [user.id, google.sub, google.picture || null]);
      user = result.rows[0];
    }
    if (user.status !== 'ativo') return res.status(401).json({ error: 'Conta indisponível.' });
    res.json({ token: signToken(user), user: { id: user.id, nome: user.nome, email: user.email, avatar_url: user.avatar_url }, progress: await getProgress(user.id) });
  } catch (error) {
    if (/Google|Token|validação/.test(error.message)) return res.status(401).json({ error: error.message });
    next(error);
  }
});

router.get('/auth/me', auth, (req, res) => res.json({ user: req.digitacaoUser }));
router.get('/progresso', auth, async (req, res, next) => {
  try { res.json({ progress: await getProgress(req.digitacaoUser.id) }); }
  catch (error) { next(error); }
});

router.post('/demo/iniciar', attemptLimiter, (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Treino livre ainda não configurado.' });
  const exercise = Number(req.body.exercise);
  const rule = exerciseRule(1, exercise);
  if (!rule || exercise < 1 || exercise > 6) return res.status(403).json({ error: 'Crie sua conta grátis para continuar.' });
  const demoToken = jwt.sign({
    tipo: 'digitacao_demo', module: 1, exercise: exercise,
    contentHash: rule.contentHash, expectedLength: rule.expectedLength,
    minimumAccuracy: rule.minimumAccuracy, minimumPpm: rule.minimumPpm,
    jti: crypto.randomUUID()
  }, JWT_SECRET, { expiresIn: '1h' });
  res.status(201).json({ attempt: { guest: true, token: demoToken, module: 1, exercise: exercise } });
});

router.post('/demo/finalizar', attemptLimiter, (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Treino livre ainda não configurado.' });
  try {
    const payload = jwt.verify(String(req.body.token || ''), JWT_SECRET);
    if (payload.tipo !== 'digitacao_demo') throw new Error('tipo inválido');
    const rule = exerciseRule(payload.module, payload.exercise);
    if (!rule || rule.contentHash !== payload.contentHash) throw new Error('conteúdo inválido');
    const summary = summarizeEvents(req.body.events);
    const elapsedMs = Math.max(1000, Date.now() - Number(payload.iat) * 1000);
    const accuracy = summary.attempts ? Math.round(summary.correct / summary.attempts * 100) : 0;
    const ppm = Math.round((summary.correct / 5) / (elapsedMs / 60000));
    const enoughContent = summary.correct >= rule.expectedLength;
    const precisionPassed = accuracy >= rule.minimumAccuracy;
    const speedPassed = ppm >= rule.minimumPpm;
    const plausible = summary.plausible && summary.attempts >= rule.expectedLength && ppm <= 220;
    const passed = plausible && enoughContent && precisionPassed && speedPassed;
    const proof = passed ? jwt.sign({
      tipo: 'digitacao_demo_result', module: 1, exercise: payload.exercise,
      accuracy: accuracy, ppm: ppm, durationMs: elapsedMs, contentHash: rule.contentHash
    }, JWT_SECRET, { expiresIn: '30d' }) : null;
    res.json({ result: { passed: passed, accuracy: accuracy, ppm: ppm, durationMs: elapsedMs,
      attempts: summary.attempts, errors: Math.max(0, summary.attempts - summary.correct),
      precisionPassed: precisionPassed, speedPassed: speedPassed,
      reason: passed ? null : (!precisionPassed ? 'precisao' : 'velocidade') }, proof: proof });
  } catch (error) {
    res.status(400).json({ error: 'Tentativa livre inválida ou expirada. Repita o exercício.' });
  }
});

router.post('/progresso/importar-demo', auth, async (req, res, next) => {
  const client = await db.connect();
  try {
    const results = Array.isArray(req.body.results) ? req.body.results : [];
    const safe = [];
    for (const item of results) {
      try {
        const proof = jwt.verify(String(item.proof || ''), JWT_SECRET);
        const rule = exerciseRule(1, Number(proof.exercise));
        if (proof.tipo === 'digitacao_demo_result' && rule && proof.contentHash === rule.contentHash &&
            proof.accuracy >= rule.minimumAccuracy && proof.ppm >= rule.minimumPpm) safe.push(proof);
      } catch (_) {}
    }
    safe.sort((a, b) => Number(a.exercise) - Number(b.exercise));
    await client.query('BEGIN');
    for (let index = 0; index < safe.length; index += 1) {
      const item = safe[index];
      if (Number(item.exercise) !== index + 1) break;
      await client.query(
        'INSERT INTO digitacao_resultados (usuario_id, modulo, exercicio, melhor_precisao, melhor_ppm, melhor_duracao_ms) ' +
        'VALUES ($1, 1, $2, $3, $4, $5) ON CONFLICT (usuario_id, modulo, exercicio) DO UPDATE SET ' +
        'melhor_precisao = GREATEST(digitacao_resultados.melhor_precisao, EXCLUDED.melhor_precisao), ' +
        'melhor_ppm = GREATEST(digitacao_resultados.melhor_ppm, EXCLUDED.melhor_ppm), atualizado_em = NOW()',
        [req.digitacaoUser.id, item.exercise, item.accuracy, item.ppm, Math.max(1000, Number(item.durationMs) || 1000)]);
    }
    await client.query('COMMIT');
    res.json({ progress: await getProgress(req.digitacaoUser.id) });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.post('/tentativas/iniciar', attemptLimiter, auth, async (req, res, next) => {
  try {
    const moduleNumber = Number(req.body.module);
    const exerciseNumber = Number(req.body.exercise);
    const rule = exerciseRule(moduleNumber, exerciseNumber);
    if (!rule) return res.status(404).json({ error: 'Exercício não encontrado.' });
    const progress = await getProgress(req.digitacaoUser.id);
    const requested = globalExercise(moduleNumber, exerciseNumber);
    const alreadyApproved = await db.query(
      'SELECT 1 FROM digitacao_resultados WHERE usuario_id = $1 AND modulo = $2 AND exercicio = $3',
      [req.digitacaoUser.id, moduleNumber, exerciseNumber]);
    if (requested !== progress.completed + 1 && !alreadyApproved.rows.length) {
      return res.status(403).json({ error: 'Conclua o exercício anterior para liberar este.' });
    }
    const id = crypto.randomUUID();
    await db.query(
      'INSERT INTO digitacao_tentativas ' +
      '(id, usuario_id, modulo, exercicio, versao, conteudo_hash, caracteres_esperados, meta_precisao, meta_ppm) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, req.digitacaoUser.id, moduleNumber, exerciseNumber, curriculum.version,
       rule.contentHash, rule.expectedLength, rule.minimumAccuracy, rule.minimumPpm]);
    res.status(201).json({
      attempt: { id, module: moduleNumber, exercise: exerciseNumber, startedAt: new Date().toISOString(),
        minimumAccuracy: rule.minimumAccuracy, minimumPpm: rule.minimumPpm }
    });
  } catch (error) { next(error); }
});

function summarizeEvents(events) {
  let attempts = 0;
  let correct = 0;
  let lastAt = -1;
  let plausible = Array.isArray(events) && events.length <= 12000;
  const clean = [];
  if (!plausible) return { attempts, correct, plausible: false, clean };
  for (const event of events) {
    const at = Math.round(Number(event.at));
    const ok = event.ok === true;
    if (!Number.isFinite(at) || at < lastAt || at < 0 || at > 60 * 60 * 1000) { plausible = false; break; }
    attempts += 1;
    if (ok) correct += 1;
    lastAt = at;
    clean.push({ at, ok });
  }
  return { attempts, correct, plausible, clean };
}

async function issueCertificate(userId, queryable = db) {
  const existing = await queryable.query(
    'SELECT codigo, curso, carga_horaria, emitido_em FROM digitacao_certificados WHERE usuario_id = $1 AND revogado_em IS NULL',
    [userId]);
  if (existing.rows.length) return existing.rows[0];
  const progress = await getProgress(userId, queryable);
  if (progress.completed !== TOTAL_EXERCISES) return null;
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = 'F5-DIG-' + year + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    try {
      const { rows } = await queryable.query(
        'INSERT INTO digitacao_certificados (usuario_id, codigo, curso, carga_horaria) ' +
        'VALUES ($1,$2,$3,$4) RETURNING codigo, curso, carga_horaria, emitido_em',
        [userId, code, curriculum.course.title, curriculum.course.hours || 20]);
      return rows[0];
    } catch (error) {
      if (error.code !== '23505') throw error;
      const found = await queryable.query(
        'SELECT codigo, curso, carga_horaria, emitido_em FROM digitacao_certificados WHERE usuario_id = $1 AND revogado_em IS NULL',
        [userId]);
      if (found.rows.length) return found.rows[0];
    }
  }
  throw new Error('Não foi possível emitir o certificado.');
}

router.post('/tentativas/:id/finalizar', attemptLimiter, auth, async (req, res, next) => {
  const client = await db.connect();
  try {
    const { rows } = await client.query(
      'SELECT * FROM digitacao_tentativas WHERE id = $1 AND usuario_id = $2 FOR UPDATE',
      [req.params.id, req.digitacaoUser.id]);
    const attempt = rows[0];
    if (!attempt) return res.status(404).json({ error: 'Tentativa não encontrada.' });
    if (attempt.status !== 'em_andamento') return res.status(409).json({ error: 'Esta tentativa já foi encerrada.' });
    const elapsedMs = Math.max(1, Date.now() - new Date(attempt.iniciado_em).getTime());
    const summary = summarizeEvents(req.body.events);
    const accuracy = summary.attempts ? Math.round(summary.correct / summary.attempts * 100) : 0;
    const ppm = Math.round((summary.correct / 5) / (elapsedMs / 60000));
    const enoughContent = summary.correct >= Number(attempt.caracteres_esperados);
    const plausible = summary.plausible && summary.attempts >= Number(attempt.caracteres_esperados) && ppm <= 220;
    const precisionPassed = accuracy >= Number(attempt.meta_precisao);
    const speedPassed = ppm >= Number(attempt.meta_ppm);
    const passed = plausible && enoughContent && precisionPassed && speedPassed;
    let reason = null;
    if (!plausible || !enoughContent) reason = 'dados_incompletos';
    else if (!precisionPassed && !speedPassed) reason = 'precisao_e_velocidade';
    else if (!precisionPassed) reason = 'precisao';
    else if (!speedPassed) reason = 'velocidade';

    await client.query('BEGIN');
    await client.query(
      'UPDATE digitacao_tentativas SET status = $2, finalizado_em = NOW(), tentativas = $3, acertos = $4, ' +
      'precisao = $5, ppm = $6, duracao_ms = $7, aprovado = $8, motivo = $9, rastro = $10::jsonb WHERE id = $1',
      [attempt.id, passed ? 'aprovada' : 'reprovada', summary.attempts, summary.correct,
       accuracy, ppm, Math.round(elapsedMs), passed, reason, JSON.stringify(summary.clean)]);
    if (passed) {
      await client.query(
        'INSERT INTO digitacao_resultados ' +
        '(usuario_id, modulo, exercicio, tentativa_id, melhor_precisao, melhor_ppm, melhor_duracao_ms) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (usuario_id, modulo, exercicio) DO UPDATE SET ' +
        'tentativa_id = CASE WHEN EXCLUDED.melhor_ppm > digitacao_resultados.melhor_ppm THEN EXCLUDED.tentativa_id ELSE digitacao_resultados.tentativa_id END, ' +
        'melhor_precisao = GREATEST(digitacao_resultados.melhor_precisao, EXCLUDED.melhor_precisao), ' +
        'melhor_ppm = GREATEST(digitacao_resultados.melhor_ppm, EXCLUDED.melhor_ppm), ' +
        'melhor_duracao_ms = LEAST(digitacao_resultados.melhor_duracao_ms, EXCLUDED.melhor_duracao_ms), atualizado_em = NOW()',
        [req.digitacaoUser.id, attempt.modulo, attempt.exercicio, attempt.id, accuracy, ppm, Math.round(elapsedMs)]);
    }
    await client.query('COMMIT');
    let progress = await getProgress(req.digitacaoUser.id);
    let certificate = progress.certificate;
    if (passed && progress.completed === TOTAL_EXERCISES) {
      certificate = await issueCertificate(req.digitacaoUser.id);
      progress = await getProgress(req.digitacaoUser.id);
    }
    res.json({
      result: { passed, accuracy, ppm, durationMs: Math.round(elapsedMs), attempts: summary.attempts,
        errors: Math.max(0, summary.attempts - summary.correct), precisionPassed, speedPassed, reason },
      progress, certificate
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(error);
  } finally { client.release(); }
});

router.get('/ranking', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT u.id, u.nome, ROUND(AVG(r.melhor_precisao))::int AS precisao, ' +
      'ROUND(AVG(r.melhor_ppm))::int AS ppm, COUNT(*)::int AS concluidos ' +
      'FROM digitacao_usuarios u JOIN digitacao_resultados r ON r.usuario_id = u.id ' +
      "WHERE u.status = 'ativo' AND u.ranking_publico = TRUE " +
      'GROUP BY u.id, u.nome HAVING COUNT(*) >= 1 ' +
      'ORDER BY ppm DESC, precisao DESC, concluidos DESC, u.id ASC LIMIT 100');
    const ranking = rows.map((row, index) => ({
      position: index + 1, id: row.id, name: publicName(row.nome), initials: initials(row.nome),
      accuracy: row.precisao, ppm: row.ppm, completed: row.concluidos,
      isCurrentUser: String(row.id) === String(req.digitacaoUser.id)
    }));
    const current = ranking.find((item) => item.isCurrentUser) || null;
    res.json({ ranking, current });
  } catch (error) { next(error); }
});

router.get('/certificado', auth, async (req, res, next) => {
  try {
    let progress = await getProgress(req.digitacaoUser.id);
    let certificate = progress.certificate;
    if (!certificate && progress.completed === TOTAL_EXERCISES) certificate = await issueCertificate(req.digitacaoUser.id);
    res.json({ certificate, progress: await getProgress(req.digitacaoUser.id) });
  } catch (error) { next(error); }
});

router.get('/certificados/validar/:codigo', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT c.codigo, c.curso, c.carga_horaria, c.emitido_em, u.nome ' +
      'FROM digitacao_certificados c JOIN digitacao_usuarios u ON u.id = c.usuario_id ' +
      'WHERE UPPER(c.codigo) = UPPER($1) AND c.revogado_em IS NULL AND u.status = $2',
      [String(req.params.codigo || '').trim(), 'ativo']);
    if (!rows.length) return res.status(404).json({ valido: false, error: 'Certificado não encontrado.' });
    const item = rows[0];
    res.json({ valido: true, aluno: item.nome, curso: item.curso, carga: item.carga_horaria + ' horas',
      conclusao: item.emitido_em, codigo: item.codigo });
  } catch (error) { next(error); }
});

module.exports = router;
