// Card numbers follow the original paper order, including across question types.
export function makeAnswerCard(questions,answers){
  const card={};
  for(const [index,q] of questions.entries()){
    const value=answers[index];
    let entry=value??null;
    if(value!=null){
      if(q.type===0)entry=String.fromCharCode(65+value);
      if(q.type===1)entry=[...value].sort((a,b)=>a-b).map(i=>String.fromCharCode(65+i)).join('');
      if(q.type===2)entry=value===0?'T':'F';
      if(q.type===5&&typeof value==='object'&&!value.parts)entry={language:value.language,code:value.code};
    }
    card[index+1]=entry;
  }
  return card;
}

export function readAnswerCard(questions,card){
  if(!card||typeof card!=='object'||Array.isArray(card)||Object.keys(card).length!==questions.length)return null;
  const answers=[];
  for(const [i,q] of questions.entries()){
    if(!Object.hasOwn(card,i+1))return null;
    const v=card[i+1];
    if(v==null){answers.push(null);continue}
    if(q.type===0||q.type===1){
      if(typeof v!=='string'||!(q.type===0?/^[A-Z]$/:/^[A-Z]*$/).test(v))return null;
      const indices=Array.from(v,c=>c.charCodeAt(0)-65);
      answers.push(q.type===0?indices[0]:indices);
    }else if(q.type===2){
      if(v!=='T'&&v!=='F')return null;
      answers.push(v==='T'?0:1);
    }else answers.push(v);
  }
  return answers;
}
