import {runMySQL} from './mysql-judge.mjs';
import {bundledExecutable} from './runtime.mjs';
import {subquestionText} from '../worker/index.mjs';
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('./judge/run.py',import.meta.url));
export function validCases(cases){
  return Array.isArray(cases)&&cases.length<=12&&cases.every(c=>c&&
    [c.input===undefined?'':c.input,c.output].every(s=>typeof s==='string'&&Buffer.byteLength(s)<=8192));
}

export function casesFor(q){
  if(q.type!==5)return [];
  if(q.testCases!==undefined){
    if(!validCases(q.testCases))return [];
    if(q.testCases.length)return q.testCases.map(c=>({input:c.input??'',output:c.output}));
  }
  const pairs=[];
  let label=q.prompt,input;
  for(const block of q.codeBlocks??[]){
    const last=label.trim().split('\n').at(-1)?.replaceAll('*','').trim();
    if(/^(?:输入(?:示例|样例)|(?:示例|样例)输入)\s*\d*\s*[：:]?$/.test(last))input=block.code;
    else if(/^(?:预期输出|输出(?:示例|样例)|(?:示例|样例)输出)\s*\d*\s*[：:]?$/.test(last)){
      pairs.push({input:input??'',output:block.code});input=undefined;
    }
    label=block.followingText??'';
  }
  return validCases(pairs)?pairs:[];
}

export const judgeLanguages = ["Python", "JavaScript", "Java", "SQL"];

export async function judge(q,answer,options={}){
  const cases=casesFor(q);
  const code=answer?.parts?subquestionText(q,answer,false):typeof answer==='string'?answer:answer?.code??'';
  const language=answer?.language??q.defaultLanguage??'Python';
  if(!cases.length||!judgeLanguages.includes(language))return null;
  let details;
  if(!code.trim()||Buffer.byteLength(code)>65536){
    const status=code.trim()?'代码过长':'未作答';
    details=cases.map(()=>({status,actual:'',diagnostic:''}));
  }else if(language==='SQL'){
    details=process.env.EXAM_MYSQL_SOCKET?await runOnce(code,language,cases,options):await runMySQL(code,cases,options);
  }else if(language==='Java'){
    details=await runCases(code,language,cases);
  }else{
    details=[];
    for(const sample of cases)details.push(...await runCases(code,language,[sample]));
  }
  const results=details.map(row=>row.status);
  const passed=results.filter(status=>status==='通过').length;
  return {results,details,passed,score:Math.round(q.score*100*passed/results.length)/100};
}

async function runCases(code,language,cases){
  try{return await runOnce(code,language,cases)}
  catch(error){
    if(error.code!=='JUDGE_TIMEOUT')throw error;
    return runOnce(code,language,cases);
  }
}

function runOnce(code,language,cases,options={}){
  const remoteSocket=language==='SQL'?process.env.EXAM_MYSQL_SOCKET:language==='Java'?process.env.EXAM_JAVA_SOCKET:process.env.EXAM_WASI_SOCKET;
  if(remoteSocket){
    return new Promise((resolve,reject)=>{
      const socketPath=remoteSocket;
      const jobId=language==='SQL'?String(process.pid)+'-'+Date.now()+'-'+Math.random().toString(36).slice(2):undefined;
      let monitor,polling=false,ended=false;
      const req=request({socketPath,path:'/judge',method:'POST'},res=>{
        res.setEncoding('utf8');
        let body='';
        res.on('data',part=>{body+=part});
        res.on('error',reject);
        res.on('end',()=>{
          try{
            if(res.statusCode!==200)throw Object.assign(Error(language+' 判题服务暂时不可用 '+res.statusCode),{status:res.statusCode});
            const rows=JSON.parse(body);
            if(!Array.isArray(rows)||rows.length!==cases.length||!rows.every(row=>
              typeof row?.status==='string'&&typeof row.actual==='string'))throw Error(language+' 判题结果不完整');
            resolve(rows);
          }catch(error){reject(error)}
        });
      });
      req.setTimeout((language==='SQL'?240000:60000)+(language==='SQL'?12000:6000)*cases.length,()=>req.destroy(Error(language+' 判题服务响应超时')));
      req.on('error',reject);
      const abort=()=>req.destroy(Object.assign(Error('测试已取消'),{status:499}));
      if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
      if(jobId&&options.onState){
        options.onState({state:'queued',position:0});
        monitor=setInterval(()=>{
          if(polling)return;polling=true;
          const poll=request({socketPath,path:'/status?id='+encodeURIComponent(jobId)},res=>{let data='';res.on('data',part=>data+=part);res.on('end',()=>{polling=false;try{if(!ended&&res.statusCode===200)options.onState(JSON.parse(data))}catch{}});res.on('error',()=>polling=false)});
          poll.setTimeout(2000,()=>poll.destroy());poll.on('error',()=>polling=false);poll.end();
        },500);
      }
      req.on('close',()=>{ended=true;clearInterval(monitor);options.signal?.removeEventListener('abort',abort)});
      req.end(JSON.stringify({code,language,cases,id:jobId}));
    });
  }
  return new Promise((resolve,reject)=>{
    const child=spawn(bundledExecutable('EXAM_JUDGE_PYTHON',process.platform==='win32'?'python/python.exe':'python/bin/python3'),['-I',runner],
      {windowsHide:true,stdio:['pipe','pipe','pipe']});
    let timedOut=false;
    const watchdog=setTimeout(()=>{
      timedOut=true;
      child.kill('SIGKILL');
    },language==='Java'?50000+cases.length*6000:30000);
    let output='',diagnostic='';
    child.stdout.on('data',buf=>{output+=buf});
    child.stderr.on('data',buf=>{diagnostic=(diagnostic+buf).slice(-2000)});
    child.stdin.on('error',()=>{});
    child.on('error',reject);
    child.on('close',status=>{
      clearTimeout(watchdog);
      try{
        if(timedOut)throw Object.assign(Error('判题环境未及时返回结果'),{code:'JUDGE_TIMEOUT'});
        if(status!==0)throw Error('判题运行环境异常 '+diagnostic);
        const data=JSON.parse(output);
        if(!Array.isArray(data)||data.length!==cases.length || !data.every(row=>typeof row?.status==='string' && typeof row.actual==='string'))throw Error('判题结果不完整');
        resolve(data);
      }catch(error){reject(error)}
    });
    child.stdin.end(JSON.stringify({code,language,cases}));
  });
}
