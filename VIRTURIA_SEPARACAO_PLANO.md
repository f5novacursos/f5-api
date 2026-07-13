# VirtuIA — Plano de Separação do f5-api

> Documento vivo. Sempre que avançar uma etapa, marca o checkbox aqui antes de encerrar a sessão.
> Levantamento inicial feito em **09/07/2026**.

## Por que isso existe

O VirtuIA (coleta de dados de apostas esportivas — Betano/Bet365, uso pessoal do Eduardo)
foi criado dentro da mesma infraestrutura do F5 Nova Cursos e hoje está misturado com o
código de produção da escola. Isso gerou um incidente real: o Google Safe Browsing marcou
`f5novacursos.com.br` como "página enganosa" por causa do subdomínio `virturia.f5novacursos.com.br`
(ver Fase 0). O objetivo deste plano é desacoplar 100% o VirtuIA do F5 Nova Cursos: código,
deploy, banco de dados e domínio, cada um no seu lugar — no modelo do projeto **F5-CAIXA**
(que já é limpo: app + api + db separados).

## Situação atual (mapeada em 09/07/2026)

O código do VirtuIA está espalhado em **3 lugares**:

1. **Cloudflare Worker** (`C:\Projetos\www\virturia\worker.js`, `worker-b365.js`) — versão antiga,
   status incerto (pode estar desativada, o comentário no f5-api diz que foi substituída).
2. **`f5-api` (Node/Express) — É O QUE ESTÁ REALMENTE EM PRODUÇÃO HOJE.**
   O frontend (`virturia.f5novacursos.com.br`) chama diretamente `https://api.f5novacursos.com.br/api/virturia/*`
   — ou seja, usa o mesmo domínio de API da escola.
   - Rotas montadas em `f5-api/server.js` linhas 41-57 e 72-78:
     - `app.use('/api/virturia', require('./routes/virturia'))` — 1019 linhas
     - `app.use('/api/virturia', require('./routes/virturia-auth'))` — 111 linhas (login/JWT)
     - `app.use('/api/virturia', require('./routes/virturia-admin'))` — 150 linhas
     - `app.use('/api/virturia', require('./routes/virturia-objetivo'))` — 442 linhas
     - `app.use('/api/virturia', require('./routes/virturia-contexto')(_dbVirturia, 'virturia_resultados', -10800000))` — 739 linhas
     - `app.use('/api/virturia-b365', require('./routes/virturia-b365'))` — 855 linhas
     - `app.use('/api/virturia-b365', require('./routes/virturia-contexto')(_dbVirturia, 'virturia_resultados_b365', 3600000))`
     - Coletor Bet365 (`routes/collector-b365.js`, 164 linhas) — inicia sozinho junto com o
       servidor via `startB365()` no `app.listen` (linha ~93 do server.js)
   - **Usa o MESMO Postgres do F5 Nova Cursos** — `db.js` só lê `process.env.DATABASE_URL`,
     não tem separação de banco no código.
   - Variáveis de ambiente específicas do VirtuIA usadas nessas rotas: `VIRTURIA_JWT_SECRET`,
     `VIRTURIA_CHAVE` (`routes/virturia-auth.js`).
3. **`virturia/backend` (Python/Flask)** — reescrita nova, já rodando separada no Coolify
   como app `virturia-backend`, mas **incompleta**: só tem `/api/health`, `/api/status`,
   `/api/resultados`. Não tem login, admin, objetivo, contexto nem o coletor do Bet365.
   **Não é isso que está no ar hoje** — o frontend ainda chama o `f5-api`.

### Infraestrutura já existente no Coolify (projeto **VIRTURIA**, separado de **F5CURSOS-SITE**)
- `virturia` — frontend estático, domínio `https://virturia.f5novacursos.com.br`
- `virturia-backend` — o backend Python incompleto, URL tipo `*.sslip.io`
- `virturia-db` — banco Postgres já provisionado, **status de uso não confirmado** (pode estar vazio)

### Repositórios GitHub
- `f5novacursos/f5-api` — backend da escola, contém as rotas antigas do VirtuIA (ver acima)
- `f5novacursos/virturia-site` — repo próprio do VirtuIA (frontend em `/` + backend Python em `/backend`)

## Fase 0 — Mitigação de segurança ✅ CONCLUÍDO (08-09/07/2026)
- [x] HTTP Basic Authentication ativado em `virturia` (Coolify → Advanced → HTTP Basic Auth)
- [x] HTTP Basic Authentication ativado em `virturia-backend`
- [x] Testado: painel do VirtuIA continua funcionando normalmente com a senha
- [x] Revisão de segurança solicitada no Google Search Console (site: f5novacursos.com.br,
      motivo: "Páginas enganosas" detectado em 03/06/2026, causado pelo subdomínio virturia
      publicamente acessível)
- [ ] Confirmar quando o Google remover o aviso (checar em alguns dias em
      `https://search.google.com/search-console` → Segurança e ações manuais → Problemas de segurança)
- [x] **Bônus (09/07/2026, adianta parte da Fase 6):** app `virturia` (frontend) migrado do
      domínio `virturia.f5novacursos.com.br` para `http://virtuia.2.24.108.140.sslip.io`
      (Coolify → General → Domains → Generate Domain, precisou completar manualmente com o
      IP porque o botão gerou incompleto). Registro DNS `virturia.f5novacursos.com.br` (tipo A,
      apontava pra `2.24.108.140`) **excluído** da zona DNS do domínio. O subdomínio não existe
      mais — nem resolve.
      - ⚠️ Nota: só ficou funcionando em **http (sem TLS)** — o Coolify não gerou o roteador
        https/certificado Let's Encrypt pra esse domínio sslip.io (só existe o router
        `http-0`, sem `https-0` com `certresolver`). Funciona, mas a senha do Basic Auth
        trafega sem criptografia. Baixo risco (só o Eduardo acessa), mas revisar se der pra
        gerar certificado depois, ou resolver quando migrar pro domínio próprio (Fase 6).
      - `virturia-backend` já usava um domínio `*.sslip.io` auto-gerado desde antes, nunca
        teve DNS próprio em f5novacursos.com.br — nada a fazer nele.

## Objetivo final
VirtuIA rodando 100% isolado: código próprio (sem nenhuma linha dentro do `f5-api`), deploy
próprio, banco próprio, domínio próprio (ou `*.sslip.io` até comprar um domínio — funciona
sem problema, é só menos bonito). **Zero rota `/api/virturia*` dentro do `f5-api`.**

## Estratégia
Não vale a pena terminar a reescrita em Python agora (está pela metade). O caminho mais
rápido e seguro é **extrair o código Node que já funciona** do `f5-api` para um app novo e
separado — mesma lógica, só rodando sozinho. Migrar pra Python (ou não) fica pra depois,
sem pressa. Fazer tudo **em paralelo** (backend novo rodando ao lado do antigo) até confirmar
que responde igual, só then desligar o antigo.

## Etapas

### Fase 1 — Preparar o novo backend Node isolado ✅ CONCLUÍDO (09/07/2026)
- [x] Decidido: repositório novo → criado **`f5novacursos/virturia-api`** (privado) via GitHub API
- [x] Copiado pra lá: `virturia.js`, `virturia-auth.js`, `virturia-admin.js`,
      `virturia-objetivo.js`, `virturia-contexto.js`, `virturia-b365.js`, `collector-b365.js`
      (de `f5-api/routes/`) + módulos extras que essas rotas precisavam de `f5-api/lib/`:
      `padroes-live.js`, `padroes-confronto.js`, `previsao.js`, `odds-altas.js`
- [x] Criado `server.js` novo, enxuto, só com essas rotas (baseado nas linhas 41-57 e 72-78
      do `f5-api/server.js` original). Porta padrão `4001` (pra não colidir com o f5-api na 4000)
- [x] Copiado `db.js` (aponta pro mesmo banco por enquanto — separar na Fase 3)
- [x] `package.json` enxuto (só as deps que o VirtuIA usa: express, cors, dotenv,
      jsonwebtoken, bcryptjs, pg — sem helmet/express-rate-limit/nodemailer, que são só do f5-api)
- [x] `.env.example` criado documentando: `PORT`, `CORS_ORIGIN`, `DATABASE_URL`, `DB_SSL`,
      `VIRTURIA_JWT_SECRET`, `VIRTURIA_CHAVE`
- [x] `Dockerfile` criado (adaptado do `f5-api`, expõe porta 4001)
- [x] Testado localmente (`node server.js` com banco falso) — subiu sem erro de `require` ou
      sintaxe, só os erros esperados de conexão com banco inválido
- [x] Commit + push feito pro `main` do `virturia-api`

**Pasta local:** `C:\Projetos\www\virturia-api`
**Repo:** `https://github.com/f5novacursos/virturia-api`

### Fase 2 — Deploy em paralelo (sem trocar nada em produção ainda) ✅ CONCLUÍDO (09/07/2026)
- [x] App `virturia-backend` no Coolify trocado: source mudado do Python (`virturia-site`,
      pasta `/backend`) pra `f5novacursos/virturia-api` (Node, raiz do repo). App renomeado
      pra `virturia-api`. Corrigido Base Directory (`/backend` → `/`) e Ports Exposes
      (`5000` → `4001`, sobra da config antiga) que causavam erro de build/bad gateway.
- [x] Variáveis de ambiente configuradas no Coolify: `PORT=4001`, `CORS_ORIGIN=*`,
      `DATABASE_URL` (mesmo Postgres do f5-api por enquanto), `DB_SSL=false`,
      `VIRTURIA_CHAVE=virturia2026secret` (sem `VIRTURIA_JWT_SECRET` — código cai no
      fallback pra `VIRTURIA_CHAVE`, igual produção)
- [x] Domínio próprio gerado: `http://virturia-api.2.24.108.140.sslip.io` (mesmo padrão do
      `virtuia.2.24.108.140.sslip.io` do frontend, sem TLS — ver nota da Fase 0)
      Continua protegido por HTTP Basic Auth (herdado do app, configurado na Fase 0)
- [x] Testado `/api/health` → `{"ok":true,...}`
- [x] Testado `/api/virturia/resultados` → dados reais batendo (`total: 1071`), banco
      conectando certinho

### Fase 3 — Banco de dados ✅ CONCLUÍDO (09/07/2026)
- [x] Levantadas as 8 tabelas do VirtuIA (grep no código do `virturia-api`):
      `virturia_resultados` (98k), `virturia_resultados_b365` (105k), `virturia_usuarios`,
      `virturia_objetivo_dia/entrada/plano`, `virturia_odds_value_snapshot` (27k),
      `virturia_especial_snapshot` (47k)
- [x] Migrado pro `virturia-db` do Coolify (postgres:18-alpine, host interno
      `xvlwjjvoi4itgi0iucjgcw93`): app parado → `pg_dump -t` das 8 tabelas (39MB) →
      restore via `psql` → contagens conferidas
- [x] `DATABASE_URL` do `virturia-api` trocada pra URL interna do `virturia-db` + redeploy.
      (Gotcha: no Coolify o campo de valor da env var NÃO leva o prefixo `KEY=` — colar só
      o valor, senão dá `getaddrinfo EAI_AGAIN`)
- [x] Verificado: `/api/virturia/resultados` e `/api/virturia-b365/resultados` servindo do
      banco novo; coletor b365 rodando e salvando (`collector-status` ok, lastError null)
- [x] Dump temporário `/tmp/virturia_dump.sql` removido do servidor
- [ ] **Depois (alguns dias de estabilidade):** dropar as tabelas `virturia_*` antigas do
      banco `f5nova` da escola — elas ficaram lá como backup natural. Comando:
      `docker exec vzsaov2vqg6vs1e6vr582v2k psql -U postgres -d f5nova -c "DROP TABLE IF EXISTS virturia_resultados, virturia_resultados_b365, virturia_usuarios, virturia_objetivo_dia, virturia_objetivo_entrada, virturia_objetivo_plano, virturia_odds_value_snapshot, virturia_especial_snapshot;"`

### Fase 4 — Apontar o frontend pro backend novo ✅ CONCLUÍDO (09/07/2026)
- [x] Trocadas as 7 ocorrências de `https://api.f5novacursos.com.br` pra
      `http://virturia-api.2.24.108.140.sslip.io` em `index.html` (4x), `admin-db.html`,
      `login.html` e `padroes.html`
- [x] Commit + push pro `main` do repo `virturia-site` (deploy automático, sem passo manual)
- [x] Testado `virtuia.2.24.108.140.sslip.io` (domínio atual do frontend, ver Fase 0) —
      login, dashboard e resto abrindo normal já com o backend novo

### Fase 5 — Desligar o antigo ✅ CONCLUÍDO (09/07/2026)
- [x] Removidos do `f5-api/server.js`: bloco de rotas virturia (linhas 41-57), bloco do
      coletor b365 (linhas 72-78) e a chamada `startB365()` no `app.listen`
- [x] Apagados do repo: `routes/virturia*.js` (6 arquivos), `routes/collector-b365.js` e
      as libs órfãs `lib/odds-altas.js`, `lib/padroes-confronto.js`, `lib/padroes-live.js`,
      `lib/previsao.js` (nenhuma outra rota usava — verificado por grep)
- [x] `package.json`: nada removido — `jsonwebtoken` e `bcryptjs` ainda são usados pelo
      `routes/ead.js` (não eram exclusivos do VirtuIA)
- [x] Deploy: git push + no servidor `git checkout origin/main -- server.js` + `docker cp`
      + `docker restart f5-api`. Só o `server.js` foi atualizado no servidor — os
      `routes/virturia*.js` locais do `/opt/f5-api` ficaram lá (inofensivos: nada mais os
      carrega; evita conflito com as mexidas locais fora do Git)
- [x] Verificado após deploy: `/api/cursos` OK, `/api/health` OK,
      `/api/virturia/resultados` no f5-api → 404 (zero código VirtuIA rodando),
      backend novo respondendo com dados reais

### Fase 6 — Domínio próprio (quando comprar)
- [ ] Apontar o domínio novo pro app do Coolify (Domains → gerar certificado)
- [ ] Atualizar `API_URL` no frontend pro domínio final

## Riscos e regras
- **Nunca** mexer na Fase 5 (remover do f5-api) antes de confirmar Fase 2 e 4 funcionando
  100% — é o único ponto que toca o backend de produção da escola.
- Pode (e deve) ser feito aos poucos, em sessões separadas — sempre confirmar o passo atual
  antes de avançar, do jeito que já vem sendo feito.
- Testar sempre em paralelo antes de trocar produção. Nunca cortar o antigo sem o novo já
  validado.

## Estado atual
**Separação CONCLUÍDA em 09/07/2026** (Fases 0 a 5 — código, deploy E banco). O VirtuIA
roda 100% fora do F5 Nova Cursos: repo próprio (`virturia-api`), app próprio no Coolify,
banco próprio (`virturia-db`), domínio `http://virturia-api.2.24.108.140.sslip.io`.
Zero rota `/api/virturia*` no `f5-api` (dá 404), zero dependência do Postgres da escola.

**⚠️ Descoberta pós-separação (09/07/2026 à noite):** o Cloudflare Worker `betano-proxy`
(`worker.js`) NÃO estava desativado — é ele quem coleta o Betano (via EasyCoAnalytics) e
salva via `POST /api/virturia/salvar`. Quando as rotas saíram do f5-api, a coleta do Betano
parou (Matrix vazia). **Corrigido:** `const API` do worker trocada pro backend novo +
`npx wrangler deploy` — coleta voltou e o snapshot da EasyCo preencheu o buraco da tarde
(8h de grade completa de volta). O worker do Bet365 (`bet365-proxy`) esse sim é obsoleto
(coletor roda dentro do virturia-api), mas ainda existe no Cloudflare batendo em 404 —
apagar quando quiser: `npx wrangler delete --config wrangler-b365.toml` na pasta virturia.

**O que falta:**
- Apagar o worker `bet365-proxy` do Cloudflare (obsoleto, ver acima).
- **Fase 6** — domínio próprio (quando comprar). Lembrar: trocar as URLs no frontend de novo
  (7 ocorrências em index.html/admin-db.html/login.html/padroes.html) e gerar certificado TLS.
- Dropar as tabelas `virturia_*` antigas do banco `f5nova` (ver checkbox na Fase 3) depois
  de alguns dias de estabilidade.
- Fase 0 pendência: confirmar remoção do aviso do Google Search Console.
- Backend Python antigo (`virturia/backend`) ficou obsoleto — pode arquivar/apagar depois.
