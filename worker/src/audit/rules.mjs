// Deterministic content checks and report previews. No network, database or model calls.
export const UNKNOWN = null;
const has = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function factMap(records) { return Object.fromEntries(records.map(r => [r.fact_id,r])); }
function witnessed(f) {
  return !!f && f.origin === 'visitor' && Array.isArray(f.source_turn_ids) &&
    f.source_turn_ids.length > 0 && f.source_turn_ids.every(id=>typeof id==='string' && id.length>0) &&
    typeof f.observed_at === 'string' && Number.isFinite(Date.parse(f.observed_at)) &&
    ['confirmed','corrected'].includes(f.confirmation);
}
export function known(f) { return witnessed(f) && f.state === 'known' && f.value !== null && f.value !== undefined; }
export function evaluateCondition(rule, facts) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw Error('Invalid condition');
  if (has(rule,'all')) {
    if (!Array.isArray(rule.all) || !rule.all.length) throw Error('Empty all');
    const values = rule.all.map(r => evaluateCondition(r,facts));
    return values.includes(false) ? false : values.includes(null) ? null : true;
  }
  if (has(rule,'any')) {
    if (!Array.isArray(rule.any) || !rule.any.length) throw Error('Empty any');
    const values = rule.any.map(r => evaluateCondition(r,facts));
    return values.includes(true) ? true : values.includes(null) ? null : false;
  }
  if (has(rule,'not')) { const value=evaluateCondition(rule.not,facts); return value===null?null:!value; }
  const f=facts[rule.fact];
  if (rule.op === 'state') return witnessed(f) ? f.state===rule.value : null;
  if (!['eq','fields_known','lt','lte','gt','gte'].includes(rule.op)) throw Error('Unsupported operation: '+rule.op);
  if (!known(f)) return null;
  if (rule.op==='eq') return same(f.value,rule.value);
  if (rule.op==='fields_known') {
    if (!Array.isArray(rule.fields) || !rule.fields.length) throw Error('Missing fields');
    if (typeof f.value!=='object' || Array.isArray(f.value)) return null;
    return rule.fields.every(k => {
      const field=f.value[k];
      return field && field.state==='known' && field.value!==null && field.value!==undefined &&
        (typeof field.value!=='string' || field.value.trim().length>0);
    }) ? true : null;
  }
  const p=f.parameters;
  if (!p || p.unit!==rule.unit || !same(p.period,rule.period)) return null;
  // Ranges cannot be silently reduced to a midpoint. A boundary needs a definite quantity.
  if (typeof f.value!=='number' || !Number.isFinite(f.value) || p.min!=null || p.max!=null || p.approximate) return null;
  if (typeof rule.value!=='number' || !Number.isFinite(rule.value)) throw Error('Invalid numeric operand');
  return {lt:f.value<rule.value,lte:f.value<=rule.value,gt:f.value>rule.value,gte:f.value>=rule.value}[rule.op];
}
export function evaluateBlock(block, facts, {preview=false}={}) {
  if (!preview && (!block.approved_at || !block.reviewer || block.status!=='approved')) return 'inactive';
  if (evaluateCondition(block.exclusion,facts)===true) return 'excluded';
  const included=evaluateCondition(block.inclusion,facts);
  return included===true?'eligible':included===false?'not_selected':'needs_info';
}
export function acceptRecord(state, record, {eventId, explicitCorrection=false}={}) {
  if (!eventId) throw Error('Event ID required');
  if (state.history.some(e=>e.event_id===eventId)) return state; // replay is idempotent
  const next=structuredClone(state), index=next.facts.findIndex(f=>f.fact_id===record.fact_id), previous=next.facts[index];
  if (!record.source_turn_ids?.length || record.origin!=='visitor') throw Error('Visitor evidence required');
  let current=structuredClone(record), type=explicitCorrection?'correction':'answer';
  const previousSubstantive=previous && ['known','other','not_measured','not_applicable','conflicting'].includes(previous.state);
  const incomingSubstantive=['known','other','not_measured','not_applicable'].includes(record.state);
  if (previousSubstantive && incomingSubstantive && !explicitCorrection && (previous.state!==record.state || !same(previous.value,record.value) || !same(previous.parameters,record.parameters))) {
    current={...current,state:'conflicting',value:null,confirmation:'pending'};
    type='contradiction';
  } else if (explicitCorrection) current.confirmation='corrected';
  if(index<0)next.facts.push(current);else next.facts[index]=current;
  next.history.push({event_id:eventId,type,record:structuredClone(record)});
  return next;
}
export function questionDecision({elapsedSeconds,stopRequested=false,newDeepBranch=false,answered=false,declined=false,clarifications=0}) {
  if (stopRequested || elapsedSeconds>=900) return 'close';
  if (elapsedSeconds>=840) return 'confirm_and_close';
  if (answered || declined) return 'skip';
  if (newDeepBranch && elapsedSeconds>=720) return 'finish_current_branch';
  if (clarifications>=1) return 'record_uncertainty_and_continue';
  return 'ask';
}
const historyFields=['work','period_and_duration','goal','executor_and_resources','outcome','measurement','current_status','stop_reason'];
export function solutionReadiness(block,facts) {
  const history=facts[block.domain+'.history'], resources=facts['context.resources'];
  if (!known(history) || !known(resources)) return 'check_only';
  const h=history.value;
  if (h.attempts_status==='not_tried') return 'ready_for_scoping';
  if (h.attempts_status!=='tried' || !Array.isArray(h.attempts) || !h.attempts.length) return 'check_only';
  // Previous work never authorizes a blind restart. A reviewer must resolve its applicability.
  return 'check_only';
}
function plain(value) {
  if(value===null || value===undefined)return 'неизвестно';
  if(typeof value==='string')return value;
  if(typeof value==='object' && !Array.isArray(value))return Object.entries(value).map(([k,v])=>k+': '+(v?.state&&v.state!=='known'?v.state:plain(v?.value??v))).join('; ');
  return JSON.stringify(value);
}
export function tariffEligible(tariff, {scopeConfirmed=false,resolvedConflictIds=[]}={}) {
  return tariff.status==='approved' && !!tariff.reviewer && !!tariff.approved_at &&
    tariff.commercial_approval==='approved' && tariff.auto_selectable===true && scopeConfirmed &&
    !tariff.conflicts.some(id=>!resolvedConflictIds.includes(id));
}
export function buildReportPreview(blocks,records,{preview=true,libraryVersion='0.1.0'}={}) {
  if (!preview) throw Error('This function creates editorial previews only; live issuance requires the architecture implementation.');
  const facts=factMap(records),findings=[],gaps=[];
  for(const b of blocks){
    // Never list every unasked branch as a detected problem.
    if(!has(facts,b.id+'.signal'))continue;
    const verdict=evaluateBlock(b,facts,{preview:true});
    if(verdict==='needs_info'){gaps.push({block_id:b.id,reason:b.pdf.missing_data});continue;}
    if(verdict!=='eligible')continue;
    const readiness=solutionReadiness(b,facts),impact=facts[b.domain+'.impact'];
    const level=known(impact)?impact.value.level:'unknown';
    findings.push({block_id:b.id,type:b.type,evidence_level:'visitor_report',
      priority:({stops_operation:'high',loss_or_delay:'normal',limited:'low',no_effect:'low'})[level]||'unknown',
      basis:plain(facts[b.id+'.details'].value),history:plain(facts[b.domain+'.history']?.value),
      interpretation:b.pdf.interpretation,readiness,
      actions:readiness==='ready_for_scoping'?b.pdf.next_steps:[b.pdf.blocked_recommendation],
      deliverable:b.pdf.deliverable,limitations:b.solution.limitations,source_ids:b.sources.map(s=>s.source_id)});
  }
  return {title:'ПРЕДВАРИТЕЛЬНЫЙ АУДИТ',library_version:libraryVersion,preview:true,
    limitations:['Редакторский пример; не предназначен для выдачи посетителю.','Сведения со слов посетителя; самостоятельная проверка систем не проводилась.'],
    findings,gaps,tariff_ids:[],conclusion:findings.length?'Выбранные ситуации требуют указанных проверок.':'По полученным сведениям главное ограничение пока не установлено.'};
}

