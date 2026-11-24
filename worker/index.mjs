const teacherMarkup = /<!-- admin-only -->[\s\S]*?<!-- \/admin-only -->/g;
const teacherScript = /\/\* admin-only \*\/[\s\S]*?\/\* \/admin-only \*\//g;
const studentStart = /\/\* user-only \*\/[\s\S]*?\/\* \/user-only \*\//g;

export function subquestionNumbers(q){
  if(q.type!==4&&q.type!==5)return [];
  const numbers=new Set();
  for(const text of [q.prompt||'',...(q.codeBlocks??[]).map(b=>b.followingText||'')]){
    for(const match of text.matchAll(/^[ \t]*[（(]([1-9]\d{0,8})[)）]/gm))numbers.add(match[1]);
  }
  return [...numbers];
}

export function subquestionParts(numbers,value){
  if(value?.parts)return value.parts;
  const text=typeof value==='string'?value:value?.code||'';
  const marks=[...text.matchAll(/^[（(]([1-9]\d{0,8})[)）]/gm)].filter(m=>numbers.includes(m[1]));
  if(!marks.length)return numbers.length?{[numbers[0]]:text}:{};
  const parts={};
  for(const [i,m] of marks.entries()){
    const body=text.slice(m.index+m[0].length,marks[i+1]?marks[i+1].index-1:undefined).replace(/^(?: |\r?\n)/,'');
    parts[m[1]]=parts[m[1]]?parts[m[1]]+'\n'+body:body;
  }
  if(marks[0].index)parts[numbers[0]]=text.slice(0,marks[0].index)+(parts[numbers[0]]||'');
  return parts;
}

export function subquestionText(q,value,numbered=true){
  return subquestionNumbers(q).map(n=>numbered?'('+n+')\n'+(value.parts[n]||''):value.parts[n]||'').join('\n');
}

export function validQuestionTables(q){
 return q.tables===undefined||Array.isArray(q.tables)&&q.tables.length<=10&&q.tables.every(table=>Array.isArray(table)&&table.length>0&&table.length<=50&&Array.isArray(table[0])&&table[0].length>0&&table[0].length<=20&&table.every(row=>Array.isArray(row)&&row.length===table[0].length&&row.every(cell=>typeof cell==='string'&&cell.length<=8192)));
}
export function questionBlankCount(q){
  const prose=[q.prompt||'',...(q.codeBlocks??[]).map(b=>b.followingText||'')];
  const textCount=prose.reduce((n,text)=>n+(text.match(/_{3,}/g)||[]).length,0);
  return textCount+(q.codeBlocks??[]).reduce((n,b)=>n+(b.code.match(/〔填空〕|(?<![\p{L}\p{N}_])_{3,}(?![\p{L}\p{N}_])/gu)||[]).length,0);
}

export function blankMarker(n){
  if(n<=20)return String.fromCodePoint(0x2460+n-1);
  if(n<=35)return String.fromCodePoint(0x3251+n-21);
  if(n<=50)return String.fromCodePoint(0x32b1+n-36);
  return '（'+n+'）';
}

export function formatBlanks(parts){
  if(parts.length<=1)return parts[0]??'';
  return parts.map((part,i)=>blankMarker(i+1)+' '+part).join('  ');
}

export function splitBlanks(text,count){
  const value=text.trim();
  if(count===1)return [value];
  if(!value.startsWith('①'))return value.split('|').map(s=>s.trim());
  const parts=[];
  let offset=1;
  for(let i=2;i<=count;i++){
    const marker=blankMarker(i),next=value.indexOf(marker,offset);
    if(next<0)break;
    parts.push(value.slice(offset,next).trim());
    offset=next+marker.length;
  }
  parts.push(value.slice(offset).trim());
  return parts;
}

function identify(request, env) {
  // Sites Dispatch supplies these identity headers after sign-in.
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!id || !email) return null;
  const admins = (env.EXAM_ADMIN_EMAILS ?? '').toLowerCase().split(',').map(value => value.trim());
  return { id, name: email, role: admins.includes(email) ? 'teacher' : 'student' };
}

export function renderAccountIdentity(template, account) {
  const name = String(account.display_name?.trim() || account.name || account.id).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const reminder=account.role==='teacher'
    ? '<label class="grading-toggle publish-reminder"><input id="publish-reminder" type="checkbox" role="switch" checked data-account="'+encodeURIComponent(account.name||account.id)+'"><span class="settings-label"><svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h4l3-7 5 14 3-7h5"/></svg>发布前提醒</span><span class="theme-switch" aria-hidden="true"></span></label>'
    : '';
  return template.replace('<!-- publish-reminder -->',()=>reminder).replace('<!-- account-role -->',account.role === 'teacher' ? '教师' : '学生')
    .replace('<!-- account-name -->',()=>name);
}

async function renderExam(examTemplate, account, initialView) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account.id));
  const accountKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const page = account.role === 'teacher'
    ? examTemplate.replace(studentStart, '')
    : examTemplate.replace(teacherMarkup, '').replace(teacherScript, '');
  return renderAccountIdentity(page, account).replace('/* account-context */',
    [validQuestionTables,questionBlankCount,blankMarker,formatBlanks,splitBlanks,subquestionNumbers,subquestionParts,subquestionText].map(fn=>fn.toString()).join('\n')+'\n'+
    'const storagePrefix = ' + JSON.stringify('exam:' + accountKey + ':') + ';\n' +
    'const initialView = ' + JSON.stringify(initialView) + ';');
}

export function createExamWorker(examTemplate, {
  styles = {},
  identifyAccount = identify,
  loginPath = '/signin-with-chatgpt?return_to=%2F'
} = {}) {
  return { async fetch(request, env = {}) {
    const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/plain; charset=utf-8' };
    const path = new URL(request.url).pathname;
    if (Object.hasOwn(styles,path)) {
      if (request.method !== 'GET') return new Response(null, { status:405, headers:{Allow:'GET'} });
      const type=path==='/favicon.svg'?'image/svg+xml':'text/css';
      return new Response(styles[path], { headers:{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-cache'} });
    }
    if (path !== '/' && path !== '/teacher') {
      return new Response('页面不存在。', { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return new Response('请求方法无效。', { status: 405, headers: { ...headers, Allow: 'GET' } });
    }
    const account = await identifyAccount(request, env);
    if (!account) {
      return new Response(null, { status: 302, headers: { ...headers, Location: loginPath } });
    }
    if (path === '/teacher' && account.role !== 'teacher') {
      return new Response('仅管理员可以访问教师组卷。', { status: 403, headers });
    }
    const page = await renderExam(examTemplate, account, path === '/teacher' ? 'teacher' : 'student');
    return new Response(page, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
  } };
}
