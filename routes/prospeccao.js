// Recuperação do F5 Leads: rotas de prospecção ativa hospedadas na API principal.
const express = require('express');
const db = require('../db');
const router = express.Router();

// Um lead pode aparecer em várias buscas (ex.: achado em "Advogado" e depois em "Associação").
// leads_empresas.busca_id guarda só a 1ª; esta tabela liga o lead a TODAS as buscas que o encontraram.
db.query(`
  CREATE TABLE IF NOT EXISTS leads_empresa_buscas (
    empresa_id INTEGER NOT NULL,
    busca_id   INTEGER NOT NULL,
    PRIMARY KEY (empresa_id, busca_id)
  );
  CREATE INDEX IF NOT EXISTS idx_empresa_buscas_busca ON leads_empresa_buscas (busca_id);
  INSERT INTO leads_empresa_buscas (empresa_id, busca_id)
    SELECT id, busca_id FROM leads_empresas WHERE busca_id IS NOT NULL
  ON CONFLICT DO NOTHING;
`).catch(e => console.error('[prospeccao] leads_empresa_buscas:', e.message));

const ORDENS = {
  data_desc: 'e.criado_em DESC',
  data_asc:  'e.criado_em ASC',
  nome_asc:  'LOWER(e.nome) ASC',
  aval_desc: 'e.avaliacao DESC NULLS LAST, e.total_aval DESC NULLS LAST'
};

async function contaAtiva(id) {
  if (id) {
    const r = await db.query('SELECT * FROM leads_contas_apify WHERE id = $1 AND ativo = true', [id]);
    return r.rows[0] || null;
  }
  const r = await db.query('SELECT * FROM leads_contas_apify WHERE ativo = true ORDER BY ultima_uso ASC NULLS FIRST LIMIT 1');
  return r.rows[0] || null;
}

router.get('/stats', async (req, res) => {
  try {
    const [totais, porStatus, buscasRecentes, mensagens] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='novo') AS novos,
        COUNT(*) FILTER (WHERE status='mensagem_enviada') AS enviados,
        COUNT(*) FILTER (WHERE status='respondeu') AS respostas,
        COUNT(*) FILTER (WHERE status='cliente') AS clientes,
        COUNT(*) FILTER (WHERE status='sem_telefone') AS sem_telefone FROM leads_empresas`),
      db.query('SELECT status, COUNT(*) AS total FROM leads_empresas GROUP BY status ORDER BY total DESC'),
      db.query(`SELECT b.id,b.nicho,b.cidade,b.estado,b.status,b.total_retornado,b.total_novos,b.criado_em,b.actor_run_id,c.nome AS conta_nome
        FROM leads_buscas b LEFT JOIN leads_contas_apify c ON c.id=b.conta_id ORDER BY b.criado_em DESC LIMIT 5`),
      db.query("SELECT COUNT(*) AS total FROM leads_mensagens WHERE status='enviado'")
    ]);
    res.json({ totais: {...totais.rows[0], total_mensagens_enviadas: Number(mensagens.rows[0]?.total || 0)}, porStatus: porStatus.rows, buscasRecentes: buscasRecentes.rows });
  } catch (e) { console.error('[prospeccao stats]', e.message); res.status(500).json({error:e.message}); }
});

router.get('/buscas', async (req, res) => {
  try {
    const page=Math.max(1,Number(req.query.page)||1), limit=Math.min(50,Number(req.query.limit)||20), off=(page-1)*limit;
    const [rows,count] = await Promise.all([
      db.query(`SELECT b.*,c.nome AS conta_nome FROM leads_buscas b LEFT JOIN leads_contas_apify c ON c.id=b.conta_id ORDER BY b.criado_em DESC LIMIT $1 OFFSET $2`,[limit,off]),
      db.query('SELECT COUNT(*) FROM leads_buscas')
    ]);
    res.json({data:rows.rows,total:Number(count.rows[0].count),page,limit});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/leads', async (req, res) => {
  try {
    const page=Math.max(1,Number(req.query.page)||1), limit=Math.min(100,Number(req.query.limit)||50), off=(page-1)*limit;
    const {status,busca_id,cidade,estado,q,nicho,site_filter}=req.query, vals=[], cond=[];
    const add=(sql,value)=>{cond.push(sql.replace('?', `$${vals.length+1}`)); vals.push(value);};
    if(status)add('e.status=?',status); if(estado)add('e.estado=?',estado);
    // Busca e nicho olham TODAS as buscas que encontraram o lead, não só a primeira
    if(busca_id)add('EXISTS (SELECT 1 FROM leads_empresa_buscas eb WHERE eb.empresa_id=e.id AND eb.busca_id=?)',Number(busca_id));
    if(cidade)add('LOWER(e.cidade)=?',cidade.toLowerCase());
    if(nicho)add('EXISTS (SELECT 1 FROM leads_empresa_buscas eb JOIN leads_buscas bb ON bb.id=eb.busca_id WHERE eb.empresa_id=e.id AND LOWER(bb.nicho)=?)',nicho.toLowerCase()); if(site_filter==='com_site')cond.push("e.site IS NOT NULL AND e.site <> ''"); if(site_filter==='sem_site')cond.push("(e.site IS NULL OR e.site = '')");
    if(q){ const p1=`$${vals.length+1}`,p2=`$${vals.length+2}`; cond.push(`(LOWER(e.nome) LIKE ${p1} OR e.telefone LIKE ${p2})`); vals.push(`%${q.toLowerCase()}%`,`%${q}%`); }
    const where=cond.length?'WHERE '+cond.join(' AND '):'';
    const [rows,count]=await Promise.all([
      db.query(`SELECT e.*,b.nicho,c.nome AS conta_nome FROM leads_empresas e LEFT JOIN leads_buscas b ON b.id=e.busca_id LEFT JOIN leads_contas_apify c ON c.id=e.conta_id ${where} ORDER BY ${ORDENS[req.query.order]||ORDENS.data_desc}, e.id DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}`,[...vals,limit,off]),
      db.query(`SELECT COUNT(*) FROM leads_empresas e LEFT JOIN leads_buscas b ON b.id=e.busca_id ${where}`,vals)
    ]);
    res.json({data:rows.rows,total:Number(count.rows[0].count),page,limit});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.patch('/leads/:id', async (req,res) => {
  try { const {status,observacoes,whatsapp,telefone}=req.body, fields={status,observacoes,whatsapp,telefone}, vals=[], sets=[];
    for(const [key,value] of Object.entries(fields)) if(value!==undefined){sets.push(`${key}=$${vals.length+1}`);vals.push(value);}
    if(!sets.length)return res.status(400).json({error:'Nada para atualizar'}); vals.push(req.params.id);
    const r=await db.query(`UPDATE leads_empresas SET ${sets.join(', ')}, atualizado_em=NOW() WHERE id=$${vals.length} RETURNING *`,vals);
    if(!r.rows[0])return res.status(404).json({error:'Lead não encontrado'}); res.json(r.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/leads/cidades', async (req,res)=>{try{const r=await db.query("SELECT DISTINCT cidade FROM leads_empresas WHERE cidade IS NOT NULL AND cidade <> '' ORDER BY cidade");res.json(r.rows.map(x=>x.cidade))}catch(e){res.status(500).json({error:e.message})}});
router.post('/leads/limpar-site', async (req,res)=>{try{const {ids}=req.body;if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'Nenhum ID fornecido'});await db.query('UPDATE leads_empresas SET site=NULL,atualizado_em=NOW() WHERE id=ANY($1)',[ids]);res.json({ok:true,count:ids.length})}catch(e){res.status(500).json({error:e.message})}});

router.get('/contas', async (req,res)=>{try{const r=await db.query('SELECT id,nome,ativo,modo_auto,ultima_uso,criado_em FROM leads_contas_apify ORDER BY criado_em DESC');res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
router.post('/contas', async (req,res)=>{try{const {nome,api_token,ativo=true,modo_auto=true}=req.body;if(!nome||!api_token)return res.status(400).json({error:'nome e api_token são obrigatórios'});const r=await db.query('INSERT INTO leads_contas_apify (nome,api_token,ativo,modo_auto) VALUES ($1,$2,$3,$4) RETURNING id,nome,ativo,modo_auto,criado_em',[nome,api_token,ativo,modo_auto]);res.status(201).json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});
router.put('/contas/:id', async (req,res)=>{try{const {nome,api_token,ativo,modo_auto}=req.body,sets=[],vals=[];for(const [key,value] of Object.entries({nome,api_token,ativo,modo_auto}))if(value!==undefined){sets.push(`${key}=$${vals.length+1}`);vals.push(value)}if(!sets.length)return res.status(400).json({error:'Nada para atualizar'});vals.push(req.params.id);const r=await db.query(`UPDATE leads_contas_apify SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id,nome,ativo,modo_auto,ultima_uso,criado_em`,vals);if(!r.rows[0])return res.status(404).json({error:'Conta não encontrada'});res.json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});
router.delete('/contas/:id', async (req,res)=>{try{await db.query('DELETE FROM leads_contas_apify WHERE id=$1',[req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
router.get('/contas/:id/creditos', async (req,res)=>{
  try {const r=await db.query('SELECT api_token FROM leads_contas_apify WHERE id=$1',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Conta não encontrada'});const token=r.rows[0].api_token;
    const [user,usage,runs]=await Promise.all([fetch(`https://api.apify.com/v2/users/me?token=${token}`),fetch(`https://api.apify.com/v2/users/me/usage/monthly?token=${token}`),fetch(`https://api.apify.com/v2/actor-runs?token=${token}&limit=100&desc=true`)]);
    if(!user.ok)return res.status(502).json({error:'Erro ao consultar Apify'});const u=await user.json(),v=usage.ok?await usage.json():{},x=runs.ok?await runs.json():{data:{items:[]}},plan=u.data?.plan||{},monthly=v.data||{};let usados=monthly.totalUsageCreditsUsdAfterVolumeDiscount??monthly.totalUsageCreditsUsdBeforeVolumeDiscount??0;if(usados===0){const inicio=monthly.usageCycle?.startAt?new Date(monthly.usageCycle.startAt):new Date(new Date().getFullYear(),new Date().getMonth(),1);usados=(x.data?.items||[]).filter(i=>new Date(i.startedAt)>=inicio).reduce((s,i)=>s+(i.usageTotalUsd||0),0)}res.json({username:u.data?.username,email:u.data?.email,plan_id:plan.id,plan_nome:plan.name||plan.id,creditos_total:plan.monthlyUsageCreditsUsd??5,creditos_usados:usados,renova_em:monthly.usageCycle?.endAt||null,compute_total:plan.monthlyActorComputeUnits,compute_usados:monthly.actorComputeUnits,runs_total:plan.monthlyActorRuns,runs_usados:monthly.actorRuns});
  }catch(e){console.error('[prospeccao creditos]',e.message);res.status(500).json({error:e.message})}
});

router.post('/apify/executar', async (req,res)=>{
  try { const {nicho,cidade,estado,quantidade=20,conta_id,ignorar,filtros={}}=req.body; if(!nicho||!cidade||!estado)return res.status(400).json({error:'nicho, cidade e estado são obrigatórios'}); if(ignorar)filtros.ignorar=ignorar;
    const conta=await contaAtiva(conta_id); if(!conta)return res.status(400).json({error:'Nenhuma conta Apify ativa disponível'});
    const busca=(await db.query(`INSERT INTO leads_buscas (nicho,cidade,estado,quantidade,filtros,conta_id,status) VALUES ($1,$2,$3,$4,$5,$6,'executando') RETURNING *`,[nicho,cidade,estado,quantidade,JSON.stringify(filtros),conta.id])).rows[0];
    const input={countryCode:'br',language:'pt-BR',locationQuery:`${cidade}, ${estado === 'PB' ? 'Paraíba' : estado}, Brazil`,maxCrawledPlacesPerSearch:Number(quantidade),searchStringsArray:[`${nicho} ${cidade} ${estado}`],skipClosedPlaces:false,...filtros};
    const apify=await fetch(`https://api.apify.com/v2/acts/lukaskrivka~google-maps-with-contact-details/runs?token=${conta.api_token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    if(!apify.ok){const detail=await apify.text();await db.query("UPDATE leads_buscas SET status='erro',erro_msg=$1 WHERE id=$2",[detail,busca.id]);return res.status(502).json({error:'Erro ao iniciar Apify',detail});}
    const data=await apify.json(),runId=data.data?.id,datasetId=data.data?.defaultDatasetId;await db.query('UPDATE leads_buscas SET actor_run_id=$1,dataset_id=$2 WHERE id=$3',[runId,datasetId,busca.id]);await db.query('UPDATE leads_contas_apify SET ultima_uso=NOW() WHERE id=$1',[conta.id]);res.json({ok:true,busca_id:busca.id,run_id:runId,dataset_id:datasetId,conta:conta.nome});
  } catch(e){console.error('[prospeccao apify]',e.message);res.status(500).json({error:e.message});}
});

router.get('/apify/status/:runId', async (req,res)=>{
  try {const r=await db.query(`SELECT b.*,c.api_token FROM leads_buscas b JOIN leads_contas_apify c ON c.id=b.conta_id WHERE b.actor_run_id=$1`,[req.params.runId]);const busca=r.rows[0];if(!busca)return res.status(404).json({error:'Run não encontrado'});const response=await fetch(`https://api.apify.com/v2/actor-runs/${req.params.runId}?token=${busca.api_token}`);if(!response.ok)return res.status(502).json({error:'Erro ao consultar Apify'});const data=await response.json(),status=data.data?.status;if(status==='SUCCEEDED')await db.query("UPDATE leads_buscas SET status='importando' WHERE id=$1 AND status='executando'",[busca.id]);if(status==='FAILED'||status==='ABORTED')await db.query("UPDATE leads_buscas SET status='erro',erro_msg=$1,concluido_em=NOW() WHERE id=$2",[status,busca.id]);res.json({busca_id:busca.id,run_id:req.params.runId,apify_status:status,dataset_id:data.data?.defaultDatasetId,stats:data.data?.stats})}catch(e){res.status(500).json({error:e.message})}
});

router.post('/apify/importar/:runId', async (req,res)=>{
  try {const r=await db.query(`SELECT b.*,c.api_token FROM leads_buscas b JOIN leads_contas_apify c ON c.id=b.conta_id WHERE b.actor_run_id=$1`,[req.params.runId]);const busca=r.rows[0];if(!busca)return res.status(404).json({error:'Run não encontrado'});const response=await fetch(`https://api.apify.com/v2/datasets/${busca.dataset_id}/items?token=${busca.api_token}&clean=true&format=json`);if(!response.ok)return res.status(502).json({error:'Erro ao buscar dataset Apify'});const items=await response.json();let novos=0,atualizados=0;let ignorar=[];try{const f=typeof busca.filtros==='string'?JSON.parse(busca.filtros):busca.filtros||{};ignorar=String(f.ignorar||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)}catch{}
    for(const item of items){try{const placeId=item.placeId?String(item.placeId).slice(0,300):null,nome=String(item.title||'Sem nome').slice(0,300),categoria=item.categories?.[0]?String(item.categories[0]).slice(0,300):null;if(ignorar.some(x=>`${nome} ${categoria||''}`.toLowerCase().includes(x)))continue;const telefone=String(item.phone||'').replace(/\D/g,'').slice(-11)||null,site=item.website?String(item.website).slice(0,500):null,email=item.emails?.[0]?String(item.emails[0]).slice(0,200):null,instagram=item.instagram?.[0]?String(item.instagram[0]).slice(0,200):null;const existe=placeId?await db.query('SELECT id FROM leads_empresas WHERE place_id=$1',[placeId]):telefone?await db.query("SELECT id FROM leads_empresas WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefone,''),'[^0-9]','','g'),8)=$1",[telefone.slice(-8)]):{rows:[]};if(existe.rows[0]){await db.query('UPDATE leads_empresas SET site=COALESCE(site,$1),email=COALESCE(email,$2),instagram=COALESCE(instagram,$3),atualizado_em=NOW() WHERE id=$4',[site,email,instagram,existe.rows[0].id]);await db.query('INSERT INTO leads_empresa_buscas (empresa_id,busca_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[existe.rows[0].id,busca.id]);atualizados++;continue}const criado=await db.query(`INSERT INTO leads_empresas (place_id,nome,telefone,cidade,estado,categoria,avaliacao,total_aval,site,email,instagram,endereco,cep,latitude,longitude,status,busca_id,conta_id,dados_brutos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,[placeId,nome,telefone,busca.cidade,busca.estado,categoria,item.rating||null,item.reviewsCount||null,site,email,instagram,item.address||null,item.postalCode?.slice(0,10)||null,item.location?.lat||null,item.location?.lng||null,telefone?'novo':'sem_telefone',busca.id,busca.conta_id,JSON.stringify(item)]);await db.query('INSERT INTO leads_empresa_buscas (empresa_id,busca_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[criado.rows[0].id,busca.id]);novos++}catch(e){console.error('[prospeccao importar item]',e.message)}}
    await db.query("UPDATE leads_buscas SET status='concluido',total_retornado=$1,total_novos=$2,total_atualizados=$3,concluido_em=NOW() WHERE id=$4",[items.length,novos,atualizados,busca.id]);res.json({ok:true,busca_id:busca.id,total:items.length,novos,atualizados})
  }catch(e){console.error('[prospeccao importar]',e.message);res.status(500).json({error:e.message})}
});

router.use('/mensagens', require('./prospeccao-mensagens'));

router.get('/health', (req,res)=>res.json({ok:true,service:'f5-prospeccao'}));
module.exports=router;
