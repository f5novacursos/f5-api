// ══════════════════════════════════════════════════════════════════════
// lib/odds-altas.js  — Motor de Odds Altas (Diamante)
// Mercados raros com edge histórico real: 0-0, 5+ gols, total exato.
// Usa DNA por evento (teamA × teamB) — mesma filosofia do padroes-confronto.
// Janela padrão: 30 dias (720h). Exige mínimo de 10 confrontos.
// ══════════════════════════════════════════════════════════════════════

const EA_BASE = 'https://api.easycoanalytics.com.br';

const _cache = new Map();
function cacheGet(k) { const e = _cache.get(k); return e && Date.now() < e.exp ? e.v : null; }
function cacheSet(k, v, ttl = 90000) { _cache.set(k, { v, exp: Date.now() + ttl }); }

// Piso mínimo por mercado de alta odd
const PISO = {
  '0-0':    5,   // TESTE — voltar para 25
  '5+':     5,   // TESTE — voltar para 15
  'total1': 5,   // TESTE — voltar para 30
  'total2': 5,   // TESTE — voltar para 35
  'total3': 5,   // TESTE — voltar para 25
  'total4': 5,   // TESTE — voltar para 15
};

module.exports = function(db, tabela, ligasCfg, clockOffsetMs = -10800000) {
  return async function(req, res) {
    try {
      const horas      = Math.min(parseInt(req.query.horas)      || 720, 8760);
      const minAmostra = Math.max(parseInt(req.query.min_amostra) || 10,  5);
      const ligaFiltro = req.query.liga || null;

      const cacheKey = `oddsaltas_${tabela}_${horas}_${minAmostra}_${ligaFiltro}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      // valores são inteiros validados ou string sanitizada — interpolação segura
      const ligaWhere = ligaFiltro ? `AND liga = '${ligaFiltro.replace(/'/g, '')}'` : '';

      // ── 1. ESTATÍSTICAS HISTÓRICAS por evento ─────────────────────────
      const sqlStats = `
        SELECT
          liga, team_a, team_b,
          COUNT(*)::int AS total,
          SUM(CASE WHEN gols_total = 0 THEN 1 ELSE 0 END)::int  AS n0,
          SUM(CASE WHEN gols_total = 1 THEN 1 ELSE 0 END)::int  AS n1,
          SUM(CASE WHEN gols_total = 2 THEN 1 ELSE 0 END)::int  AS n2,
          SUM(CASE WHEN gols_total = 3 THEN 1 ELSE 0 END)::int  AS n3,
          SUM(CASE WHEN gols_total = 4 THEN 1 ELSE 0 END)::int  AS n4,
          SUM(CASE WHEN gols_total >= 5 THEN 1 ELSE 0 END)::int AS n5p,
          ROUND(100.0 * SUM(CASE WHEN gols_total = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct0,
          ROUND(100.0 * SUM(CASE WHEN gols_total = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct1,
          ROUND(100.0 * SUM(CASE WHEN gols_total = 2 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct2,
          ROUND(100.0 * SUM(CASE WHEN gols_total = 3 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct3,
          ROUND(100.0 * SUM(CASE WHEN gols_total = 4 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct4,
          ROUND(100.0 * SUM(CASE WHEN gols_total >= 5 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct5p,
          SUM(CASE WHEN ft_a = 0 AND ft_b = 0 THEN 1 ELSE 0 END)::int AS n00,
          ROUND(100.0 * SUM(CASE WHEN ft_a = 0 AND ft_b = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct00,
          ROUND(AVG(gols_total)::numeric, 2) AS media_gols,
          MAX(slot_min) AS slot_recente
        FROM ${tabela}
        WHERE team_a IS NOT NULL
          AND team_b IS NOT NULL
          AND gols_total IS NOT NULL
          AND coletado_em > NOW() - INTERVAL '${horas} hours'
          ${ligaWhere}
        GROUP BY liga, team_a, team_b
        HAVING COUNT(*) >= ${minAmostra}
        ORDER BY liga, team_a, team_b
      `;

      // ── 2. HISTÓRICO CRONOLÓGICO — para streak ─────────────────────────
      const sqlHist = `
        SELECT liga, team_a, team_b, slot_min, gols_total, ft_a, ft_b, start_time
        FROM ${tabela}
        WHERE team_a IS NOT NULL AND team_b IS NOT NULL AND gols_total IS NOT NULL
          AND coletado_em > NOW() - INTERVAL '${horas} hours'
          ${ligaWhere}
        ORDER BY team_a, team_b, start_time ASC
      `;

      const [{ rows: stats }, { rows: historico }] = await Promise.all([
        db.query(sqlStats),
        db.query(sqlHist),
      ]);

      // ── Índice e histórico por evento ──────────────────────────────────
      const idx = new Map();
      for (const r of stats) idx.set(`${r.liga}|${r.team_a}|${r.team_b}`, r);

      const histEvento = new Map();
      for (const r of historico) {
        const key = `${r.liga}|${r.team_a}|${r.team_b}`;
        if (!histEvento.has(key)) histEvento.set(key, []);
        histEvento.get(key).push({ slot: r.slot_min, gols: r.gols_total, sa: r.ft_a, sb: r.ft_b, ts: Number(r.start_time) });
      }

      function calcStreak(jogos, check) {
        let s = 0;
        for (let i = jogos.length - 1; i >= 0; i--) { if (check(jogos[i])) s++; else break; }
        return s;
      }

      // ── 3. Jogos pendentes na EasyCo ──────────────────────────────────
      const ligas    = ligaFiltro ? ligasCfg.filter(l => l.liga === ligaFiltro) : ligasCfg;
      const pendentes = [];
      const agora    = Date.now();
      const janela   = 90 * 60 * 1000;

      await Promise.all(ligas.map(async ({ sub, liga, provider = 'betano' }) => {
        try {
          const url  = `${EA_BASE}/snapshot?provider=${provider}&sub=${sub}&_t=${Date.now()}`;
          const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return;
          const data = await resp.json();
          const jogos = Array.isArray(data) ? data : (data.jogos || data.results || []);
          for (const j of jogos) {
            if (j.status !== 'pendente' && j.status !== 'upcoming') continue;
            const tsRaw = j.startTime || j.start_time || (j.date ? new Date(j.date).getTime() : null);
            if (!tsRaw) continue;
            const ts = tsRaw - 3600000;
            if (ts < agora || ts > agora + janela) continue;
            const teamA = j.teamA || j.team_a;
            const teamB = j.teamB || j.team_b;
            if (!teamA || !teamB) continue;
            let slotMin = j.slotMin ?? j.slot_min ?? null;
            if (slotMin === null && j.date) slotMin = new Date(j.date).getUTCMinutes();
            pendentes.push({ liga, teamA, teamB, slotMin, ts });
          }
        } catch (_) {}
      }));

      // ── 4. Cruza pendentes com histórico ──────────────────────────────
      const previsoes = [];

      for (const jogo of pendentes) {
        const key = `${jogo.liga}|${jogo.teamA}|${jogo.teamB}`;
        const s   = idx.get(key);
        if (!s) continue;

        const jogosHist = histEvento.get(key) || [];
        const minutos   = Math.round((jogo.ts - agora) / 60000);

        const candidatos = [];

        if (parseFloat(s.pct00) >= PISO['0-0'])
          candidatos.push({ mercado: '0-0', pct: parseFloat(s.pct00), n: s.n00,
            streak: calcStreak(jogosHist, j => j.sa == 0 && j.sb == 0),
            icone: '⬛', cor: 'var(--blue)', odd_ref: 11.0 });

        if (parseFloat(s.pct5p) >= PISO['5+'])
          candidatos.push({ mercado: '5+ gols', pct: parseFloat(s.pct5p), n: s.n5p,
            streak: calcStreak(jogosHist, j => j.gols >= 5),
            icone: '💥', cor: 'var(--purple)', odd_ref: 15.0 });

        if (parseFloat(s.pct1) >= PISO['total1'])
          candidatos.push({ mercado: '1 gol', pct: parseFloat(s.pct1), n: s.n1,
            streak: calcStreak(jogosHist, j => j.gols === 1),
            icone: '1️⃣', cor: 'var(--accent)', odd_ref: 2.4 });

        if (parseFloat(s.pct2) >= PISO['total2'])
          candidatos.push({ mercado: '2 gols', pct: parseFloat(s.pct2), n: s.n2,
            streak: calcStreak(jogosHist, j => j.gols === 2),
            icone: '2️⃣', cor: 'var(--accent)', odd_ref: 4.5 });

        if (parseFloat(s.pct3) >= PISO['total3'])
          candidatos.push({ mercado: '3 gols', pct: parseFloat(s.pct3), n: s.n3,
            streak: calcStreak(jogosHist, j => j.gols === 3),
            icone: '3️⃣', cor: 'var(--yellow)', odd_ref: 13.0 });

        if (parseFloat(s.pct4) >= PISO['total4'])
          candidatos.push({ mercado: '4 gols', pct: parseFloat(s.pct4), n: s.n4,
            streak: calcStreak(jogosHist, j => j.gols === 4),
            icone: '4️⃣', cor: 'var(--red)', odd_ref: 50.0 });

        if (!candidatos.length) continue;

        const horaAlvo = new Date(jogo.ts + clockOffsetMs).getUTCHours();

        previsoes.push({
          liga:        jogo.liga,
          team_a:      jogo.teamA,
          team_b:      jogo.teamB,
          slot_min:    jogo.slotMin,
          ts:          jogo.ts,
          hora_alvo:   horaAlvo,
          minutos_ate: minutos,
          total:       s.total,
          media_gols:  parseFloat(s.media_gols),
          candidatos:  candidatos.sort((a, b) => b.pct - a.pct),
          mercado:     candidatos[0].mercado,
          confianca:   candidatos[0].pct,
          streak:      candidatos[0].streak,
        });
      }

      previsoes.sort((a, b) => b.streak - a.streak || b.confianca - a.confianca || a.ts - b.ts);

      const resultado = {
        ok: true,
        total: previsoes.length,
        pendentes_encontrados: pendentes.length,
        eventos_historico: idx.size,
        pendentes_debug: pendentes.slice(0, 5),
        previsoes,
      };
      cacheSet(cacheKey, resultado, 90000);
      res.json(resultado);

    } catch (e) {
      console.error('[odds-altas]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  };
};
