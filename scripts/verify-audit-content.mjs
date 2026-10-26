import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {validateSchema} from './audit-schema.mjs';
import {evaluateBlock,factMap,buildReportPreview} from '../worker/src/audit/rules.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=path.join(root,'worker/src/audit/data');
const args=new Set(process.argv.slice(2));
for(const a of args)assert(['--write','--release'].includes(a),'Unknown argument '+a);
const write=args.has('--write'),read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
const releaseVersion=read('library-manifest.json').library_version;
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=(n,v)=>fs.writeFileSync(path.join(dir,n),JSON.stringify(v,null,2)+'\n');
const unique=(xs,label)=>assert.equal(new Set(xs).size,xs.length,'Duplicate '+label);
const filesByKind={blocks:'bottlenecks.json',questions:'question-bank.json',facts:'facts.json',answers:'answer-options.json',services:'services-catalog.json',tariffs:'tariffs.json',sources:'sources.json',domains:'domains.json',checks:'rule-checks.json',cases:'cases-map.json',faq:'faq.json',prepared:'prepared-answers.json',evaluation:'evaluation-cases.json'};
const data=Object.fromEntries(Object.entries(filesByKind).map(([k,n])=>[k,read(n)]));
for(const [k,d]of Object.entries(data)){assert(Array.isArray(d.items),k);unique(d.items.map(x=>x.id),k);}
const {blocks,questions,facts,answers,services,tariffs,sources,domains,checks,cases,faq,prepared,evaluation}=data;
const sets=Object.fromEntries(Object.entries(data).map(([k,d])=>[k,new Set(d.items.map(x=>x.id))]));
const ref=(k,id)=>assert(sets[k].has(id),'Missing '+k+': '+id);
const schemaCheck=(v,s,label)=>{const e=validateSchema(v,s);assert.equal(e.length,0,label+': '+e.slice(0,5).join('; '));};
const stateSchema=read('audit-state.schema.json'),resultSchema=read('audit-result.schema.json'),conditionSchema=read('conditions.schema.json');
assert.equal(blocks.items.length,140);assert.equal(checks.items.length,560);
unique(blocks.items.map(b=>b.title),'situation title');
unique(blocks.items.map(b=>b.minimum_evidence.specific_condition),'situation condition');
for(const d of domains.items)assert.equal(blocks.items.filter(b=>b.domain===d.id).length,d.target_blocks,d.id);
for(const b of blocks.items){
 ref('domains',b.domain);ref('sources',b.editorial_basis.source);
 assert(b.title&&b.solution.steps.length&&b.solution.deliverable&&b.solution.acceptance,b.id+' incomplete');
 assert(b.previous_attempts.required_before_recommendation&&b.solution.limitations.length,b.id+' missing safeguards');
 for(const id of [...b.matrix.required,...b.matrix.clarifying,...b.matrix.excluding])ref('facts',id);
 for(const id of b.services)ref('services',id);
 for(const s of b.sources)ref('sources',s.source_id);
 for(const l of b.relationships)ref('blocks',l.block_id);
 for(const id of Object.values(b.checks))ref('checks',id);
 schemaCheck(b.inclusion,conditionSchema,b.id+' inclusion');schemaCheck(b.exclusion,conditionSchema,b.id+' exclusion');
 for(const m of JSON.stringify(b.pdf).matchAll(/{{([^}]+)}}/g))assert(b.pdf.allowed_placeholders.includes(m[1]),b.id+' placeholder');
 assert(!/\d[\d ]*\s*(?:₽|руб\.)/.test(JSON.stringify(b.pdf)),b.id+' embedded price');
}
for(const q of questions.items){
 assert(q.chat&&q.voice&&q.skip_if&&q.no_answer_action,q.id+' incomplete');
 assert(q.duration_status==='author_estimate_not_measured',q.id+' duration');
 for(const f of q.fact_ids)ref('facts',f);for(const b of q.related_blocks)ref('blocks',b);
 if(q.answer_set)ref('answers',q.answer_set);if(q.transitions?.target)ref('questions',q.transitions.target);
}
for(const f of facts.items)assert(questions.items.some(q=>q.fact_ids.includes(f.id)),f.id+' unreachable');
for(const a of answers.items){
 ref('facts',a.fact_id);assert(a.boundary_example&&a.negative_example&&a.standard_values.length>=2,a.id);
 for(const v of a.standard_values)assert(v.meaning&&v.training_paraphrases.length,a.id);
}
for(const s of services.items){
 ref('sources',s.source_id);assert(s.scope.length,s.id);
 for(const id of s.tariff_ids)ref('tariffs',id);for(const id of s.block_ids)ref('blocks',id);
}
const conflicts=new Set(tariffs.conflicts.map(c=>c.id));
for(const t of tariffs.items){
 ref('services',t.service_id);ref('sources',t.source.id);
 assert(['fixed','from','range','individual'].includes(t.price.type),t.id);
 if(['fixed','from'].includes(t.price.type))assert(Number.isFinite(t.price.amount)&&t.price.amount>=0,t.id);
 if(t.price.type==='range')assert(t.price.min<=t.price.max,t.id);
 if(t.price.type==='individual')assert.equal(t.price.amount,null,t.id);
 assert(t.price.unit&&t.price.billing_period&&t.conditions.length&&t.included.length&&t.not_stated.length,t.id);
 for(const id of t.conflicts)assert(conflicts.has(id),id);
 if(t.status!=='approved'||t.conflicts.some(id=>tariffs.conflicts.find(c=>c.id===id).status!=='resolved'))assert.equal(t.auto_selectable,false,t.id);
}
for(const c of tariffs.conflicts)for(const id of c.sources)ref('sources',id);
for(const c of cases.items){ref('sources',c.source_id);for(const id of c.block_ids)ref('blocks',id);assert.equal(c.visitor_forecast,false);}
for(const s of sources.items){
 const filename=path.resolve(root,s.local_path);assert(filename.startsWith(root),'Source path outside project');
 assert.equal(sha(fs.readFileSync(filename)),s.sha256,s.id+' changed; source review required');
}
const inventory=read('source-inventory.json');
assert.equal(sha(fs.readFileSync(path.join(root,'knowledge-base/index.json'))),inventory.index_sha256,'Inventory changed');
for(const f of faq.items)ref('prepared',f.prepared_answer_id);
for(const p of prepared.items)assert.equal(p.diagnostic,false);
for(const e of evaluation.items){ref('questions',e.question_id);for(const f of e.expected_facts)ref('facts',f.fact_id);}
const jokes=read('off-topic-jokes.json'),flatJokes=jokes.categories.flatMap(c=>c.jokes);
unique(jokes.categories.map(c=>c.id),'joke category');unique(flatJokes.map(j=>j.id),'joke id');unique(flatJokes.map(j=>j.text.trim()),'joke text');
assert.equal(flatJokes.length,jokes.joke_count);assert.equal(flatJokes.length,150);
for(const c of jokes.categories)assert(c.do_not_use_when&&c.hints.length&&c.selection_source,c.id);
assert(jokes.return_phrases.length&&jokes.neutral_replies.off_topic);
const scenario=read('scenario.json'),template=read('report-template.json');
assert.equal(scenario.clock.max_seconds,1500);assert.equal(scenario.clock.no_new_deep_branch_after,1320);assert.equal(scenario.clock.closing_from,1440);
assert.equal(scenario.closing.accepted_finish_text,'Спасибо за предоставленную информацию, сейчас вам предоставим отчёт предварительного аудита.');
for(const id of scenario.entry_questions)ref('questions',id);
assert.equal(scenario.phases.at(-1).terminal,true);unique(scenario.phases.map(p=>p.id),'phase');
for(let i=0;i<scenario.phases.length-1;i++)assert.equal(scenario.phases[i].next,scenario.phases[i+1].id,'Phase cycle');
assert.equal(template.rules.approved_blocks_only,true);assert.equal(template.rules.fixed_number_of_findings,null);
const byBlock=new Map(blocks.items.map(b=>[b.id,b]));let guards=0;
for(const c of checks.items){
 ref('blocks',c.block_id);for(const f of c.fact_fixture)schemaCheck(f,stateSchema.$defs.fact,c.id);
 const b=byBlock.get(c.block_id);
 assert.equal(evaluateBlock(b,factMap(c.fact_fixture),{preview:true}),c.expected,c.id);
 if(b.status!=='approved'||!b.reviewer||!b.approved_at){assert.equal(evaluateBlock(b,factMap(c.fact_fixture)),'inactive');guards++;}
}
const exampleIds=['analytics_sales','ux_checkout','support_backlog','ai_eval','market_sync','crm_capture'];
const examples=exampleIds.map(id=>{
 const fixture=checks.items.find(c=>c.id===id+'_positive'),result=buildReportPreview(blocks.items,fixture.fact_fixture,{libraryVersion:releaseVersion});
 schemaCheck(result,resultSchema,id+' report');return{id:'preview_'+id,synthetic:true,source_check:fixture.id,input_facts:fixture.fact_fixture,result};
});
const empty=buildReportPreview(blocks.items,[],{libraryVersion:releaseVersion});schemaCheck(empty,resultSchema,'empty report');
examples.push({id:'preview_no_evidence',synthetic:true,input_facts:[],result:empty});
const voice={schema_version:'1.0.0',version:releaseVersion,status:questions.status,purpose:'Сервер выбирает один блок; не передавать весь каталог агенту или браузеру.',blocks:domains.items.map(d=>({id:d.id,questions:questions.items.filter(q=>q.domain===d.id||q.id.startsWith(d.id+'_')).map(q=>({id:q.id,text:q.voice,fact_ids:q.fact_ids,answer_set:q.answer_set||null}))})),context:questions.items.filter(q=>q.phase==='orientation'||q.phase==='confirmation').map(q=>({id:q.id,text:q.voice,fact_ids:q.fact_ids}))};
const derived={'voice-question-blocks.json':voice,'prepared-answers-hash.json':{schema_version:'1.0.0',version:prepared.version,algorithm:'sha256-utf8',items:prepared.items.map(p=>({id:p.id,sha256:sha(p.text)}))},'report-examples.json':{schema_version:'1.0.0',version:releaseVersion,status:'draft',items:examples}};
for(const [n,v]of Object.entries(derived))if(write)save(n,v);else assert.deepEqual(read(n),v,n+' stale');
const editorial=new Set(['source-inventory.json','sources.json','rule-checks.json','evaluation-cases.json','report-examples.json']);
const names=fs.readdirSync(dir).filter(n=>n.endsWith('.json')&&!['library-manifest.json','validation-report.json'].includes(n)).sort();
const entries=names.map(name=>{const bytes=fs.readFileSync(path.join(dir,name));return{name,sha256:sha(bytes),bytes:bytes.length,role:editorial.has(name)?'editorial':'runtime_candidate'};});
const compact=entries.filter(e=>e.role==='runtime_candidate').map(e=>JSON.stringify(read(e.name))).join('\n');
const unapproved=blocks.items.filter(b=>b.status!=='approved'||!b.reviewer||!b.approved_at).length;
const pendingTariffs=tariffs.items.filter(t=>t.commercial_approval!=='approved').length;
const unresolved=tariffs.conflicts.filter(c=>c.status!=='resolved').length;
const blockers=[];
if(unapproved)blockers.push(unapproved+' ситуаций требуют экспертного утверждения.');
if(pendingTariffs||unresolved)blockers.push(pendingTariffs+' тарифов требуют коммерческого утверждения; не разрешено расхождений: '+unresolved+'.');
if(evaluation.measurement.achieved===null)blockers.push('Точность сопоставления не измерена на независимых диалогах с человеческой разметкой.');
if(!evaluation.measurement.real_audio_examples)blockers.push('Реальные аудиозаписи и длительность интервью ещё не проверены.');
const report={schema_version:'1.0.0',version:releaseVersion,structural_validation:'passed',rule_checks_passed:checks.items.length,draft_release_guards_passed:guards,
 counts:{situations:blocks.items.length,domains:domains.items.length,facts:facts.items.length,questions:questions.items.length,answer_sets:answers.items.length,services:services.items.length,normalized_tariffs:tariffs.items.length,sources:sources.items.length,inventory:inventory.items.length,jokes:flatJokes.length,authored_evaluation_cases:evaluation.items.length,report_examples:examples.length},
 size:{runtime_candidate_compact_bytes:Buffer.byteLength(compact),runtime_candidate_gzip_bytes:gzipSync(compact).length,note:'Размер JSON, не измеренный размер публикации Worker.'},
 release_ready:blockers.length===0,release_blockers:blockers,classifier_accuracy:evaluation.measurement.achieved,live_audio_tests_run:evaluation.measurement.real_audio_examples};
const previous=read('library-manifest.json');
const manifest={...previous,files:entries,counts:report.counts,release_ready:report.release_ready,release_blockers:blockers,
 validation_commands:['node scripts/verify-audit-content.mjs','node --test scripts/audit-rules.test.mjs','node scripts/build-audit-assets.mjs --check'],
 rebuild_command:'node scripts/verify-audit-content.mjs --write',release_gate_command:'node scripts/verify-audit-content.mjs --release',
 notes:['Утверждение диагностического содержания не заменяет отдельное коммерческое утверждение тарифов и проверки на независимых диалогах и реальном аудио.','Изменения источников требуют предметной проверки перед обновлением хешей.','Проверка содержания не публикует сайт и не подтверждает работу внешних сервисов.']};
if(args.has('--release')&&blockers.length)throw Error('Release blocked: '+blockers.join(' '));
if(write){save('validation-report.json',report);save('library-manifest.json',manifest);}
else{assert.deepEqual(read('library-manifest.json'),manifest,'Manifest stale');assert.deepEqual(read('validation-report.json'),report,'Validation report stale');}
console.log(JSON.stringify(report,null,2));

