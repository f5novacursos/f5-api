const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(require('path').join(__dirname,'../routes/ead.js'),'utf8');
new vm.Script(src);
const cat=[{id:1,titulo:'Informática Profissional + IA EAD — Curso Completo'},{id:2,titulo:'Excel Profissional + IA EAD — Curso Completo'},{id:27,titulo:'Documentos Profissionais com IA — Word + Google Docs'}];
const mats=new Map([[9,'ativa'],[1,'pendente']]);
const db={query:async(sql,args)=>{
 if(sql.includes('FROM ead_cursos'))return {rows:cat};
 if(sql.includes('INSERT INTO ead_matriculas')){if(!mats.has(args[1])||mats.get(args[1])==='pendente')mats.set(args[1],'ativa');return {rows:[]};}
 if(sql.includes('SELECT curso_id'))return {rows:[...mats].filter(([,s])=>s==='ativa').map(([curso_id])=>({curso_id}))};
 throw Error(sql);
}};
const ctx=vm.createContext({db,garantirMatriculaDigitacao:async()=>mats.set(5,'ativa')});
vm.runInContext(src.slice(src.indexOf('function _norm'),src.indexOf('// Garantir que a pasta')),ctx);
vm.runInContext(src.slice(src.indexOf('async function cursosAtivosDaConta'),src.indexOf('function assinarContaEad')),ctx);
(async()=>{
 assert(ctx.correspondeCursoPresencial(cat[0].titulo,'Informática Profissional + IA EAD'));
 assert(!ctx.correspondeCursoPresencial(cat[2].titulo,'Informática Profissional + IA EAD'));
 assert.deepEqual(Array.from(await ctx.atualizarCursosPresenciais({id:10,curso:'Informática',turma_curso_nome:'Turma noite'})).sort((a,b)=>a-b),[1,5,9]);
 assert(!mats.has(2));
 await ctx.atualizarCursosPresenciais({id:10,curso:'Excel'});assert.equal(mats.get(2),'ativa');
 mats.set(1,'cancelada');await ctx.atualizarCursosPresenciais({id:10,curso:'Informática'});assert.equal(mats.get(1),'cancelada');
 let handler, result;
 const client={query:async sql=>sql.includes('SELECT * FROM ead_cursos')?{rows:[{id:1,preco:199,venda_publica:true}]}:sql.includes('SELECT id FROM ead_matriculas')?{rows:[{id:1}]}:{rows:[]},release(){}};
 const checkout=vm.createContext({router:{post:(p,m,h)=>handler=h},eadAuthMiddleware(){},db:{connect:async()=>client}});
 const st=src.indexOf("router.post('/checkout',");
 vm.runInContext(src.slice(st,src.indexOf("router.post('/checkout-publico'",st)).replace(/\/\/ POST[^]*$/,''),checkout);
 await handler({body:{curso_id:1},user:{id:10,tipo:'presencial'}},{json:r=>result=r},e=>{throw e});
 assert.equal(result.status,'ativa');
 console.log('OK: nomes atualizados, matrícula pendente, matrícula manual, curso inelegível, cancelamento e cobrança duplicada.');
})().catch(e=>{console.error(e);process.exitCode=1});
