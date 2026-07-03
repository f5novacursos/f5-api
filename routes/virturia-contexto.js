// ══════════════════════════════════════════════════════════════════
// routes/virturia-contexto.js — Engine de Adjacência da Matrix
// "Quando saiu X numa célula, o que saiu ACIMA dela (próxima hora,
//  mesmo slot) historicamente?"  — minera os 20k+ jogos.
//
// A célula "acima" é encontrada pelo TEMPO REAL entre jogos (~60min),
// então funciona igual para Betano e Bet365 (sem bug de timezone).
// ══════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.VIRTURIA_JWT_SECRET || process.env.VIRTURIA_CHAVE || 'virturia2026secret';

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Token ausente' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Token inválido' }); }
}

const MIN_GAP = 50 * 60 * 1000;   // 50 min
const MAX_GAP = 70 * 60 * 1000;   // 70 min

// Estatística de mercados da célula ACIMA (Under/Over 2.5 e Ambas Sim)
function novoStat() { return { n:0, under:0, over:0, over15:0, ambas:0 }; }
function acumulaStat(s, a, b) {
  s.n++;
  const g = a + b;
  if (g <= 2) s.under++;
  if (g >= 3) s.over++;
  if (g >= 2) s.over15++;
  if (a > 0 && b > 0) s.ambas++;
}
// Mercado PURO por aba (26/06/2026): OVER 1.5 (≥2 gols, base ~68%) e UNDER 2.5 (≤2 gols, ~58%)
// viram ABAS SEPARADAS — o usuário joga um mercado puro por vez. Mercado puro corta os blocos de
// erro pela metade: o MIX dobrava a exposição (hora quente mata under, fria mata over → sempre
// tem mercado morrendo). OVER 2.5/AMBAS (~42/47%) são moeda e ficam fora. RNG → gatilho não prevê,
// o pct só serve pra ranquear/passar o piso. Ver reference_virtual_rng_sem_padrao.
const MERCADOS_ABA = ['OVER 1.5', 'UNDER 2.5'];
function melhorMercado(s, mercado) {
  if (mercado === 'UNDER 2.5') return { m:'UNDER 2.5', p: Math.round(s.under*100/s.n) };
  return { m:'OVER 1.5', p: Math.round(s.over15*100/s.n) };
}

// Deriva os mercados de um resultado
function mercadosDe(ftA, ftB) {
  const a = parseInt(ftA), b = parseInt(ftB), g = a + b;
  const m = [];
  m.push(g >= 3 ? 'OVER 2.5' : 'UNDER 2.5');
  m.push(g >= 2 ? 'OVER 1.5' : 'UNDER 1.5');
  m.push(a > 0 && b > 0 ? 'AMBAS SIM' : 'AMBAS NÃO');
  if (g === 0) m.push('0-0');
  if (g >= 4) m.push('OVER 3.5');
  return m;
}

// ── Cache de porLiga (55s TTL) — evita varreduras simultâneas no banco
// O snapshotHora (60s) e /melhores-entradas concorrentes usavam a mesma
// query pesada em paralelo, causando timeout no segundo request.
const _porLigaCache = {};
const _porLigaTs    = {};
const CACHE_TTL     = 55 * 1000;

// ── Helpers compartilhados da engine de adjacência ──────────────────
async function carregarPorLigaSlot(db, tabela, horas) {
  const key = `${tabela}|${horas}`;
  const now = Date.now();
  if (_porLigaCache[key] && now - _porLigaTs[key] < CACHE_TTL) return _porLigaCache[key];
  const cutoff = now - horas * 3600000;
  const { rows } = await db.query(`
    SELECT liga, slot_min, ft_a, ft_b, ft_str, start_time
    FROM ${tabela}
    WHERE start_time > $1
    ORDER BY liga, slot_min, start_time ASC
  `, [cutoff]);
  const porLiga = {};
  for (const r of rows) {
    const lg = r.liga, slot = parseInt(r.slot_min);
    (porLiga[lg] = porLiga[lg] || {});
    (porLiga[lg][slot] = porLiga[lg][slot] || []).push({
      ts: Number(r.start_time), ft: r.ft_str,
      a: parseInt(r.ft_a), b: parseInt(r.ft_b)
    });
  }
  _porLigaCache[key] = porLiga;
  _porLigaTs[key]    = now;
  return porLiga;
}

function calcStats(slots) {
  const stat1 = {}, stat2 = {};
  for (const slot in slots) {
    const arr = slots[slot];
    for (let i = 0; i < arr.length - 1; i++) {
      const gap = arr[i+1].ts - arr[i].ts;
      if (gap < MIN_GAP || gap > MAX_GAP) continue;
      const k1 = slot + '|' + arr[i].ft;
      (stat1[k1] = stat1[k1] || novoStat());
      acumulaStat(stat1[k1], arr[i+1].a, arr[i+1].b);
      if (i >= 1) {
        const gapPrev = arr[i].ts - arr[i-1].ts;
        if (gapPrev >= MIN_GAP && gapPrev <= MAX_GAP) {
          const k2 = slot + '||' + arr[i-1].ft + '>' + arr[i].ft;
          (stat2[k2] = stat2[k2] || novoStat());
          acumulaStat(stat2[k2], arr[i+1].a, arr[i+1].b);
        }
      }
    }
  }
  return { stat1, stat2 };
}

// Gera a entrada de um slot a partir do gatilho no índice idxGat (e o anterior p/ seq-2)
function entradaDoSlot(slot, arr, idxGat, stat1, stat2, clockOffsetMs, minAmostra, minConf, mercado) {
  const ult = arr[idxGat];
  const horaAlvo = (new Date(ult.ts + clockOffsetMs).getUTCHours() + 1) % 24;
  const opcoes = [];
  const s1 = stat1[slot + '|' + ult.ft];
  if (s1 && s1.n >= minAmostra) {
    const b = melhorMercado(s1, mercado);
    opcoes.push({ tipo:'seq1', gatilho: ult.ft, mercado: b.m, pct: b.p, amostra: s1.n });
  }
  if (idxGat >= 1) {
    const pen = arr[idxGat - 1];
    if (ult.ts - pen.ts >= MIN_GAP && ult.ts - pen.ts <= MAX_GAP) {
      const s2 = stat2[slot + '||' + pen.ft + '>' + ult.ft];
      if (s2 && s2.n >= minAmostra) {
        const b = melhorMercado(s2, mercado);
        opcoes.push({ tipo:'seq2', gatilho: pen.ft + '>' + ult.ft, mercado: b.m, pct: b.p, amostra: s2.n });
      }
    }
  }
  if (!opcoes.length) return null;
  opcoes.sort((a, b) => b.pct - a.pct || b.amostra - a.amostra);
  const win = opcoes[0];
  if (win.pct < minConf) return null;
  return { slot:+slot, gatilho: win.gatilho, tipo: win.tipo, mercado: win.mercado, pct: win.pct, amostra: win.amostra, hora_alvo: horaAlvo };
}

// Calcula as entradas por liga (top N por confiança, em ordem de slot).
// Se gatilhoHora != null, o gatilho de cada slot é o jogo daquela hora local
// (e data, se gatilhoData != null) — foto fiel, independe do minuto e permite
// reconstruir qualquer hora passada. Sem gatilhoHora: usa o último jogo (live).
function calcularEntradas(porLiga, clockOffsetMs, { topN, minAmostra, minConf, gatilhoHora = null, gatilhoData = null, mercado = 'OVER 1.5' }) {
  const out = {};
  for (const lg in porLiga) {
    const slots = porLiga[lg];
    const grid = Object.keys(slots).map(Number).sort((a, b) => a - b);
    const { stat1, stat2 } = calcStats(slots);
    const cands = [];
    for (const slot in slots) {
      const arr = slots[slot];
      let idxGat = arr.length - 1;
      if (gatilhoHora != null) {
        idxGat = -1;
        for (let i = arr.length - 1; i >= 0; i--) {
          const d = new Date(arr[i].ts + clockOffsetMs);
          if (d.getUTCHours() === gatilhoHora &&
              (gatilhoData == null || d.toISOString().slice(0, 10) === gatilhoData)) { idxGat = i; break; }
        }
        if (idxGat < 0) continue;
      }
      const e = entradaDoSlot(slot, arr, idxGat, stat1, stat2, clockOffsetMs, minAmostra, minConf, mercado);
      // piso por mercado aplicado SOBRE a confiança já ajustada pela força da coluna
      if (e) { aplicarForcaColuna(e, slots, grid); if (e.pct >= pisoDe(e.mercado, minConf, lg)) cands.push(e); }
    }
    // dedupe Martingale: a entrada mais cedo ANCORA e CONSOME os 2 slots seguintes
    // (as 3 colunas do tiro: S, S+1, S+2) de QUALQUER mercado. Uma vez que 04' ancora
    // (cobre 04/07/10), nenhuma outra entrada da liga pode ocupar 07' nem 10' — seria
    // contradição (ex: 04' OVER e 10' UNDER cairiam na mesma coluna 10 do martingale).
    const cobertos = new Set();
    const ancoras = [];
    for (const c of cands.slice().sort((a, b) => a.slot - b.slot)) {
      if (cobertos.has(c.slot)) continue;
      ancoras.push(c);
      const gi = grid.indexOf(c.slot);
      for (let k = 1; k <= 2; k++) if (grid[gi + k] != null) cobertos.add(grid[gi + k]);
    }
    // top N por confiança, exibido em ordem de slot
    ancoras.sort((a, b) => b.pct - a.pct || b.amostra - a.amostra);
    out[lg] = ancoras.slice(0, topN).sort((a, b) => a.slot - b.slot);
  }
  return out;
}

function mercadoBateu(mercado, a, b) {
  const g = a + b;
  if (mercado === 'UNDER 2.5') return g <= 2;
  if (mercado === 'UNDER 1.5') return g <= 1;
  if (mercado === 'OVER 1.5')  return g >= 2;
  if (mercado === 'OVER 2.5')  return g >= 3;
  return a > 0 && b > 0; // AMBAS SIM
}

// ── Força da coluna (reforço Martingale) ────────────────────────────
// Espelha a "Análise do Range" da Matrix (index.html → colStats/updateFloatCard):
// mede quão VERDE pro mercado da entrada estão as 3 colunas onde o Martingale joga
// (slot S + os 2 seguintes), agrupando as células (pooled), e usa a base do mercado
// na liga como régua justa (Under/Over/Ambas têm taxas-base bem diferentes).
// Coluna FRIA (abaixo da base) DERRUBA a confiança; coluna saudável não mexe nada
// (penalidade só negativa) → o filtro só remove entrada arriscada, nunca promove fraca.
const PESO_COLUNA = 0.6;       // pts de confiança descontados por pt de frieza vs base
const MIN_AMOSTRA_COL = 8;     // mín. de células nas 3 colunas p/ confiar na força

function aplicarForcaColuna(e, slots, grid) {
  const gi = grid.indexOf(e.slot);
  if (gi < 0) return;
  let hit = 0, tot = 0;                          // 3 colunas do Martingale (pooled)
  for (let k = 0; k < 3; k++) {
    const c = grid[gi + k];
    if (c == null) continue;
    for (const j of (slots[c] || [])) { tot++; if (mercadoBateu(e.mercado, j.a, j.b)) hit++; }
  }
  let bh = 0, bt = 0;                            // base do mercado na liga inteira
  for (const sk in slots) for (const j of slots[sk]) { bt++; if (mercadoBateu(e.mercado, j.a, j.b)) bh++; }
  e.forca       = tot ? Math.round(hit * 100 / tot) : null;
  e.amostra_col = tot;
  e.base        = bt ? Math.round(bh * 100 / bt) : null;
  if (e.forca != null && e.base != null && tot >= MIN_AMOSTRA_COL) {
    const saude = Math.min(0, e.forca - e.base); // só frieza penaliza
    e.pct = Math.max(0, Math.round(e.pct + saude * PESO_COLUNA));
  }
}

// ── Piso de confiança por mercado ───────────────────────────────────
// AMBAS SIM tem base estrutural ~47% em todas as ligas (quase moeda). Com Martingale
// 3 tiros o acerto vira 1-0.53^3 ≈ 85% SÓ pela taxa-base — a adjacência não prevê
// AMBAS (o acerto real do robô, 84-87%, bate exatamente esse chão). No histórico, AMBAS
// só fica limpo (100%) em pct>=80; abaixo disso sangra (~83-88%). Então exige barra alta:
// joga só as melhores AMBAS. UNDER (base 58%) e OVER (base 41%) têm edge real → piso global.
const PISO_MERCADO = { 'AMBAS SIM': 80 };

// Piso por liga+mercado — sobrepõe PISO_MERCADO quando mais restritivo.
// Calibrado em 25/06/2026 com 7 dias de histórico real (3966 entradas conferidas):
//
//  OVER 2.5 estruturalmente fraco (adjacência não prevê bem):
//    premier_league  → 59% geral; sem entradas >=75 → VETADO
//    copa_america    → 76% geral; piora em >=75 (67%) → VETADO
//    euro_cup        → 73% geral; piora em >=75 (60%) → VETADO
//    copa_mundo      → 73% geral; edge marginal → piso 75
//    copa_estrelas   → 73% geral, mas >=70 vira 100% (6 casos) → piso 70
//    sul_americana   → 78% geral, mas >=70 melhora (89%) → piso 70
//
//  AMBAS SIM sem edge de adjacência em certas ligas:
//    brasileirao     → 65% geral; piso 80 piora (60%) → VETADO
//    premier_league  → 75% geral; sem entradas >=80 → VETADO
//    sul_americana   → 71% geral; sem entradas >=80 → VETADO
//
//  O que acerta bem e NÃO é alterado:
//    UNDER 2.5 em todas as ligas (92–98%) — piso global mantido
//    express_cup|UNDER 2.5 → 98% (831 entradas)
//    copa_mundo|AMBAS SIM  → 96%
//    euro|OVER 2.5 >=70    → 100% (piso 70 já cobre)
const PISO_LIGA_MERCADO = {
  'premier_league|OVER 2.5':  999, // VETADO — 59%
  'copa_america|OVER 2.5':    999, // VETADO — 76%, piora com piso
  'euro_cup|OVER 2.5':        999, // VETADO — 73%, piora com piso
  'copa_mundo|OVER 2.5':       75, // edge marginal
  'copa_estrelas|OVER 2.5':    70, // >=70 vira 100%
  'sul_americana|OVER 2.5':    70, // >=70 melhora (89%)
  'brasileirao|AMBAS SIM':    999, // VETADO — 65%, piso 80 piora
  'premier_league|AMBAS SIM': 999, // VETADO — 75%
  'sul_americana|AMBAS SIM':  999, // VETADO — 71%
};

function pisoDe(mercado, minConf, liga) {
  const chave = liga ? `${liga}|${mercado}` : null;
  const pisoLiga = chave ? (PISO_LIGA_MERCADO[chave] ?? 0) : 0;
  return Math.max(minConf, PISO_MERCADO[mercado] || 0, pisoLiga);
}

// ── Snapshot da aba Especial (trava AO VIVO + histórico de acerto) ──
// Foto canônica: histórico 720h, top 6/liga, conf>=60, amostra>=8.
const SNAP_HORAS = 720, SNAP_TOP = 6, SNAP_CONF = 60, SNAP_AMOSTRA = 8;
let _snapTableReady = null;
function initSnapTable(db) {
  if (_snapTableReady) return _snapTableReady;
  _snapTableReady = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS virturia_especial_snapshot (
        id           SERIAL PRIMARY KEY,
        provedor     VARCHAR(10) NOT NULL,
        data         VARCHAR(10) NOT NULL,
        hora_alvo    INTEGER NOT NULL,
        liga         VARCHAR(40) NOT NULL,
        slot         INTEGER NOT NULL,
        gatilho      VARCHAR(20),
        tipo         VARCHAR(6),
        mercado      VARCHAR(12) NOT NULL,
        pct          INTEGER NOT NULL,
        amostra      INTEGER NOT NULL,
        resultado    VARCHAR(16),
        acerto       BOOLEAN,
        metodo       VARCHAR(8),
        criado_em    TIMESTAMP DEFAULT NOW(),
        conferido_em TIMESTAMP,
        UNIQUE(provedor, data, hora_alvo, liga, slot)
      )
    `);
    // migrações idempotentes (tabela pode já existir da versão anterior)
    await db.query(`ALTER TABLE virturia_especial_snapshot ADD COLUMN IF NOT EXISTS metodo VARCHAR(8)`);
    await db.query(`ALTER TABLE virturia_especial_snapshot ALTER COLUMN resultado TYPE VARCHAR(16)`);
    await db.query(`ALTER TABLE virturia_especial_snapshot ADD COLUMN IF NOT EXISTS origem VARCHAR(5)`);
    await db.query(`ALTER TABLE virturia_especial_snapshot ADD COLUMN IF NOT EXISTS forca INTEGER`);
    // migração 26/06/2026: UNIQUE passa a incluir `mercado` — as abas OVER 1.5 e UNDER 2.5
    // gravam os DOIS mercados no mesmo slot (cada um com sua trava e histórico). Dropa a
    // UNIQUE antiga (sem mercado) e cria a nova. Idempotente.
    await db.query(`
      DO $$
      DECLARE c text;
      BEGIN
        FOR c IN SELECT conname FROM pg_constraint
                 WHERE conrelid='virturia_especial_snapshot'::regclass AND contype='u'
                   AND conname <> 'ues_uq_merc'
        LOOP EXECUTE 'ALTER TABLE virturia_especial_snapshot DROP CONSTRAINT '||quote_ident(c); END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='virturia_especial_snapshot'::regclass AND conname='ues_uq_merc') THEN
          ALTER TABLE virturia_especial_snapshot ADD CONSTRAINT ues_uq_merc UNIQUE(provedor, data, hora_alvo, liga, slot, mercado);
        END IF;
      END $$;
    `);
  })().catch(e => { _snapTableReady = null; throw e; });
  return _snapTableReady;
}

// Data/hora local do provedor a partir de um timestamp
function dataHoraProvedor(ts, clockOffsetMs) {
  const d = new Date(ts + clockOffsetMs);
  return { data: d.toISOString().slice(0, 10), hora: d.getUTCHours() };
}

// Grava a foto de UMA hora-alvo (atual ou passada). Só a 1ª escrita vale (trava).
// porLigaCache: reaproveita a carga do banco quando chamado em lote (backfill).
async function gravarFotoHora(db, tabela, clockOffsetMs, provedor, alvoData, alvoHora, porLigaCache, origem = 'vivo') {
  // gatilho = hora anterior (a célula de baixo); vira o dia se alvo for 0h
  const gatilhoHora = (alvoHora + 23) % 24;
  let gatilhoData = alvoData;
  if (alvoHora === 0) {
    const d = new Date(alvoData + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    gatilhoData = d.toISOString().slice(0, 10);
  }
  const porLiga = porLigaCache || await carregarPorLigaSlot(db, tabela, SNAP_HORAS);
  let n = 0;
  // grava os DOIS mercados (abas OVER 1.5 e UNDER 2.5), cada um com sua trava independente
  for (const mercado of MERCADOS_ABA) {
    // trava por mercado: OVER e UNDER têm fotos separadas — salvar um não bloqueia o outro
    const { rows: ex } = await db.query(
      `SELECT 1 FROM virturia_especial_snapshot WHERE provedor=$1 AND data=$2 AND hora_alvo=$3 AND mercado=$4 LIMIT 1`,
      [provedor, alvoData, alvoHora, mercado]
    );
    if (ex.length) continue; // este mercado já fotografado → mantém travado
    const ligas = calcularEntradas(porLiga, clockOffsetMs, {
      topN: SNAP_TOP, minAmostra: SNAP_AMOSTRA, minConf: SNAP_CONF, gatilhoHora, gatilhoData, mercado
    });
    for (const lg in ligas) {
      for (const e of ligas[lg]) {
        const r = await db.query(`
          INSERT INTO virturia_especial_snapshot
            (provedor, data, hora_alvo, liga, slot, gatilho, tipo, mercado, pct, amostra, origem, forca)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (provedor, data, hora_alvo, liga, slot, mercado) DO NOTHING
        `, [provedor, alvoData, alvoHora, lg, e.slot, e.gatilho, e.tipo, e.mercado, e.pct, e.amostra, origem, e.forca ?? null]);
        n += r.rowCount;
      }
    }
  }
  if (n) console.log(`[especial-snap ${provedor}] foto ${alvoData} ${alvoHora}h (${n} entradas)`);
  return n;
}

// Foto da hora atual (chamado a cada minuto — barato após a 1ª por causa do exists)
async function snapshotHora(db, tabela, clockOffsetMs, provedor) {
  await initSnapTable(db);
  const { data, hora } = dataHoraProvedor(Date.now(), clockOffsetMs);
  await gravarFotoHora(db, tabela, clockOffsetMs, provedor, data, hora);
}

// Acha o resultado real de uma célula (liga, slot, hora, data) na Matrix.
async function acharResultadoCelula(db, tabela, clockOffsetMs, liga, slot, hora, data) {
  const { rows } = await db.query(`
    SELECT ft_a, ft_b, ft_str, start_time
    FROM ${tabela}
    WHERE liga=$1 AND slot_min=$2
    ORDER BY start_time DESC LIMIT 300
  `, [liga, slot]);
  for (const j of rows) {
    const d = new Date(Number(j.start_time) + clockOffsetMs);
    if (d.getUTCHours() === hora && d.toISOString().slice(0, 10) === data) return j;
  }
  return null;
}

// Confere as fotos ainda não avaliadas — MARTINGALE 3 TIROS:
// GREEN se o mercado bater no slot OU nos 2 slots seguintes da liga (mesma hora);
// RED só se os 3 jogaram e falharam; PENDENTE enquanto não fecharam.
async function conferirSnapshots(db, tabela, clockOffsetMs, provedor) {
  await initSnapTable(db);
  const { rows } = await db.query(`
    SELECT id, data, hora_alvo, liga, slot, mercado
    FROM virturia_especial_snapshot
    WHERE provedor=$1 AND acerto IS NULL
    ORDER BY data, hora_alvo
    LIMIT 2000
  `, [provedor]);
  const gridCache = {};
  for (const s of rows) {
    // grid de slots da liga (Express = 1 em 1; demais = 3 em 3) — descoberto do banco
    if (!gridCache[s.liga]) {
      const { rows: sl } = await db.query(
        `SELECT DISTINCT slot_min FROM ${tabela} WHERE liga=$1 ORDER BY slot_min ASC`, [s.liga]);
      gridCache[s.liga] = sl.map(x => parseInt(x.slot_min));
    }
    const grid = gridCache[s.liga];
    const idx = grid.indexOf(s.slot);
    if (idx < 0) continue;
    const tiros = grid.slice(idx, idx + 3); // S e os 2 slots seguintes (3 tiros)
    let acerto = null, resultado = null, jogados = 0;
    for (const ts of tiros) {
      const j = await acharResultadoCelula(db, tabela, clockOffsetMs, s.liga, ts, s.hora_alvo, s.data);
      if (!j) continue; // esse tiro ainda não jogou
      jogados++;
      if (mercadoBateu(s.mercado, parseInt(j.ft_a), parseInt(j.ft_b))) {
        acerto = true;
        resultado = (ts === s.slot ? '' : String(ts).padStart(2, '0') + "' ") + j.ft_str; // marca em qual tiro bateu
        break;
      }
    }
    if (acerto === null) {
      if (jogados >= tiros.length && tiros.length > 0) {
        acerto = false; // os 3 jogaram e nenhum bateu
        const j0 = await acharResultadoCelula(db, tabela, clockOffsetMs, s.liga, s.slot, s.hora_alvo, s.data);
        resultado = j0 ? j0.ft_str : null;
      } else {
        continue; // ainda faltam tiros jogarem → pendente
      }
    }
    await db.query(
      `UPDATE virturia_especial_snapshot SET resultado=$1, acerto=$2, metodo='m3', conferido_em=NOW() WHERE id=$3`,
      [resultado, acerto, s.id]
    );
  }
}

// Factory: cria o router para uma tabela (Betano ou Bet365)
// clockOffsetMs: relógio do provedor (Betano -3h = -10800000, Bet365 +1h = +3600000)
module.exports = function (db, tabela, clockOffsetMs = 0) {
  const router = require('express').Router();

  // ── GET /matriz-acima ───────────────────────────────────────────
  // Params: liga, horas (default 720=30d), modo (ft|htft), min_amostra, min_conf
  router.get('/matriz-acima', auth, async (req, res) => {
    try {
      const liga      = req.query.liga || null;
      const horas     = parseInt(req.query.horas) || 720;
      const modo      = req.query.modo === 'htft' ? 'htft' : 'ft';
      const minAmostra= parseInt(req.query.min_amostra) || 6;
      const minConf   = parseInt(req.query.min_conf) || 50;
      const cutoff    = Date.now() - horas * 3600000;

      const { rows } = await db.query(`
        SELECT liga, slot_min, ht_str, ft_str, ft_a, ft_b, start_time
        FROM ${tabela}
        WHERE start_time > $1 ${liga ? 'AND liga = $2' : ''}
        ORDER BY liga, slot_min, start_time ASC
      `, liga ? [cutoff, liga] : [cutoff]);

      // Agrupa por liga|slot e linka cada célula com a de cima (~60min depois)
      // signature do gatilho → contagem de mercados/placares que saíram acima
      const stats = {}; // chave: liga|signature

      let prev = null;
      for (const r of rows) {
        const cur = {
          liga: r.liga, slot: parseInt(r.slot_min),
          ts: Number(r.start_time),
          ft: r.ft_str, ht: r.ht_str,
          a: r.ft_a, b: r.ft_b
        };
        if (prev && prev.liga === cur.liga && prev.slot === cur.slot) {
          const gap = cur.ts - prev.ts;
          if (gap >= MIN_GAP && gap <= MAX_GAP) {
            // prev = gatilho ; cur = célula ACIMA (próxima hora, mesmo slot)
            const sig = modo === 'htft'
              ? `${prev.ht || '?'}→${prev.ft}`
              : prev.ft;
            const chave = `${prev.liga}|${sig}`;
            if (!stats[chave]) {
              stats[chave] = {
                liga: prev.liga, signature: sig, total: 0,
                mercados: {}, placares: {}
              };
            }
            const s = stats[chave];
            s.total++;
            // conta mercados que saíram acima
            for (const mk of mercadosDe(cur.a, cur.b)) {
              s.mercados[mk] = (s.mercados[mk] || 0) + 1;
            }
            // conta placar exato acima
            s.placares[cur.ft] = (s.placares[cur.ft] || 0) + 1;
          }
        }
        prev = cur;
      }

      // Monta resposta: para cada gatilho, o melhor mercado acima
      const out = [];
      for (const chave in stats) {
        const s = stats[chave];
        if (s.total < minAmostra) continue;

        // melhor mercado
        let bestMk = null, bestMkN = 0;
        for (const mk in s.mercados) {
          if (s.mercados[mk] > bestMkN) { bestMkN = s.mercados[mk]; bestMk = mk; }
        }
        const mkPct = Math.round(bestMkN * 100 / s.total);
        if (mkPct < minConf) continue;

        // melhor placar exato
        let bestPl = null, bestPlN = 0;
        for (const pl in s.placares) {
          if (s.placares[pl] > bestPlN) { bestPlN = s.placares[pl]; bestPl = pl; }
        }

        out.push({
          liga: s.liga,
          gatilho: s.signature,
          amostra: s.total,
          mercado_acima: bestMk,
          mercado_pct: mkPct,
          mercado_vezes: bestMkN,
          placar_acima: bestPl,
          placar_pct: Math.round(bestPlN * 100 / s.total),
          placar_vezes: bestPlN,
        });
      }

      // Ordena pelos que mais saem (amostra), depois confiança
      out.sort((a, b) => b.amostra - a.amostra || b.mercado_pct - a.mercado_pct);

      res.json({ ok: true, modo, total: out.length, padroes: out.slice(0, 120) });
    } catch (e) {
      console.error('[matriz-acima]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /melhores-entradas ──────────────────────────────────────
  // A "aba Especial": pega o que saiu por último em cada slot e prevê
  // a célula ACIMA. Retorna só o TOP N por liga (mastigado).
  router.get('/melhores-entradas', auth, async (req, res) => {
    try {
      const horas      = parseInt(req.query.horas) || 720;
      const topN       = parseInt(req.query.top) || 3;
      const minAmostra = parseInt(req.query.min_amostra) || 8;
      const minConf    = parseInt(req.query.min_conf) || 60;
      const mercado    = req.query.mercado === 'UNDER 2.5' ? 'UNDER 2.5' : 'OVER 1.5';

      const porLiga = await carregarPorLigaSlot(db, tabela, horas);
      const out = calcularEntradas(porLiga, clockOffsetMs, { topN, minAmostra, minConf, mercado });

      // hora alvo dominante (a mais frequente entre todas as entradas) p/ o banner
      const contHora = {};
      for (const lg in out) for (const e of out[lg]) contHora[e.hora_alvo] = (contHora[e.hora_alvo]||0) + 1;
      let horaAlvoDom = null, maxC = 0;
      for (const h in contHora) if (contHora[h] > maxC) { maxC = contHora[h]; horaAlvoDom = +h; }

      res.json({ ok: true, hora_alvo: horaAlvoDom, ligas: out });
    } catch (e) {
      console.error('[melhores-entradas]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /especial/ao-vivo ───────────────────────────────────────
  // Foto TRAVADA da hora atual (gravada no banco na virada). O AO VIVO
  // lê daqui em vez de recalcular → não oscila, sobrevive a F5, igual em
  // qualquer PC. Inclui resultado/acerto se a hora já foi conferida.
  const provedor = tabela === 'virturia_resultados_b365' ? 'bet365' : 'betano';
  router.get('/especial/ao-vivo', auth, async (req, res) => {
    try {
      await initSnapTable(db);
      const agora = new Date(Date.now() + clockOffsetMs);
      const horaViva = agora.getUTCHours();
      const data = agora.toISOString().slice(0, 10);
      const mercado = req.query.mercado === 'UNDER 2.5' ? 'UNDER 2.5' : 'OVER 1.5';
      const { rows } = await db.query(`
        SELECT liga, slot, gatilho, tipo, mercado, pct, amostra, resultado, acerto, forca
        FROM virturia_especial_snapshot
        WHERE provedor=$1 AND data=$2 AND hora_alvo=$3 AND mercado=$4
        ORDER BY liga, slot
      `, [provedor, data, horaViva, mercado]);
      const ligas = {};
      for (const r of rows) {
        (ligas[r.liga] = ligas[r.liga] || []).push({
          slot: r.slot, gatilho: r.gatilho, tipo: r.tipo, mercado: r.mercado,
          pct: r.pct, amostra: r.amostra, hora_alvo: horaViva, forca: r.forca,
          resultado: r.resultado, acerto: r.acerto
        });
      }
      res.json({ ok: true, hora_alvo: horaViva, ligas });
    } catch (e) {
      console.error('[especial/ao-vivo]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /especial/clima-hora ────────────────────────────────────
  // 🌡 Termômetro DESCRITIVO da hora atual: compara os jogos JÁ jogados
  // nesta hora (relógio do provedor) com a base da janela de 30d.
  // NÃO é previsão — calibrado em 03/07/2026 com 14.467 jogos reais:
  // começo de hora quente NÃO esquenta o resto (under no resto 58,3%
  // vs 57,3% nas horas normais — RNG). O que ele entrega é situação/
  // anti-tilt: avisa quando o card da hora está sofrendo, em tempo real.
  // Limiar z±2 sinaliza ~6% das horas (raro de verdade, não vira ruído).
  router.get('/especial/clima-hora', auth, async (req, res) => {
    try {
      const porLiga = await carregarPorLigaSlot(db, tabela, SNAP_HORAS);
      const agora = dataHoraProvedor(Date.now(), clockOffsetMs);
      let n = 0, gols = 0, o15 = 0, u25 = 0;                 // hora atual
      let bn = 0, bgols = 0, bg2 = 0, bo15 = 0, bu25 = 0;    // base 30d
      const ligas = [];
      for (const lg in porLiga) {
        let ln = 0, lgols = 0, lbn = 0, lbgols = 0;
        for (const slot in porLiga[lg]) for (const j of porLiga[lg][slot]) {
          const g = j.a + j.b;
          lbn++; lbgols += g; bg2 += g * g;
          if (g >= 2) bo15++;
          if (g <= 2) bu25++;
          const d = new Date(j.ts + clockOffsetMs);
          if (d.getUTCHours() === agora.hora && d.toISOString().slice(0, 10) === agora.data) {
            ln++; lgols += g;
            if (g >= 2) o15++;
            if (g <= 2) u25++;
          }
        }
        bn += lbn; bgols += lbgols; n += ln; gols += lgols;
        if (ln >= 3 && lbn >= 50) {
          const lm = lgols / ln, lb = lbgols / lbn;
          ligas.push({ liga: lg, n: ln, media: +lm.toFixed(2), media_base: +lb.toFixed(2), delta: +(lm - lb).toFixed(2) });
        }
      }
      const mediaBase = bn ? bgols / bn : null;
      const sd = bn ? Math.sqrt(Math.max(0, bg2 / bn - mediaBase * mediaBase)) : null;
      const media = n ? gols / n : null;
      let z = null, clima = 'inicio';
      if (n >= 6 && sd) {
        z = (media - mediaBase) / (sd / Math.sqrt(n));
        clima = z >= 2 ? 'quente' : z >= 1.3 ? 'aquecendo'
              : z <= -2 ? 'fria'  : z <= -1.3 ? 'esfriando' : 'normal';
      }
      // ligas mais fora da curva primeiro (pro front listar as 2-3 piores)
      ligas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      res.json({
        ok: true, data: agora.data, hora: agora.hora, n,
        media: media != null ? +media.toFixed(2) : null,
        media_base: mediaBase != null ? +mediaBase.toFixed(2) : null,
        z: z != null ? +z.toFixed(2) : null, clima,
        over15:  { hits: o15, pct: n ? Math.round(o15 * 100 / n) : null, base: bn ? Math.round(bo15 * 100 / bn) : null },
        under25: { hits: u25, pct: n ? Math.round(u25 * 100 / n) : null, base: bn ? Math.round(bu25 * 100 / bn) : null },
        ligas: ligas.slice(0, 4)
      });
    } catch (e) {
      console.error('[especial/clima-hora]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /especial/historico?horas=48 ────────────────────────────
  // Placar acumulado (verde/vermelho) das fotos das últimas N horas.
  router.get('/especial/historico', auth, async (req, res) => {
    try {
      await initSnapTable(db);
      const horas = parseInt(req.query.horas) || 48;
      const desde = new Date(Date.now() - horas * 3600000).toISOString();
      const mercado = req.query.mercado === 'UNDER 2.5' ? 'UNDER 2.5' : 'OVER 1.5';
      const { rows } = await db.query(`
        SELECT data, hora_alvo, liga, slot, gatilho, tipo, mercado, pct, amostra, resultado, acerto, forca, criado_em
        FROM virturia_especial_snapshot
        WHERE provedor=$1 AND criado_em >= $2 AND origem = 'vivo' AND mercado=$3
        ORDER BY criado_em DESC, liga, slot
      `, [provedor, desde, mercado]);
      const conf = rows.filter(r => r.acerto !== null);
      const greens = conf.filter(r => r.acerto === true).length;
      res.json({
        ok: true,
        total: rows.length,
        conferidas: conf.length,
        greens, reds: conf.length - greens,
        pct: conf.length ? Math.round(greens * 100 / conf.length) : null,
        entradas: rows
      });
    } catch (e) {
      console.error('[especial/historico]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Índice composto — faz a varredura de 720h passar de seq scan para index scan (~30s → <1s)
  db.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_slot_time ON ${tabela}(liga, slot_min, start_time)`)
    .catch(e => console.error(`[idx ${tabela}]`, e.message));

  // Agendadores em background (1 por provedor): tira a foto da hora (trava)
  // e confere os acertos contra a Matrix. Aditivo — não afeta as rotas acima.
  initSnapTable(db).then(async () => {
    // limpa o LIXO reconstruído (sem origem) — conta só hora REAL ao vivo daqui pra frente.
    // Idempotente: as fotos novas têm origem='vivo', então em restarts futuros não apaga nada.
    await db.query(`DELETE FROM virturia_especial_snapshot WHERE provedor=$1 AND (origem IS NULL OR origem <> 'vivo')`, [provedor])
      .then(r => { if (r.rowCount) console.log(`[especial-limpa ${provedor}] removeu ${r.rowCount} entradas reconstruídas (lixo)`); })
      .catch(e => console.error('[especial-limpa]', e.message));
    await snapshotHora(db, tabela, clockOffsetMs, provedor).catch(e => console.error('[especial-snap]', e.message));
    await conferirSnapshots(db, tabela, clockOffsetMs, provedor).catch(e => console.error('[especial-conf]', e.message));
  }).catch(e => console.error('[especial-snap init]', e.message));
  setInterval(() => snapshotHora(db, tabela, clockOffsetMs, provedor).catch(e => console.error('[especial-snap]', e.message)), 60 * 1000);
  setInterval(() => conferirSnapshots(db, tabela, clockOffsetMs, provedor).catch(e => console.error('[especial-conf]', e.message)), 5 * 60 * 1000);

  return router;
};
