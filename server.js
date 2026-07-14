require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 4000;

// ── Middlewares ────────────────────────────────────────────
// Headers de segurança (sem dependência externa)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '25mb' }));

const adminAuth = require('./middleware/adminAuth');

// ── Rotas ──────────────────────────────────────────────────
app.use('/api/turmas',      require('./routes/turmas'));
app.use('/api/alunos',      adminAuth, require('./routes/alunos'));
app.use('/api/reservas',    require('./routes/reservas'));
app.use('/api/cursos',      require('./routes/cursos'));
app.use('/api/pagamentos',  require('./routes/pagamentos'));
app.use('/api/certificado', require('./routes/certificados'));
app.use('/api/aulas',       adminAuth, require('./routes/aulas'));
app.use('/api/interessados', adminAuth, require('./routes/interessados'));
app.use('/api/frequencia',  adminAuth, require('./routes/frequencia'));
app.use('/api/financeiro',  adminAuth, require('./routes/financeiro'));
app.use('/api/contato',     require('./routes/contato'));
app.use('/api/ead',         require('./routes/ead'));
app.use('/api/lixeira',     adminAuth, require('./routes/lixeira'));
app.use('/api/debounce',    require('./routes/debounce'));
app.use('/api/leads',       require('./routes/leads'));
app.use('/api/planos',      require('./routes/planos'));
app.use('/api',             require('./routes/portfolio'));
app.use('/api',             require('./routes/clientes-web'));

// ── Webhooks externos ──────────────────────────────────────
const { webhookInfinitePay, payRedirect } = require('./routes/pagamentos');
app.post('/webhook/infinitepay', webhookInfinitePay);
app.use('/webhook/chatwoot', require('./routes/chatwoot-webhook'));
app.get('/pay/:id', payRedirect);

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
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

  // Lixeira: limpa o que passou de 30 dias no boot e a cada 24h.
  const lixeira = require('./lib/lixeira');
  lixeira.purgarExpirados().catch(e => console.error('[lixeira] purga inicial:', e.message));
  setInterval(() => {
    lixeira.purgarExpirados().catch(e => console.error('[lixeira] purga diária:', e.message));
  }, 24 * 60 * 60 * 1000);
});
