// Validator for the JSON Schema subset used by the editorial and Worker schemas.
const supported=new Set(['$schema','$defs','$ref','title','description','type','const','enum','anyOf','required','properties','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','minimum','maximum']);
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export function validateSchema(value,schema,root=schema,path='$') {
  if(typeof schema==='boolean')return schema?[]:[path+': forbidden'];
  const errors=[];
  for(const key of Object.keys(schema))if(!supported.has(key))throw Error('Unsupported schema keyword: '+key);
  if(schema.$ref){
    const target=schema.$ref==='#'?root:schema.$ref.startsWith('#/')?schema.$ref.slice(2).split('/').reduce((a,k)=>a?.[k.replaceAll('~1','/').replaceAll('~0','~')],root):undefined;
    if(target===undefined)throw Error('Unresolved schema reference: '+schema.$ref);
    errors.push(...validateSchema(value,target,root,path));
  }
  if(schema.anyOf && !schema.anyOf.some(s=>validateSchema(value,s,root,path).length===0))errors.push(path+': no allowed shape');
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(schema.type && !(Array.isArray(schema.type)?schema.type:[schema.type]).some(t=>t===type || t==='integer'&&type==='number'&&Number.isInteger(value)))return [...errors,path+': expected '+schema.type+', got '+type];
  if('const' in schema && canonical(value)!==canonical(schema.const))errors.push(path+': const mismatch');
  if(schema.enum && !schema.enum.some(v=>canonical(v)===canonical(value)))errors.push(path+': value outside enum');
  if(type==='object'){
    for(const k of schema.required||[])if(!Object.hasOwn(value,k))errors.push(path+'.'+k+': missing');
    for(const [k,v]of Object.entries(value)){
      if(schema.properties && Object.hasOwn(schema.properties,k))errors.push(...validateSchema(v,schema.properties[k],root,path+'.'+k));
      else if(schema.additionalProperties===false)errors.push(path+'.'+k+': unexpected');
      else if(schema.additionalProperties && typeof schema.additionalProperties==='object')errors.push(...validateSchema(v,schema.additionalProperties,root,path+'.'+k));
    }
  }
  if(type==='array'){
    if(schema.minItems!==undefined && value.length<schema.minItems)errors.push(path+': too few items');
    if(schema.maxItems!==undefined && value.length>schema.maxItems)errors.push(path+': too many items');
    if(schema.uniqueItems && new Set(value.map(canonical)).size!==value.length)errors.push(path+': duplicate items');
    if(schema.items)value.forEach((v,i)=>errors.push(...validateSchema(v,schema.items,root,path+'['+i+']')));
  }
  if(type==='string'){
    const length=Array.from(value).length;
    if(schema.minLength!==undefined && length<schema.minLength)errors.push(path+': too short');
    if(schema.maxLength!==undefined && length>schema.maxLength)errors.push(path+': too long');
  }
  if(type==='number'){
    if(!Number.isFinite(value))errors.push(path+': non-finite number');
    if(schema.minimum!==undefined && value<schema.minimum)errors.push(path+': below minimum');
    if(schema.maximum!==undefined && value>schema.maximum)errors.push(path+': above maximum');
  }
  return errors;
}

