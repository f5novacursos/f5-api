// F5 Leads: trechos de SQL compartilhados — UMA definição de "já recebeu mensagem" / "bloqueado para envio".
// Usado pela lista de leads (marcação na tela) e pela verificação antes do disparo.

// Status que contam como "já foi contatado"
const ENVIADOS = ['mensagem_enviada', 'respondeu', 'cliente'];
const lista = (a) => a.map(s => `'${s}'`).join(',');

// Compara texto sem acento e sem diferença de maiúscula (não depende da extensão unaccent do Postgres)
const COM = 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç';
const SEM = 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc';
const semAcentoSql = (col) => `LOWER(TRANSLATE(${col},'${COM}','${SEM}'))`;
const semAcentoJs = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Número do lead = whatsapp, senão telefone (igual ao que o disparo usa). k.n8 = últimos 8 dígitos.
// x = último envio confirmado para este lead OU para qualquer cadastro com o mesmo número.
const LATERAIS = `
  CROSS JOIN LATERAL (
    SELECT RIGHT(REGEXP_REPLACE(COALESCE(NULLIF(e.whatsapp,''), e.telefone, ''), '[^0-9]', '', 'g'), 8) AS n8
  ) k
  LEFT JOIN LATERAL (
    SELECT MAX(m.enviado_em) AS ultimo_envio, COUNT(*)::int AS qtd_envios
    FROM leads_mensagens m
    WHERE m.status = 'enviado'
      AND (m.empresa_id = e.id
           OR (LENGTH(k.n8) = 8 AND RIGHT(REGEXP_REPLACE(COALESCE(m.numero,''), '[^0-9]', '', 'g'), 8) = k.n8))
  ) x ON true`;

// Lead que já está na fila de um disparo em andamento
const NA_FILA = `EXISTS (
  SELECT 1 FROM leads_disparo_itens i JOIN leads_disparos d ON d.id = i.disparo_id
  WHERE i.empresa_id = e.id AND i.status IN ('pendente','enviando') AND d.status = 'em_andamento')`;

const JA_ENVIADO = `(x.ultimo_envio IS NOT NULL OR e.status IN (${lista(ENVIADOS)}))`;

// Por que o lead NÃO pode receber agora (NULL = pode receber)
const MOTIVO = `CASE
  WHEN ${JA_ENVIADO} THEN 'enviado'
  WHEN e.status = 'nao_enviar' THEN 'nao_enviar'
  WHEN e.status = 'ignorado' THEN 'ignorado'
  WHEN ${NA_FILA} THEN 'na_fila'
  WHEN e.status IN ('sem_telefone','sem_whatsapp') OR LENGTH(k.n8) < 8 THEN 'sem_numero'
END`;

module.exports = { ENVIADOS, lista, semAcentoSql, semAcentoJs, LATERAIS, NA_FILA, JA_ENVIADO, MOTIVO };
