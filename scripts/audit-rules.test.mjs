import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluateCondition,evaluateBlock,acceptRecord,questionDecision,tariffEligible,buildReportPreview,factMap} from '../worker/src/audit/rules.mjs';
import {validateSchema} from './audit-schema.mjs';
const dir=new URL('../worker/src/audit/data/',import.meta.url);
const read=n=>JSON.parse(fs.readFileSync(new URL(n,dir),'utf8'));
const blocks=read('bottlenecks.json').items,checks=read('rule-checks.json').items;
const f=(id,value,state='known',extra={})=>({fact_id:id,state,value,source_turn_ids:['turn-1'],observed_at:'2026-10-22T12:00:00Z',origin:'visitor',confirmation:'confirmed',...extra});
const initial=()=>({audit_session_id:'synthetic',library_version:read('library-manifest.json').library_version,channel:'chat',elapsed_seconds:0,status:'active',facts:[],history:[],asked_question_ids:[]});
test('unknown is not false, including under not',()=>{
 assert.equal(evaluateCondition({not:{fact:'x',op:'eq',value:true}},{}),null);
 assert.equal(evaluateCondition({fact:'x',op:'eq',value:false},{x:f('x',false)}),true);
 for(const state of ['unknown','not_measured','not_applicable','declined','ambiguous','other','not_asked','conflicting'])
 assert.equal(evaluateCondition({fact:'x',op:'eq',value:false},{x:f('x',null,state)}),null,state);
});
test('all and any preserve three-valued logic',()=>{
 const yes={fact:'x',op:'eq',value:true},absent={fact:'missing',op:'eq',value:true},no={fact:'x',op:'eq',value:false},m={x:f('x',true)};
 assert.equal(evaluateCondition({all:[yes,absent]},m),null);
 assert.equal(evaluateCondition({all:[no,absent]},m),false);
 assert.equal(evaluateCondition({any:[yes,absent]},m),true);
 assert.equal(evaluateCondition({any:[no,absent]},m),null);
});
test('missing provenance and unconfirmed facts never satisfy a condition',()=>{
 const rule={fact:'x',op:'eq',value:true};
 for(const extra of [{confirmation:'pending'},{origin:'model'},{source_turn_ids:[]},{source_turn_ids:[5]},{observed_at:'invented date'}])
 assert.equal(evaluateCondition(rule,{x:f('x',true,'known',extra)}),null);
});
test('numeric thresholds require matching dimensions and definite values',()=>{
 const rule={fact:'x',op:'gte',value:30,unit:'hour',period:'month'};
 assert.equal(evaluateCondition(rule,{x:f('x',30,'known',{parameters:{unit:'hour',period:'month',approximate:false}})}),true);
 assert.equal(evaluateCondition(rule,{x:f('x',29,'known',{parameters:{unit:'hour',period:'month',approximate:false}})}),false);
 for(const parameters of [{unit:'RUB',period:'month'},{unit:'hour',period:'six_months'},{unit:'hour',period:'month',min:20,max:40},{unit:'hour',period:'month',approximate:true}])
 assert.equal(evaluateCondition(rule,{x:f('x',30,'known',{parameters})}),null);
});
test('unknown condition operations are rejected',()=>{
 assert.throws(()=>evaluateCondition({fact:'x',op:'execute',value:'anything'},{}),/Unsupported/);
 const schema=read('conditions.schema.json');
 assert(validateSchema({fact:'context.budget',op:'execute',value:'anything'},schema).length>0);
 assert(validateSchema({all:[]},schema).length>0);
});
test('explicit correction preserves original event and is idempotent',()=>{
 const a=acceptRecord(initial(),f('context.scale',20),{eventId:'1'});
 const b=acceptRecord(a,f('context.scale',30),{eventId:'2',explicitCorrection:true});
 assert.equal(b.facts[0].value,30);assert.equal(b.facts[0].confirmation,'corrected');
 assert.equal(b.history[0].record.value,20);assert.equal(b.history.length,2);
 assert.deepEqual(acceptRecord(b,f('context.scale',999),{eventId:'2',explicitCorrection:true}),b);
 assert.equal(a.facts[0].value,20);
});
test('unexplained contradiction is not resolved by last value',()=>{
 const a=acceptRecord(initial(),f('context.scale',20),{eventId:'1'});
 const b=acceptRecord(a,f('context.scale',30),{eventId:'2'});
 assert.equal(b.facts[0].state,'conflicting');assert.equal(b.facts[0].value,null);
 const c=acceptRecord(b,f('context.scale',40),{eventId:'3'});
 assert.equal(c.facts[0].state,'conflicting');
 const d=acceptRecord(c,f('context.scale',30),{eventId:'4',explicitCorrection:true});
 assert.equal(d.facts[0].value,30);assert.equal(d.history.length,4);
});
test('new known information may resolve a previous explicit unknown',()=>{
 const a=acceptRecord(initial(),f('context.scale',null,'unknown'),{eventId:'1'});
 const b=acceptRecord(a,f('context.scale',30),{eventId:'2'});
 assert.equal(b.facts[0].state,'known');assert.equal(b.facts[0].value,30);
});
test('channel transfer preserves facts and does not reset time',()=>{
 const a=acceptRecord({...initial(),elapsed_seconds:730},f('context.goal','Reduce manual work'),{eventId:'1'});
 const voice={...a,channel:'voice'};
 assert.deepEqual(voice.facts,a.facts);
 assert.equal(questionDecision({elapsedSeconds:voice.elapsed_seconds,newDeepBranch:true}),'finish_current_branch');
});
test('time limits include exact 12, 14 and 15 minute boundaries',()=>{
 assert.equal(questionDecision({elapsedSeconds:719,newDeepBranch:true}),'ask');
 assert.equal(questionDecision({elapsedSeconds:720,newDeepBranch:true}),'finish_current_branch');
 assert.equal(questionDecision({elapsedSeconds:839}),'ask');
 assert.equal(questionDecision({elapsedSeconds:840}),'confirm_and_close');
 assert.equal(questionDecision({elapsedSeconds:900}),'close');
 assert.equal(questionDecision({elapsedSeconds:10,stopRequested:true}),'close');
});
test('known, declined and clarified questions have an exit',()=>{
 assert.equal(questionDecision({elapsedSeconds:100,answered:true}),'skip');
 assert.equal(questionDecision({elapsedSeconds:100,declined:true}),'skip');
 assert.equal(questionDecision({elapsedSeconds:100,clarifications:1}),'record_uncertainty_and_continue');
});
test('draft content and unresolved tariff conflicts cannot be issued automatically',()=>{
 const b=blocks.find(b=>b.id==='analytics_sales'),fixture=checks.find(c=>c.id==='analytics_sales_positive');
 assert.equal(evaluateBlock({...b,status:'draft',reviewer:null,approved_at:null},factMap(fixture.fact_fixture)),'inactive');
 const original=read('tariffs.json').items.find(t=>t.id==='support_deposit_30');
 assert.equal(tariffEligible(original,{scopeConfirmed:true}),false);
 const approved={...original,status:'approved',reviewer:'test-only',approved_at:'test-only',commercial_approval:'approved',auto_selectable:true,conflicts:['synthetic_unresolved_conflict']};
 assert.equal(tariffEligible(approved,{scopeConfirmed:true}),false);
 assert.equal(tariffEligible(approved,{scopeConfirmed:true,resolvedConflictIds:approved.conflicts}),true);
 assert.equal(tariffEligible(approved,{resolvedConflictIds:approved.conflicts}),false);
});
test('deposit is a package; postpayment is an hourly rate',()=>{
 const ts=read('tariffs.json').items;
 const d=ts.find(t=>t.id==='support_deposit_100'),p=ts.find(t=>t.id==='support_postpaid');
 assert.equal(d.price.amount,270000);assert.equal(d.price.billing_period,'not_monthly');
 assert.equal(d.limits.hours,100);assert.equal(d.limits.use_within_months,6);
 assert.equal(p.price.amount,3800);assert.equal(p.price.unit,'hour');
 assert.equal(p.price.billing_period,'monthly_in_arrears');
});
test('unknown facts produce no invented conclusion or price',()=>{
 const out=buildReportPreview(blocks,[f('analytics_sales.signal',null,'unknown')],{libraryVersion:read('library-manifest.json').library_version});
 assert.equal(out.findings.length,0);assert.equal(out.tariff_ids.length,0);assert.equal(out.gaps.length,1);
 assert.match(out.conclusion,/главное ограничение пока не установлено/);
 assert.equal(validateSchema(out,read('audit-result.schema.json')).length,0);
});
test('two independent observations remain two findings',()=>{
 const fixture=['analytics_sales_positive','ux_checkout_positive'].flatMap(id=>checks.find(c=>c.id===id).fact_fixture);
 const out=buildReportPreview(blocks,fixture);
 assert.deepEqual(out.findings.map(f=>f.block_id),['analytics_sales','ux_checkout']);
 assert(out.findings.every(f=>f.readiness==='check_only'));
 assert(out.findings.every(f=>f.evidence_level==='visitor_report'));
});
test('past failure or unknown history prevents a blind restart',()=>{
 const fixture=checks.find(c=>c.id==='ads_restart_positive').fact_fixture;
 const resources=f('context.resources','Named owner is available');
 for(const history of [undefined,f('advertising.history',{attempts_status:'unknown'}),f('advertising.history',{attempts_status:'tried',attempts:[{outcome:{state:'known',value:'Failed'}}]})]){
 const out=buildReportPreview(blocks,[...fixture,resources,...(history?[history]:[])]);
 assert.equal(out.findings[0].readiness,'check_only');
 assert.match(out.findings[0].actions[0],/Перезапуск работ пока не обоснован/);
 }
});
test('explicit absence of prior attempts allows scoping, not a guaranteed result',()=>{
 const fixture=checks.find(c=>c.id==='analytics_sales_positive').fact_fixture;
 const out=buildReportPreview(blocks,[...fixture,f('analytics.history',{attempts_status:'not_tried',attempts:[]}),f('context.resources','Responsible employee available')]);
 assert.equal(out.findings[0].readiness,'ready_for_scoping');
 // The approved order of work: 4–6 steps per problem, the same in the preview as in the library.
 assert.deepEqual(out.findings[0].actions,blocks.find(b=>b.id==='analytics_sales').solution.steps.map(s=>s.text));assert(out.findings[0].actions.length>=4);
 assert.equal(out.tariff_ids.length,0);assert.equal(out.preview,true);
 assert.throws(()=>buildReportPreview(blocks,[],{preview:false}),/editorial previews only/);
});
test('state schema accepts a normal session and rejects foreign fields and unknown IDs',()=>{
 const state=acceptRecord(initial(),f('context.goal','Reduce manual work'),{eventId:'1'});
 const schema=read('audit-state.schema.json');assert.equal(validateSchema(state,schema).length,0);
 assert(validateSchema({...state,password:'not allowed'},schema).length>0);
 assert(validateSchema({...state,facts:[f('invented.fact',true)]},schema).length>0);
});

