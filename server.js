require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Middlewares ────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ── Rotas ──────────────────────────────────────────────────
app.use('/api/turmas',      require('./routes/turmas'));
app.use('/api/alunos',      require('./routes/alunos'));
app.use('/api/reservas',    require('./routes/reservas'));
app.use('/api/cursos',      require('./routes/cursos'));
app.use('/api/pagamentos',  require('./routes/pagamentos'));
app.use('/api/certificado', require('./routes/certificados'));
app.use('/api/interessados', require('./routes/interessados'));
app.use('/api/contato',     require('./routes/contato'));
app.use('/api',             require('./routes/portfolio'));

// ── Webhook InfinitePay + redirect curto ──────────────────
const { webhookInfinitePay, payRedirect } = require('./routes/pagamentos');
app.post('/webhook/infinitepay', webhookInfinitePay);
app.get('/pay/:id', payRedirect);

app.listen(PORT, () => console.log(`F5 API rodando na porta ${PORT}`));
