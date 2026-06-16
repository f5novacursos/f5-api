// ════════════════════════════════════════════════════════════════
// MINERADOR DE PADRÕES AO VIVO — compartilhado Betano / Bet365
// 8 geometrias × 3 leituras → previsões: liga, hora alvo, slot alvo,
// probabilidade, amostra, edge. Parametrizado pela tabela.
// Uso: router.get('/padroes-live', require('../lib/padroes-live')(db, 'tabela'))
// ════════════════════════════════════════════════════════════════

function getPatternName(liga, geometria, slot_min, condicao, previsao) {
  const geomCodes = {
    vertical: 'V',
    torre2: 'T2',
    torre3: 'T3',
    horizontal: 'H',
    seq_horiz: 'SH',
    diag_dir: 'DD',
    diag_esq: 'PG', // Pé de Galinha
    cruzamento: 'CR'
  };
  const g = geomCodes[geometria] || 'P';

  const str = `${liga}|${condicao}|${previsao}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const num = Math.abs(hash) % 1000;

  const slotStr = slot_min !== null && slot_min !== undefined && slot_min !== '*' ? `-${String(slot_min).padStart(2, '0')}` : '';
  return `Padrão #${g}${slotStr}-${String(num).padStart(3, '0')}`;
}

module.exports = function (db, tabela) {
  let _liveCache = { key: '', ts: 0, data: null };
  return async (req, res, next) => {
    try {
      const { liga, horas = 168, min_conf = 70, min_amostra = 5, ht_filter = '', gols_filter = '' } = req.query;
      const cacheKey = `${liga || 'all'}|${horas}|${min_conf}|${min_amostra}|${ht_filter}|${gols_filter}`;
      if (_liveCache.key === cacheKey && Date.now() - _liveCache.ts < 60000) {
        return res.json(_liveCache.data);
      }

      let r;
      if (Number(horas) === 0) {
        const params = liga ? [liga] : [];
        const ligaFilter = liga ? 'WHERE liga = $1' : '';
        r = await db.query(`
          SELECT liga, hora, slot_min, ft_str, ht_str, gols_total, is_btts, start_time,
                 DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
          FROM ${tabela}
          ${ligaFilter}
          ORDER BY liga, start_time ASC
        `, params);
      } else {
        const cutoffMs = Date.now() - Number(horas) * 3600000;
        const params = liga ? [cutoffMs, liga] : [cutoffMs];
        const ligaFilter = liga ? 'AND liga = $2' : '';
        r = await db.query(`
          SELECT liga, hora, slot_min, ft_str, ht_str, gols_total, is_btts, start_time,
                 DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
          FROM ${tabela}
          WHERE start_time > $1 ${ligaFilter}
          ORDER BY liga, start_time ASC
        `, params);
      }

      if (r.rows.length < 50) {
        return res.json({ ok: true, total: 0, previsoes: [], aviso: 'Dados insuficientes' });
      }

      const HORA_MS = 3600000;

      // ── TEMPERATURA DA HORA: detecta se hora atual é fria ou quente ──
      const agoraTempMs = Date.now();
      const jogosUltimaHora = r.rows.filter(j => {
        const ts = Number(j.start_time);
        return ts >= agoraTempMs - HORA_MS && ts < agoraTempMs;
      });
      let hora_temp = null;
      if (jogosUltimaHora.length >= 5) {
        const unders = jogosUltimaHora.filter(j => Number(j.gols_total) <= 2).length;
        const overs  = jogosUltimaHora.filter(j => Number(j.gols_total) >= 3).length;
        const total  = jogosUltimaHora.length;
        const pUnder = unders / total;
        const pOver  = overs  / total;
        if (pUnder >= 0.6)      hora_temp = { tipo: 'fria',   pct: Math.round(pUnder * 100), jogos: total };
        else if (pOver >= 0.65) hora_temp = { tipo: 'quente', pct: Math.round(pOver  * 100), jogos: total };
      }
      const agora = Date.now();
      const consecutivo = (a, b) => { const d = b - a; return d > HORA_MS * 0.5 && d < HORA_MS * 1.5; };

      const MARKETS = {
        '0-0':       g => g.gols_total === 0,
        'OVER 1.5':  g => g.gols_total >= 2,
        'UNDER 1.5': g => g.gols_total <= 1,
        'OVER 2.5':  g => g.gols_total >= 3,
        'UNDER 2.5': g => g.gols_total <= 2,
        'OVER 3.5':  g => g.gols_total >= 4,
        'AMBAS SIM': g => g.is_btts,
      };

      const CONTRADITORIOS = {
        'OVER 1.5':  ['UNDER 1.5'],
        'UNDER 1.5': ['OVER 1.5', 'OVER 2.5', 'OVER 3.5', 'AMBAS SIM'],
        'OVER 2.5':  ['UNDER 1.5', 'UNDER 2.5', '0-0'],
        'UNDER 2.5': ['OVER 2.5', 'OVER 3.5'],
        'OVER 3.5':  ['UNDER 1.5', 'UNDER 2.5'],
        '0-0':       ['OVER 2.5', 'OVER 3.5', 'OVER 1.5', 'AMBAS SIM'],
        'AMBAS SIM': ['UNDER 1.5', '0-0'],
      };

      const CONDS = {
        placar: g => g.ft_str,
        gols:   g => `${g.gols_total} GOL`,
        ou:     g => (g.gols_total >= 3 ? 'OVER 2.5' : 'UNDER 2.5'),
      };

      // ── VALIDAÇÃO DB — análise semanal (19.845 jogos Betano) ──
      // Atualizado em: 15/06/2026. Renovar toda segunda-feira.
      const DB_PADROES = [
        { ht: '0-0', prev: 'UNDER 2.5', pct: 88.5, jogos: 6068 },
        { ht: '0-0', prev: 'UNDER 1.5', pct: 68.5, jogos: 6068 },
        { ht: '1-1', prev: 'OVER 1.5',  pct: 100,  jogos: 2068 },
        { ht: '1-1', prev: 'AMBAS SIM', pct: 100,  jogos: 2068 },
        { ht: '1-0', prev: 'OVER 1.5',  pct: 69.2, jogos: 3658 },
        { ht: '0-1', prev: 'OVER 1.5',  pct: 70.3, jogos: 3426 },
      ];
      const getDbVal = (htStr, prev) => {
        const m = DB_PADROES.find(p => p.ht === htStr && p.prev === prev);
        return m ? { db_validado: true, db_nota: `HT ${m.ht} → ${m.prev} ${m.pct}% (${m.jogos.toLocaleString('pt-BR')}j DB)` } : { db_validado: false, db_nota: null };
      };

      // monta linhas (liga|dia|hora) e células por slot
      const linhaMap = {};
      for (const j of r.rows) {
        const k = `${j.liga}|${j.dia}|${j.hora}`;
        if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), cells: {} };
        if (Number(j.start_time) < linhaMap[k].ts) linhaMap[k].ts = Number(j.start_time);
        linhaMap[k].cells[j.slot_min] = j;
      }
      const ligaLinhas = {};
      for (const v of Object.values(linhaMap)) {
        (ligaLinhas[v.liga] = ligaLinhas[v.liga] || []).push(v);
      }
      for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

      const previsoes = [];

      for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
        const slotList = [...new Set(linhas.flatMap(l => Object.keys(l.cells).map(Number)))].sort((a, b) => a - b);

        // taxa base por mercado
        const baseN = {}; let baseT = 0;
        for (const l of linhas) for (const s in l.cells) {
          const g = l.cells[s]; baseT++;
          for (const [m, fn] of Object.entries(MARKETS)) if (fn(g)) baseN[m] = (baseN[m] || 0) + 1;
        }
        const base = m => baseT ? Math.round((baseN[m] || 0) / baseT * 100) : 0;

        const baseN2 = {}, baseN3 = {}; let baseT2 = 0, baseT3 = 0;
        for (const l of linhas) {
          const seq = slotList.map(s => l.cells[s]).filter(Boolean);
          for (let i = 0; i + 1 < seq.length; i++) {
            baseT2++;
            for (const [m, fn] of Object.entries(MARKETS)) if (fn(seq[i]) || fn(seq[i + 1])) baseN2[m] = (baseN2[m] || 0) + 1;
          }
          for (let i = 0; i + 2 < seq.length; i++) {
            baseT3++;
            for (const [m, fn] of Object.entries(MARKETS)) if (fn(seq[i]) || fn(seq[i + 1]) || fn(seq[i + 2])) baseN3[m] = (baseN3[m] || 0) + 1;
          }
        }
        const base2 = m => baseT2 ? Math.round((baseN2[m] || 0) / baseT2 * 100) : 0;
        const base3 = m => baseT3 ? Math.round((baseN3[m] || 0) / baseT3 * 100) : 0;

        const cell = (li, si) => {
          if (li < 0 || li >= linhas.length || si < 0 || si >= slotList.length) return null;
          return linhas[li].cells[slotList[si]] || null;
        };
        const consecLinhas = (a, b) => a >= 0 && b < linhas.length && consecutivo(linhas[a].ts, linhas[b].ts);

        const GEOMS = {
          vertical:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si }),         check: li => true },
          torre2:     { cond: (li, si) => [cell(li - 1, si), cell(li, si)],                      alvo: (li, si) => ({ li: li + 1, si }),         check: li => consecLinhas(li - 1, li) },
          torre3:     { cond: (li, si) => [cell(li - 2, si), cell(li - 1, si), cell(li, si)],    alvo: (li, si) => ({ li: li + 1, si }),         check: li => consecLinhas(li - 2, li - 1) && consecLinhas(li - 1, li) },
          horizontal: { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li, si: si + 1 }),         check: li => true },
          seq_horiz:  { cond: (li, si) => [cell(li, si - 1), cell(li, si)],                      alvo: (li, si) => ({ li, si: si + 1 }),         check: li => true },
          diag_dir:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si: si + 1 }), check: li => true },
          diag_esq:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si: si - 1 }), check: li => true },
          cruzamento: { cond: (li, si) => [cell(li, si - 1), cell(li, si + 1)],                  alvo: (li, si) => ({ li: li + 1, si }),         check: li => true },
        };

        const condPassaFiltro = (condCells) => {
          if (!ht_filter && !gols_filter) return true;
          const last = condCells[condCells.length - 1];
          if (ht_filter && last.ht_str !== ht_filter) return false;
          if (gols_filter !== '' && Number(last.gols_total) !== Number(gols_filter)) return false;
          return true;
        };

        const acc = {};
        for (let li = 0; li < linhas.length; li++) {
          for (let si = 0; si < slotList.length; si++) {
            for (const [gName, G] of Object.entries(GEOMS)) {
              if (!G.check(li)) continue;
              const condCells = G.cond(li, si);
              if (condCells.some(c => !c)) continue;
              if (!condPassaFiltro(condCells)) continue;
              const ap = G.alvo(li, si);
              if (ap.li !== li && !consecLinhas(li, ap.li)) continue;
              const t1 = cell(ap.li, ap.si);
              if (!t1) continue;
              const t2 = cell(ap.li, ap.si + 1);
              const t3 = cell(ap.li, ap.si + 2);
              for (const [dim, fn] of Object.entries(CONDS)) {
                const condKey = condCells.map(fn).join(',');
                for (const key of [`${gName}|${dim}|${slotList[si]}|${condKey}`, `${gName}|${dim}|*|${condKey}`]) {
                  if (!acc[key]) acc[key] = { total: 0, out: {}, total2: 0, out2: {}, total3: 0, out3: {} };
                  acc[key].total++;
                  if (t2) acc[key].total2++;
                  if (t2 && t3) acc[key].total3++;
                  for (const [m, mfn] of Object.entries(MARKETS)) {
                    const h1 = mfn(t1);
                    if (h1) acc[key].out[m] = (acc[key].out[m] || 0) + 1;
                    if (t2 && (h1 || mfn(t2))) acc[key].out2[m] = (acc[key].out2[m] || 0) + 1;
                    if (t2 && t3 && (h1 || mfn(t2) || mfn(t3))) acc[key].out3[m] = (acc[key].out3[m] || 0) + 1;
                  }
                }
              }
            }
          }
        }

        for (let li = Math.max(0, linhas.length - 2); li < linhas.length; li++) {
          for (let si = 0; si < slotList.length; si++) {
            for (const [gName, G] of Object.entries(GEOMS)) {
              if (!G.check(li)) continue;
              const condCells = G.cond(li, si);
              if (condCells.some(c => !c)) continue;
              if (!condPassaFiltro(condCells)) continue;
              const ap = G.alvo(li, si);

              // Wrap-around de si caso saia dos limites da hora
              let alvoLi = ap.li;
              let alvoSi = ap.si;
              if (alvoSi >= slotList.length) {
                alvoSi = alvoSi - slotList.length;
                alvoLi++;
              } else if (alvoSi < 0) {
                alvoSi = slotList.length + alvoSi;
                alvoLi--;
              }
              if (alvoLi < 0) continue;

              // Se o jogo alvo exato já existe na tabela de dados loaded, pula (está no passado)
              const targetExistente = cell(alvoLi, alvoSi);
              if (targetExistente) continue;

              const lastCell = condCells[condCells.length - 1];
              const condTs = Number(lastCell.start_time);
              const diffHours = alvoLi - li;
              const alvoHora = (linhas[li].hora + diffHours + 24) % 24;
              const alvoTs = condTs + diffHours * HORA_MS + (slotList[alvoSi] - lastCell.slot_min) * 60000;

              // Coleta os 3 tiros (Martingale) contínuos cruzando viradas de hora
              const tent = [];
              let tLi = alvoLi;
              let tSi = alvoSi;
              let hasGap = false;
              for (let t = 0; t < 3; t++) {
                if (tSi >= slotList.length) {
                  const nextTLi = tLi + 1;
                  if (nextTLi < linhas.length && !consecLinhas(tLi, nextTLi)) {
                    hasGap = true;
                    break;
                  }
                  tSi = 0;
                  tLi = nextTLi;
                }
                const tDiffHours = tLi - li;
                const tHora = (linhas[li].hora + tDiffHours + 24) % 24;
                const tSlotMin = slotList[tSi];
                const tTs = condTs + tDiffHours * HORA_MS + (tSlotMin - lastCell.slot_min) * 60000;

                tent.push({
                  hora: tHora,
                  slot_min: tSlotMin,
                  ts: tTs
                });
                tSi++;
              }
              if (hasGap) continue;

              const lastStepTs = tent[tent.length - 1].ts;
              // Mantém o padrão ativo até 5 minutos após o último tiro da sequência terminar
              if (lastStepTs < agora - 5 * 60000) continue;
              // Não exibe padrões que começam muito longe no futuro
              if (alvoTs > agora + 75 * 60000) continue;

              for (const [dim, fn] of Object.entries(CONDS)) {
                const condKey = condCells.map(fn).join(',');
                let st = acc[`${gName}|${dim}|${slotList[si]}|${condKey}`];
                let slotEspecifico = true;
                if (!st || st.total3 < Number(min_amostra)) {
                  st = acc[`${gName}|${dim}|*|${condKey}`];
                  slotEspecifico = false;
                }
                if (!st || st.total3 < Number(min_amostra)) continue;

                let best = null;
                for (const m of Object.keys(MARKETS)) {
                  const c1 = st.total  ? Math.round((st.out[m]  || 0) / st.total  * 100) : 0;
                  const c2 = st.total2 ? Math.round((st.out2[m] || 0) / st.total2 * 100) : 0;
                  const c3 = st.total3 ? Math.round((st.out3[m] || 0) / st.total3 * 100) : 0;
                  if (c3 < Number(min_conf)) continue;
                  const e3 = c3 - base3(m);
                  if (e3 <= 0) continue;
                  if (!best || e3 > best.e3 || (e3 === best.e3 && c3 > best.c3)) best = { m, c1, c2, c3, e3 };
                }
                if (!best) continue;

                // ── AVALIAÇÃO DO CICLO DE VIDA DO MARTINGALE ──
                let status = 'aguardando';
                let currentTiro = 1;
                let hit = false;
                let allFinished = true;
                const tirosResultados = [];

                for (let i = 0; i < tent.length; i++) {
                  const step = tent[i];
                  const stepDate = new Date(step.ts);
                  const stepDia = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(stepDate);
                  const k = `${ligaKey}|${stepDia}|${step.hora}`;
                  const cellData = linhaMap[k] && linhaMap[k].cells[step.slot_min];

                  if (cellData) {
                    const isHit = MARKETS[best.m](cellData);
                    tirosResultados.push({
                      slot_min: step.slot_min,
                      ft: cellData.ft_str,
                      isHit: isHit
                    });
                    if (isHit) {
                      hit = true;
                      status = 'green';
                      break; // Pára avaliação nos tiros seguintes caso já tenha batido green
                    }
                  } else {
                    allFinished = false;
                    tirosResultados.push({
                      slot_min: step.slot_min,
                      ft: null,
                      isHit: null
                    });
                  }
                }

                if (!hit) {
                  if (allFinished) {
                    status = 'red';
                  } else {
                    const idx = tirosResultados.findIndex(t => t.ft === null);
                    currentTiro = idx !== -1 ? idx + 1 : 1;
                    status = idx > 0 ? 'jogando' : 'aguardando';
                  }
                }

                const patternName = getPatternName(ligaKey, gName, slotList[si], condKey, best.m);
                const lastHt = condCells[condCells.length - 1].ht_str;
                const dbVal = getDbVal(lastHt, best.m);

                previsoes.push({
                  id: patternName.replace(/\W/g, '_'),
                  nome: patternName,
                  liga: ligaKey,
                  geometria: gName,
                  dimensao: dim,
                  condicao: condCells.map(c => ({ hora: c.hora, slot_min: c.slot_min, ft: c.ft_str, leitura: fn(c) })),
                  alvo: { hora: alvoHora, slot_min: slotList[alvoSi], ts: alvoTs },
                  tentativas: tent.map(t => t.slot_min),
                  tentativas_detalhes: tent,
                  previsao: best.m,
                  prob: best.c1,
                  prob2: best.c2,
                  prob3: best.c3,
                  amostra: st.total,
                  amostra3: st.total3,
                  acertos: st.out[best.m] || 0,
                  acertos3: st.out3[best.m] || 0,
                  base_rate: base(best.m),
                  base2: base2(best.m),
                  base3: base3(best.m),
                  edge: best.c1 - base(best.m),
                  edge3: best.e3,
                  slot_especifico: slotEspecifico,
                  status: status,
                  current_tiro: currentTiro,
                  tiros_resultados: tirosResultados,
                  db_validado: dbVal.db_validado,
                  db_nota: dbVal.db_nota
                });
              }
            }
          }
        }
      }

      // ── DEDUPLICAÇÃO: 1 card por alvo da mesma liga (liga + alvo.ts) ──
      const byKey = {};
      const melhorQue = (a, b) => a.prob3 !== b.prob3 ? a.prob3 > b.prob3 : (a.edge3 !== b.edge3 ? a.edge3 > b.edge3 : a.amostra3 > b.amostra3);
      for (const p of previsoes) {
        const k = `${p.liga}|${p.alvo.ts}`;
        if (!byKey[k] || melhorQue(p, byKey[k])) byKey[k] = p;
      }

      // ── ANTI-CONTRADIÇÃO E FILTRO DE OCUPAÇÃO GLOBAL ──
      // Ordena do mais forte ao mais fraco.
      // Se qualquer jogo da sequência de martingale já está reservado por uma previsão mais forte,
      // a previsão atual é descartada para evitar qualquer sobreposição.
      const ordenados = Object.values(byKey)
        .sort((a, b) => (b.prob3 - a.prob3) || (b.edge3 - a.edge3) || (b.amostra3 - a.amostra3));

      const ocupados = new Set();
      const final = [];

      for (const p of ordenados) {
        const tentKeys = p.tentativas_detalhes.map(t => `${p.liga}|${t.ts}`);

        // Algum jogo na sequência do Martingale já está ocupado?
        if (tentKeys.some(key => ocupados.has(key))) continue;

        // Ocupa todos os jogos desta sequência
        tentKeys.forEach(key => ocupados.add(key));
        
        final.push(p);
        if (final.length >= 80) break;
      }

      const payload = { ok: true, total: final.length, horas: Number(horas), gerado_em: new Date().toISOString(), hora_temp, previsoes: final };
      _liveCache = { key: cacheKey, ts: Date.now(), data: payload };
      res.json(payload);
    } catch (e) { next(e); }
  };
};
