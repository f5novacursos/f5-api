require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Middlewares ────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '25mb' }));

// ── Rotas ──────────────────────────────────────────────────
app.use('/api/turmas',      require('./routes/turmas'));
app.use('/api/alunos',      require('./routes/alunos'));
app.use('/api/reservas',    require('./routes/reservas'));
app.use('/api/cursos',      require('./routes/cursos'));
app.use('/api/pagamentos',  require('./routes/pagamentos'));
app.use('/api/certificado', require('./routes/certificados'));
app.use('/api/aulas',       require('./routes/aulas'));
app.use('/api/interessados', require('./routes/interessados'));
app.use('/api/frequencia',  require('./routes/frequencia'));
app.use('/api/financeiro',  require('./routes/financeiro'));
app.use('/api/contato',     require('./routes/contato'));
app.use('/api/ead',         require('./routes/ead'));
app.use('/api/lixeira',     require('./routes/lixeira'));
// Virturia: nunca cachear — dados mudam a cada minuto
app.use('/api/virturia', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use('/api/virturia',    require('./routes/virturia'));
app.use('/api/virturia',    require('./routes/virturia-auth'));
app.use('/api/virturia',    require('./routes/virturia-admin'));
app.use('/api/virturia',    require('./routes/virturia-objetivo'));
const _dbVirturia = require('./db');
app.use('/api/virturia',    require('./routes/virturia-contexto')(_dbVirturia, 'virturia_resultados', -10800000));
app.use('/api/virturia-b365', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use('/api/virturia-b365', require('./routes/virturia-b365'));
app.use('/api/virturia-b365', require('./routes/virturia-contexto')(_dbVirturia, 'virturia_resultados_b365', 3600000));
app.use('/api',             require('./routes/portfolio'));
app.use('/api',             require('./routes/clientes-web'));

// ── Webhook InfinitePay + redirect curto ──────────────────
const { webhookInfinitePay, payRedirect } = require('./routes/pagamentos');
app.post('/webhook/infinitepay', webhookInfinitePay);
app.get('/pay/:id', payRedirect);

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Coletor Bet365 VirtuIA — substitui Cloudflare Worker ─────────────────
// IMPORTANTE: a rota collector-status precisa ser registrada ANTES do 404,
// senao o handler de "Rota nao encontrada" intercepta a requisicao primeiro.
const { startCollector: startB365, getStatus: getB365Status } = require('./routes/collector-b365');
app.get('/api/virturia-b365/collector-status', (req, res) => {
  res.json({ ok: true, ...getB365Status() });
});

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`✅  F5 API rodando na porta ${PORT}`);
  startB365(); // inicia o coletor depois que a API sobe

  // Lixeira: limpa o que passou de 30 dias no boot e a cada 24h.
  const lixeira = require('./lib/lixeira');
  lixeira.purgarExpirados().catch(e => console.error('[lixeira] purga inicial:', e.message));
  setInterval(() => {
    lixeira.purgarExpirados().catch(e => console.error('[lixeira] purga diária:', e.message));
  }, 24 * 60 * 60 * 1000);
});
