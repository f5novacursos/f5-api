/**
 * collector-b365.js
 * Coletor Bet365 Virtual — roda no VPS como setInterval interno da f5-api
 * Substitui o Cloudflare Worker bet365-proxy (que parou de funcionar)
 * Coleta cada liga a cada 60s, salva diretamente no banco
 */
const db = require('../db');

const EA_BASE = 'https://api.easycoanalytics.com.br';

const LIGAS = [
  { sub: 'express_cup',              liga: 'express_cup' },
  { sub: 'copa_do_mundo',            liga: 'copa_mundo' },
  { sub: 'euro_cup',                 liga: 'euro_cup' },
  { sub: 'super_liga_sul-americana', liga: 'sul_americana' },
  { sub: 'premiership',              liga: 'premier_league' },
];

const LIGA_SLOTS = {
  express_cup:    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59],
  copa_mundo:     [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
  euro_cup:       [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
  sul_americana:  [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
  premier_league: [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
};

// Headers de browser para evitar bloqueios por IP
const EA_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

async function fetchLiga(sub, liga) {
  const url = EA_BASE + '/snapshot?provider=bet365&sub=' + sub + '&_t=' + Date.now();
  let r;
  try {
    r = await fetch(url, { headers: EA_HEADERS, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return 0;
  }
  if (!r.ok) return 0;

  let data;
  try { data = await r.json(); } catch(e) { return 0; }
  if (!Array.isArray(data)) return 0;

  const slots = LIGA_SLOTS[liga] || LIGA_SLOTS['premier_league'];
  let salvos = 0;

  for (const jogo of data) {
    if (jogo.status !== 'finalizado') continue;
    const ftA = jogo.scoreboardFT ? jogo.scoreboardFT.home : null;
    const ftB = jogo.scoreboardFT ? jogo.scoreboardFT.away : null;
    if (ftA === null || ftA === undefined || ftB === null || ftB === undefined) continue;

    const d = new Date(jogo.date);
    // EasyCoAnalytics armazena em BST (UTC+1) como se fosse UTC — subtrair 1h
    const realUtcMs = d.getTime() - 3600000;
    const dBST = new Date(realUtcMs + 3600000);
    const hora = dBST.getUTCHours();
    const minuto = dBST.getUTCMinutes();
    const dataBST = dBST.toISOString().slice(0, 10);

    let slotMin = slots[0], minDiff = 99;
    for (const s of slots) {
      const diff = Math.abs(s - minuto);
      if (diff < minDiff) { minDiff = diff; slotMin = s; }
    }
    const slotIdx = slots.indexOf(slotMin);
    const eventId = liga + '_' + dataBST + '_' + hora + '_' + slotMin;

    const fa = Number(ftA), fb = Number(ftB);
    const htRaw = jogo.scoreboardHT;
    const ha = htRaw && htRaw.home !== undefined ? Number(htRaw.home) : null;
    const hb = htRaw && htRaw.away !== undefined ? Number(htRaw.away) : null;

    try {
      await db.query(
        'INSERT INTO virturia_resultados_b365 ' +
        '(event_id,liga,hora,slot,slot_min,team_a,team_b,ft_a,ft_b,ht_a,ht_b,ft_str,ht_str,' +
        'gols_total,is_btts,casa_ganha,visit_ganha,empate,ht_atipico,start_time) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ' +
        'ON CONFLICT (event_id) DO UPDATE SET ' +
        'ft_a=EXCLUDED.ft_a,ft_b=EXCLUDED.ft_b,ht_a=EXCLUDED.ht_a,ht_b=EXCLUDED.ht_b,' +
        'ft_str=EXCLUDED.ft_str,ht_str=EXCLUDED.ht_str,gols_total=EXCLUDED.gols_total,' +
        'is_btts=EXCLUDED.is_btts,casa_ganha=EXCLUDED.casa_ganha,visit_ganha=EXCLUDED.visit_ganha,' +
        'empate=EXCLUDED.empate,start_time=EXCLUDED.start_time',
        [
          eventId, liga, hora, slotIdx >= 0 ? slotIdx : 0, slotMin,
          jogo.teamA || null, jogo.teamB || null,
          fa, fb, ha, hb,
          fa + '-' + fb,
          ha !== null ? ha + '-' + hb : null,
          fa + fb,
          fa > 0 && fb > 0,
          fa > fb,
          fb > fa,
          fa === fb,
          ha !== null ? (ha + hb >= 3) : false,
          realUtcMs
        ]
      );
      salvos++;
    } catch (e) {
      // ON CONFLICT ou erro — ignora silenciosamente
    }
  }

  return salvos;
}

// Estado interno
let _running = false;
let _lastRun  = null;
let _lastError = null;
let _totalSalvos = 0;
let _ciclos = 0;

async function runCycle() {
  if (_running) return;
  _running = true;
  const inicio = Date.now();
  try {
    let salvos = 0;
    for (const item of LIGAS) {
      const n = await fetchLiga(item.sub, item.liga);
      salvos += n;
      // 400ms entre ligas para não sobrecarregar
      await new Promise(res => setTimeout(res, 400));
    }
    _ciclos++;
    _totalSalvos += salvos;
    _lastRun = { ts: Date.now(), ciclo: _ciclos, salvos: salvos, acumulado: _totalSalvos, ms: Date.now() - inicio };
    if (salvos > 0) {
      console.log('[b365] +' + salvos + ' resultados | ciclo=' + _ciclos + ' total=' + _totalSalvos);
    }
  } catch (e) {
    _lastError = e.message;
    console.error('[b365] erro no ciclo:', e.message);
  } finally {
    _running = false;
  }
}

function startCollector() {
  console.log('[b365] Coletor iniciado — intervalo 60s');
  runCycle(); // executa imediatamente na primeira vez
  setInterval(runCycle, 60000);
}

function getStatus() {
  return {
    running: _running,
    ciclos: _ciclos,
    totalSalvos: _totalSalvos,
    lastRun: _lastRun,
    lastError: _lastError,
  };
}

module.exports = { startCollector, getStatus };
