// ══════════════════════════════════════════════════════════════════════
// lib/odds-altas.js — Motor de VALUE em odds altas (reforma 03/07/2026)
//
// Filosofia: o virtual é RNG — mercado raro não tem previsão, tem PREÇO.
// A única pergunta que importa: a odd cotada paga mais do que a raridade
// custa? EV = odd × frequência. Só aparece oportunidade com EV ≥ limiar.
//
// Frequência estimada por jogo = shrinkage entre a base da LIGA (estável,
// milhares de jogos) e a do CONFRONTO (importa em liga heterogênea tipo
// Clássicos, onde a odd varia por favorito): f = (nc·fc + K·fl)/(nc + K).
// K alto → confronto só desloca a estimativa quando tem amostra de verdade
// (anti-overfitting; o motor antigo de "DNA 65%" morreu disso).
//
// Odds live: snapshot da EasyCo cota ams/amn, o05..o35, u05..u35 e
// gol0..gol6 (total EXATO). Odd 0 = mercado não cotado naquele jogo.
// Calibração 03/07 (12k jogos × odds live): value real aparece em 0-0 e
// over 3.5 (EV 1,05-1,10 na média, 1,2+ na ponta alta da faixa); gol5
// NUNCA paga (EV 0,6-0,7); ambas/gol1/gol2 neutro-negativo.
//
// 📊 PAPER-TRADING (03/07/2026): o tracker grava cada flag de value na
// tabela virturia_odds_value_snapshot ANTES do jogo e confere o resultado
// sozinho (lucro flat 1u: green = odd−1, red = −1). Prova o EV realizado
// sem arriscar dinheiro. Endpoint: GET /odds-altas/historico.
// ══════════════════════════════════════════════════════════════════════

const EA_BASE = 'https://api.easycoanalytics.com.br';

const _cache = new Map();
function cacheGet(k) { const e = _cache.get(k); return e && Date.now() < e.exp ? e.v : null; }
function cacheSet(k, v, ttl = 90000) { _cache.set(k, { v, exp: Date.now() + ttl }); }

// Mercados avaliados: chave da odd EasyCo → predicado sobre (a, b, g)
const MERCADOS = [
  // alt: chave alternativa do MESMO mercado (ex: Bet365 express_cup não cota
  // gol0, mas cota u05 = under 0.5 = 0-0). Usa o melhor preço disponível.
  { odd: 'gol0', alt: 'u05', rotulo: '0-0 (0 gols)', hit: (a, b, g) => g === 0 },
  { odd: 'gol1', rotulo: '1 gol exato',  hit: (a, b, g) => g === 1 },
  { odd: 'gol2', rotulo: '2 gols exatos',hit: (a, b, g) => g === 2 },
  { odd: 'gol3', rotulo: '3 gols exatos',hit: (a, b, g) => g === 3 },
  { odd: 'gol4', rotulo: '4 gols exatos',hit: (a, b, g) => g === 4 },
  { odd: 'gol5', rotulo: '5 gols exatos',hit: (a, b, g) => g === 5 },
  { odd: 'o35',  rotulo: 'OVER 3.5 (4+)',hit: (a, b, g) => g >= 4 },
  { odd: 'o25',  rotulo: 'OVER 2.5 (3+)',hit: (a, b, g) => g >= 3 },
  { odd: 'ams',  rotulo: 'AMBAS SIM',    hit: (a, b, g) => a > 0 && b > 0 },
];
const MERCADO_POR_CHAVE = Object.fromEntries(MERCADOS.map(m => [m.odd, m]));

const K_SHRINK = 60;    // peso da liga no shrinkage (confronto precisa de amostra pra deslocar)
const EV_TRACK = 1.10;  // limiar canônico do paper-trading (o tracker grava com este, fixo)

// ── Núcleo: frequências + pendentes EasyCo + EV por jogo ───────────────
async function calcularValue(db, tabela, ligasCfg, horas, evMin, toRealUtcMs, clockOffsetMs) {
  const cutoff = Date.now() - horas * 3600000;

  // 1. Frequências por LIGA e por CONFRONTO (janela cheia do banco)
  const { rows } = await db.query(`
    SELECT liga, team_a, team_b, ft_a, ft_b
    FROM ${tabela}
    WHERE start_time > $1 AND ft_a IS NOT NULL AND ft_b IS NOT NULL
  `, [cutoff]);

  const porLiga = {}, porConf = {};
  for (const r of rows) {
    const a = parseInt(r.ft_a), b = parseInt(r.ft_b), g = a + b;
    if (isNaN(g)) continue;
    const L = (porLiga[r.liga] = porLiga[r.liga] || { n: 0, hits: {} });
    L.n++;
    const ck = `${r.liga}|${r.team_a}|${r.team_b}`;
    const C = (porConf[ck] = porConf[ck] || { n: 0, hits: {} });
    C.n++;
    for (const m of MERCADOS) {
      if (m.hit(a, b, g)) {
        L.hits[m.odd] = (L.hits[m.odd] || 0) + 1;
        C.hits[m.odd] = (C.hits[m.odd] || 0) + 1;
      }
    }
  }

  // Régua por liga (painel de referência do front)
  const regua = {};
  for (const lg in porLiga) {
    const L = porLiga[lg];
    regua[lg] = { n: L.n, mercados: {} };
    for (const m of MERCADOS) {
      const f = (L.hits[m.odd] || 0) / L.n;
      regua[lg].mercados[m.odd] = {
        rotulo: m.rotulo,
        freq: +(f * 100).toFixed(1),
        breakeven: f > 0 ? +(1 / f).toFixed(2) : null,
      };
    }
  }

  // 2. Jogos pendentes na EasyCo (próximos ~90min) com odds live
  const pendentes = [];
  const agora  = Date.now();
  const janela = 90 * 60 * 1000;
  for (const { sub, liga, provider = 'betano' } of ligasCfg) {
    try {
      const url  = `${EA_BASE}/snapshot?provider=${provider}&sub=${encodeURIComponent(sub)}&_t=${Date.now()}`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (!Array.isArray(data)) continue;
      for (const j of data) {
        if (j.status === 'finalizado') continue;
        if (!j.date || !j.teamA || !j.teamB || !j.odds) continue;
        const tsReal = new Date(j.date).getTime() + toRealUtcMs;
        if (isNaN(tsReal)) continue;
        if (tsReal < agora - 5 * 60000 || tsReal > agora + janela) continue;
        pendentes.push({ liga, teamA: j.teamA, teamB: j.teamB,
          slotMin: new Date(j.date).getUTCMinutes(), ts: tsReal, odds: j.odds });
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // 3. EV por jogo × mercado cotado
  const jogos = [];
  for (const p of pendentes) {
    const L = porLiga[p.liga];
    if (!L || L.n < 200) continue; // liga sem base confiável não entra
    const C = porConf[`${p.liga}|${p.teamA}|${p.teamB}`] || { n: 0, hits: {} };
    const mercados = [];
    for (const m of MERCADOS) {
      let odd = parseFloat(p.odds[m.odd]) || 0;
      if (m.alt) odd = Math.max(odd, parseFloat(p.odds[m.alt]) || 0); // mesmo mercado, melhor preço
      if (!odd || odd <= 1) continue; // não cotado
      const fl = (L.hits[m.odd] || 0) / L.n;
      const fc = C.n ? (C.hits[m.odd] || 0) / C.n : fl;
      const f  = (C.n * fc + K_SHRINK * fl) / (C.n + K_SHRINK); // shrinkage
      const ev = odd * f;
      mercados.push({
        chave: m.odd, mercado: m.rotulo, odd,
        freq: +(f * 100).toFixed(1),
        freq_liga: +(fl * 100).toFixed(1),
        n_conf: C.n,
        ev: +ev.toFixed(2),
        value: ev >= evMin,
      });
    }
    if (!mercados.length) continue;
    mercados.sort((x, y) => y.ev - x.ev);
    jogos.push({
      liga: p.liga, team_a: p.teamA, team_b: p.teamB,
      slot_min: p.slotMin, ts: p.ts,
      hora_alvo: new Date(p.ts + clockOffsetMs).getUTCHours(),
      minutos_ate: Math.round((p.ts - agora) / 60000),
      mercados,
      tem_value: mercados.some(m => m.value),
    });
  }
  jogos.sort((x, y) => x.ts - y.ts);

  return {
    ok: true,
    ev_min: evMin,
    total_jogos: jogos.length,
    com_value: jogos.filter(j => j.tem_value).length,
    jogos,
    regua,
  };
}

// ── 📊 Paper-trading: tabela + gravador + conferidor ───────────────────
let _trackTableReady = null;
function initTrackTable(db) {
  if (_trackTableReady) return _trackTableReady;
  _trackTableReady = db.query(`
    CREATE TABLE IF NOT EXISTS virturia_odds_value_snapshot (
      id           SERIAL PRIMARY KEY,
      provedor     VARCHAR(10) NOT NULL,
      liga         VARCHAR(40) NOT NULL,
      team_a       VARCHAR(60),
      team_b       VARCHAR(60),
      slot_min     INTEGER,
      ts           BIGINT NOT NULL,
      mercado      VARCHAR(8) NOT NULL,
      rotulo       VARCHAR(20),
      odd          REAL NOT NULL,
      freq         REAL,
      ev           REAL,
      resultado    VARCHAR(10),
      acerto       BOOLEAN,
      lucro        REAL,
      criado_em    TIMESTAMP DEFAULT NOW(),
      conferido_em TIMESTAMP,
      UNIQUE(provedor, liga, ts, mercado)
    )
  `).catch(e => { _trackTableReady = null; throw e; });
  return _trackTableReady;
}

// Grava as flags de value dos jogos pendentes (foto ANTES do jogo; trava por UNIQUE)
async function gravarFlags(db, tabela, ligasCfg, provedor, toRealUtcMs, clockOffsetMs) {
  await initTrackTable(db);
  const r = await calcularValue(db, tabela, ligasCfg, 720, EV_TRACK, toRealUtcMs, clockOffsetMs);
  let n = 0;
  for (const j of r.jogos) {
    for (const m of j.mercados) {
      if (!m.value) continue;
      const ins = await db.query(`
        INSERT INTO virturia_odds_value_snapshot
          (provedor, liga, team_a, team_b, slot_min, ts, mercado, rotulo, odd, freq, ev)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (provedor, liga, ts, mercado) DO NOTHING
      `, [provedor, j.liga, j.team_a, j.team_b, j.slot_min, j.ts, m.chave, m.mercado, m.odd, m.freq, m.ev]);
      n += ins.rowCount;
    }
  }
  if (n) console.log(`[odds-track ${provedor}] ${n} flags de value gravadas`);
}

// Confere flags de jogos que já terminaram (resultado na tabela do provedor)
async function conferirFlags(db, tabela, provedor) {
  await initTrackTable(db);
  const agora = Date.now();
  const { rows } = await db.query(`
    SELECT id, liga, slot_min, ts, mercado, odd
    FROM virturia_odds_value_snapshot
    WHERE provedor=$1 AND acerto IS NULL AND ts < $2 AND ts > $3
    LIMIT 500
  `, [provedor, agora - 15 * 60000, agora - 72 * 3600000]);
  for (const f of rows) {
    const { rows: j } = await db.query(`
      SELECT ft_a, ft_b, ft_str FROM ${tabela}
      WHERE liga=$1 AND slot_min=$2 AND start_time BETWEEN $3 AND $4
      LIMIT 1
    `, [f.liga, f.slot_min, Number(f.ts) - 4 * 60000, Number(f.ts) + 4 * 60000]);
    if (!j.length) continue; // coleta ainda não trouxe o jogo
    const a = parseInt(j[0].ft_a), b = parseInt(j[0].ft_b);
    const m = MERCADO_POR_CHAVE[f.mercado];
    if (isNaN(a + b) || !m) continue;
    const acerto = m.hit(a, b, a + b);
    const lucro  = acerto ? +(f.odd - 1).toFixed(2) : -1;
    await db.query(`
      UPDATE virturia_odds_value_snapshot
      SET resultado=$1, acerto=$2, lucro=$3, conferido_em=NOW()
      WHERE id=$4
    `, [j[0].ft_str, acerto, lucro, f.id]);
  }
}

// ── Factory principal: handler GET /odds-altas + agendadores do tracker ─
const _trackersOn = new Set();
module.exports = function(db, tabela, ligasCfg, toRealUtcMs = 3 * 3600000, clockOffsetMs = -3 * 3600000) {
  const provedor = tabela === 'virturia_resultados_b365' ? 'bet365' : 'betano';

  // agendadores (1x por tabela): grava flags e confere resultados a cada 5min
  if (!_trackersOn.has(tabela)) {
    _trackersOn.add(tabela);
    const boot = async () => {
      await gravarFlags(db, tabela, ligasCfg, provedor, toRealUtcMs, clockOffsetMs).catch(e => console.error('[odds-track grava]', e.message));
      await conferirFlags(db, tabela, provedor).catch(e => console.error('[odds-track confere]', e.message));
    };
    setTimeout(boot, 20 * 1000); // depois do boot do server
    setInterval(() => gravarFlags(db, tabela, ligasCfg, provedor, toRealUtcMs, clockOffsetMs).catch(e => console.error('[odds-track grava]', e.message)), 5 * 60 * 1000);
    setInterval(() => conferirFlags(db, tabela, provedor).catch(e => console.error('[odds-track confere]', e.message)), 5 * 60 * 1000);
  }

  return async function(req, res) {
    try {
      const horas = Math.min(parseInt(req.query.horas) || 720, 8760);
      const evMin = Math.max(parseFloat(req.query.ev_min) || 1.10, 1.0);
      const cacheKey = `oddsaltas_${tabela}_${horas}_${evMin}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const resultado = await calcularValue(db, tabela, ligasCfg, horas, evMin, toRealUtcMs, clockOffsetMs);
      cacheSet(cacheKey, resultado, 90000);
      res.json(resultado);
    } catch (e) {
      console.error('[odds-altas]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  };
};

// ── GET /odds-altas/historico?horas=168 — EV REALIZADO (paper-trading) ─
module.exports.historico = function(db, tabela) {
  const provedor = tabela === 'virturia_resultados_b365' ? 'bet365' : 'betano';
  return async function(req, res) {
    try {
      await initTrackTable(db);
      const horas = Math.min(parseInt(req.query.horas) || 168, 8760);
      const desde = Date.now() - horas * 3600000;
      const { rows } = await db.query(`
        SELECT liga, mercado, rotulo, odd, freq, ev, resultado, acerto, lucro, ts
        FROM virturia_odds_value_snapshot
        WHERE provedor=$1 AND ts > $2
        ORDER BY ts DESC
      `, [provedor, desde]);
      const conf = rows.filter(r => r.acerto !== null);
      const porMercado = {};
      for (const r of conf) {
        const M = (porMercado[r.mercado] = porMercado[r.mercado] || { rotulo: r.rotulo, n: 0, greens: 0, lucro: 0, odd_media: 0 });
        M.n++; M.lucro += r.lucro; M.odd_media += r.odd;
        if (r.acerto) M.greens++;
      }
      for (const k in porMercado) {
        const M = porMercado[k];
        M.odd_media    = +(M.odd_media / M.n).toFixed(2);
        M.lucro        = +M.lucro.toFixed(2);
        M.acerto_pct   = +(M.greens * 100 / M.n).toFixed(1);
        M.ev_realizado = +((M.lucro / M.n) + 1).toFixed(2);
      }
      const lucroTotal = +conf.reduce((s, r) => s + r.lucro, 0).toFixed(2);
      res.json({
        ok: true,
        total_flags: rows.length,
        conferidas: conf.length,
        pendentes: rows.length - conf.length,
        greens: conf.filter(r => r.acerto).length,
        lucro_total: lucroTotal,
        ev_realizado: conf.length ? +((lucroTotal / conf.length) + 1).toFixed(2) : null,
        por_mercado: porMercado,
      });
    } catch (e) {
      console.error('[odds-altas/historico]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  };
};
