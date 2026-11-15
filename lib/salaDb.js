// F5 Sala — banco de dados da plataforma (clientes = escolas, chaves de licença = salas, computadores, pagamentos, suporte).
// As tabelas são criadas sozinhas na primeira vez (mesmo padrão das outras rotas do f5-api: CREATE TABLE IF NOT EXISTS).
// Por segurança nada é apagado: licença cancelada/suspensa só muda de estado.
const db = require('../db');
const crypto = require('crypto');

const SQL = [
  `CREATE TABLE IF NOT EXISTS sala_config (
     chave VARCHAR(80) PRIMARY KEY,
     valor TEXT NOT NULL,
     atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Cliente = a ESCOLA / empresa (quem compra e é dona do sistema). Os professores são funcionários dela.
  `CREATE TABLE IF NOT EXISTS sala_clientes (
     id SERIAL PRIMARY KEY,
     escola VARCHAR(160) NOT NULL,
     responsavel VARCHAR(160),
     email VARCHAR(254) NOT NULL,
     telefone VARCHAR(30),
     documento VARCHAR(30),
     site VARCHAR(200),
     instagram VARCHAR(200),
     origem VARCHAR(30) NOT NULL DEFAULT 'admin',
     aceite_avisos BOOLEAN NOT NULL DEFAULT TRUE,
     obs TEXT,
     criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Licença = 1 chave = 1 sala (1 computador de professor + até N computadores de aluno).
  `CREATE TABLE IF NOT EXISTS sala_licencas (
     id SERIAL PRIMARY KEY,
     cliente_id INTEGER NOT NULL REFERENCES sala_clientes(id),
     chave VARCHAR(30) NOT NULL UNIQUE,
     token_pagamento VARCHAR(40) NOT NULL UNIQUE,
     sala VARCHAR(60) NOT NULL,
     plano VARCHAR(12) NOT NULL DEFAULT 'sala',
     ciclo VARCHAR(8) NOT NULL DEFAULT 'mensal',
     valor NUMERIC(10,2),
     limite_alunos INTEGER NOT NULL DEFAULT 35,
     max_maquinas INTEGER NOT NULL DEFAULT 1,
     status VARCHAR(12) NOT NULL DEFAULT 'ativo',
     vitalicia BOOLEAN NOT NULL DEFAULT FALSE,
     proximo_vencimento DATE,
     demo_ate TIMESTAMPTZ,
     excedeu_em TIMESTAMPTZ,
     criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS sala_maquinas (
     id SERIAL PRIMARY KEY,
     licenca_id INTEGER NOT NULL REFERENCES sala_licencas(id),
     tipo VARCHAR(10) NOT NULL,
     hash VARCHAR(80) NOT NULL,
     nome VARCHAR(120),
     versao VARCHAR(20),
     ativa BOOLEAN NOT NULL DEFAULT TRUE,
     primeiro_visto TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     ultimo_visto TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     desativada_em TIMESTAMPTZ,
     desativada_motivo VARCHAR(20)
   )`,
  `CREATE INDEX IF NOT EXISTS sala_maquinas_lic ON sala_maquinas (licenca_id, tipo)`,
  `CREATE INDEX IF NOT EXISTS sala_maquinas_hash ON sala_maquinas (hash)`,
  `CREATE TABLE IF NOT EXISTS sala_professores (
     id SERIAL PRIMARY KEY,
     licenca_id INTEGER NOT NULL REFERENCES sala_licencas(id),
     nome VARCHAR(120) NOT NULL,
     email VARCHAR(254),
     ultimo_visto TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (licenca_id, nome)
   )`,
  `CREATE TABLE IF NOT EXISTS sala_pagamentos (
     id SERIAL PRIMARY KEY,
     licenca_id INTEGER NOT NULL REFERENCES sala_licencas(id),
     mp_payment_id VARCHAR(40) UNIQUE,
     valor NUMERIC(10,2) NOT NULL,
     ciclo VARCHAR(8) NOT NULL,
     metodo VARCHAR(20),
     origem VARCHAR(10) NOT NULL DEFAULT 'mp',
     obs TEXT,
     pago_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     novo_vencimento DATE
   )`,
  `CREATE TABLE IF NOT EXISTS sala_avisos (
     id SERIAL PRIMARY KEY,
     licenca_id INTEGER NOT NULL REFERENCES sala_licencas(id),
     dia INTEGER NOT NULL,
     data DATE NOT NULL,
     canal VARCHAR(20),
     enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (licenca_id, dia, data)
   )`,
  `CREATE TABLE IF NOT EXISTS sala_codigos (
     email VARCHAR(254) NOT NULL,
     finalidade VARCHAR(12) NOT NULL,
     hash VARCHAR(80) NOT NULL,
     expira TIMESTAMPTZ NOT NULL,
     tentativas INTEGER NOT NULL DEFAULT 0,
     dados TEXT,
     PRIMARY KEY (email, finalidade)
   )`,
  `CREATE TABLE IF NOT EXISTS sala_chamados (
     id SERIAL PRIMARY KEY,
     licenca_id INTEGER NOT NULL REFERENCES sala_licencas(id),
     tipo VARCHAR(20) NOT NULL DEFAULT 'duvida',
     assunto VARCHAR(160),
     status VARCHAR(12) NOT NULL DEFAULT 'aberto',
     professor VARCHAR(120),
     versao VARCHAR(20),
     criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS sala_chamados_msgs (
     id SERIAL PRIMARY KEY,
     chamado_id INTEGER NOT NULL REFERENCES sala_chamados(id),
     autor VARCHAR(10) NOT NULL,
     texto TEXT NOT NULL,
     lida_cliente BOOLEAN NOT NULL DEFAULT FALSE,
     criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];

const aleatorio = (alfabeto, n) => Array.from({ length: n }, () => alfabeto[crypto.randomInt(0, alfabeto.length)]).join('');
const ALFA_CHAVE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 (confunde ao digitar)
const novaChave = () => `F5S-${aleatorio(ALFA_CHAVE, 4)}-${aleatorio(ALFA_CHAVE, 4)}-${aleatorio(ALFA_CHAVE, 4)}`;
const novoToken = () => crypto.randomBytes(18).toString('base64url');
const normalizarChave = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^F5S/, 'F5S-').replace(/^(F5S-)([A-Z0-9]{4})([A-Z0-9]{4})([A-Z0-9]{4}).*$/, '$1$2-$3-$4');

let pronto = null;
// Cria as tabelas (uma vez) e a licença interna da F5 (vitalícia). Pode ser chamada à vontade: reaproveita a mesma promessa.
function garantirTabelas() {
  if (!pronto) {
    pronto = (async () => {
      for (const s of SQL) await db.query(s);
      const email = 'f5novacursos@gmail.com';
      const { rows } = await db.query('SELECT id FROM sala_clientes WHERE email = $1 LIMIT 1', [email]);
      if (!rows.length) {
        const c = await db.query(
          `INSERT INTO sala_clientes (escola, responsavel, email, telefone, origem, obs) VALUES ($1,$2,$3,$4,'interna',$5) RETURNING id`,
          ['F5 Nova Cursos', 'Eduardo', email, null, 'Cliente interno: licenças vitalícias da própria escola.']
        );
        await db.query(
          `INSERT INTO sala_licencas (cliente_id, chave, token_pagamento, sala, plano, ciclo, valor, limite_alunos, max_maquinas, status, vitalicia)
           VALUES ($1,$2,$3,'F5','interna','mensal',0,200,10,'ativo',TRUE)`,
          [c.rows[0].id, novaChave(), novoToken()]
        );
        console.log('[sala] cliente interno F5 criado com licença vitalícia (veja a chave no admin → F5 Sala)');
      }
    })().catch((e) => { pronto = null; console.error('[sala] falha ao preparar o banco:', e.message); throw e; });
  }
  return pronto;
}

async function lerConfig(chave, padrao = '') {
  const { rows } = await db.query('SELECT valor FROM sala_config WHERE chave = $1', [chave]);
  return rows.length ? rows[0].valor : padrao;
}
async function gravarConfig(chave, valor) {
  await db.query(
    `INSERT INTO sala_config (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
    [chave, String(valor)]
  );
}

module.exports = { garantirTabelas, lerConfig, gravarConfig, novaChave, novoToken, normalizarChave };
