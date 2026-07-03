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
// ══════════════════════════════════════════════════════════════════════

const EA_BASE = 'https://api.easycoanalytics.com.br';

const _cache = new Map();
function cacheGet(k) { const e = _cache.get(k); return e && Date.now() < e.exp ? e.v : null; }
function cacheSet(k, v, ttl = 90000) { _cache.set(k, { v, exp: Date.now() + ttl }); }

// Mercados avaliados: chave da odd EasyCo → predicado sobre (a, b, g)
const MERCADOS = [
  { odd: 'gol0', rotulo: '0-0 (0 gols)', hit: (a, b, g) => g === 0 },
  { odd: 'gol1', rotulo: '1 gol exato',  hit: (a, b, g) => g === 1 },
  { odd: 'gol2', rotulo: '2 gols exatos',hit: (a, b, g) => g === 2 },
  { odd: 'gol3', rotulo: '3 gols exatos',hit: (a, b, g) => g === 3 },
  { odd: 'gol4', rotulo: '4 gols exatos',hit: (a, b, g) => g === 4 },
  { odd: 'gol5', rotulo: '5 gols exatos',hit: (a, b, g) => g === 5 },
  { odd: 'o35',  rotulo: 'OVER 3.5 (4+)',hit: (a, b, g) => g >= 4 },
  { odd: 'o25',  rotulo: 'OVER 2.5 (3+)',hit: (a, b, g) => g >= 3 },
  { odd: 'ams',  rotulo: 'AMBAS SIM',    hit: (a, b, g) => a > 0 && b > 0 },
];

const K_SHRINK = 60;   // peso da liga no shrinkage (confronto precisa de amostra pra deslocar)

// toRealUtcMs: EasyCo grava BRT rotulado como UTC → somar 3h para UTC real
// clockOffsetMs: UTC real → hora do relógio do provedor (Betano -3h)
module.exports = function(db, tabela, ligasCfg, toRealUtcMs = 3 * 3600000, clockOffsetMs = -3 * 3600000) {
  return async function(req, res) {
    try {
      const horas   = Math.min(parseInt(req.query.horas) || 720, 8760);
      const evMin   = Math.max(parseFloat(req.query.ev_min) || 1.10, 1.0);
      const cutoff  = Date.now() - horas * 3600000;

      const cacheKey = `oddsaltas_${tabela}_${horas}_${evMin}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      // ── 1. Frequências por LIGA e por CONFRONTO (janela cheia do banco) ─
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

      // Régua por liga (pro painel de referência do front)
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

      // ── 2. Jogos pendentes na EasyCo (próximos ~90min) com odds live ───
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

      // ── 3. EV por jogo × mercado cotado ─────────────────────────────────
      const jogos = [];
      for (const p of pendentes) {
        const L = porLiga[p.liga];
        if (!L || L.n < 200) continue; // liga sem base confiável não entra
        const C = porConf[`${p.liga}|${p.teamA}|${p.teamB}`] || { n: 0, hits: {} };
        const mercados = [];
        for (const m of MERCADOS) {
          const odd = parseFloat(p.odds[m.odd]);
          if (!odd || odd <= 1) continue; // não cotado
          const fl = (L.hits[m.odd] || 0) / L.n;
          const fc = C.n ? (C.hits[m.odd] || 0) / C.n : fl;
          const f  = (C.n * fc + K_SHRINK * fl) / (C.n + K_SHRINK); // shrinkage
          const ev = odd * f;
          mercados.push({
            mercado: m.rotulo, odd,
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

      const resultado = {
        ok: true,
        ev_min: evMin,
        total_jogos: jogos.length,
        com_value: jogos.filter(j => j.tem_value).length,
        jogos,
        regua,
      };
      cacheSet(cacheKey, resultado, 90000);
      res.json(resultado);
    } catch (e) {
      console.error('[odds-altas]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  };
};
