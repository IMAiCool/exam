import {inspectStudentSQL} from './sql-policy.mjs';
import {bundledExecutable} from './runtime.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
// Resolve lazily: remote workers and non-SQL judging do not need these binaries.
const mysql=()=>bundledExecutable('EXAM_MYSQL_CLIENT',process.platform==='win32'?'mysql/bin/mysql.exe':'mysql/bin/mysql');
const mysqld=()=>bundledExecutable('EXAM_MYSQL_SERVER',process.platform==='win32'?'mysql/bin/mysqld.exe':'mysql/bin/mysqld');
const setting=(name,value,min,max)=>{const n=Number(process.env[name]??value);return Number.isInteger(n)&&n>=min&&n<=max?n:value};
const size=setting('EXAM_MYSQL_POOL_SIZE',1,1,3),queueLimit=setting('EXAM_MYSQL_QUEUE_LIMIT',32,1,100),waitMs=setting('EXAM_MYSQL_QUEUE_TIMEOUT_MS',60000,1000,300000),taskMs=setting('EXAM_MYSQL_TASK_TIMEOUT_MS',90000,1000,180000);
const slots=Array.from({length:size},()=>({instance:null,starting:null,busy:false,job:null,done:null})),queue=[];
let closing=false;
const failure=(message,status=503)=>Object.assign(new Error(message),{status});
const normalize=text=>text.replace(/\r\n/g,'\n').trimEnd();
async function port(){const server=createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value}
function query(instance,user,password,sql,database,signal){
 const args=['--no-defaults','--protocol=TCP','--host=127.0.0.1','--port='+instance.port,'--user='+user,'--batch','--raw','--skip-column-names','--binary-mode','--local-infile=0','--default-character-set=utf8mb4',...(database?['--database='+database]:[])];
 return new Promise((resolve,reject)=>{const child=execFile(mysql(),args,{windowsHide:true,timeout:6000,maxBuffer:1024*1024,signal,env:{...process.env,MYSQL_PWD:password}},(error,stdout,stderr)=>{if(error){error.diagnostic=stderr;reject(error)}else resolve(stdout)});child.stdin.on('error',()=>{});child.stdin.end(sql+'\n')});
}
const admin=(instance,sql,signal)=>query(instance,'root',instance.secret,sql,undefined,signal);
async function destroy(instance){
 if(!instance)return;
 if(instance.verified)try{await admin(instance,'SHUTDOWN;')}catch{}
 if(instance.server&&instance.server.exitCode===null&&instance.server.signalCode===null){instance.server.kill('SIGKILL');await Promise.race([instance.closed,new Promise(resolve=>setTimeout(resolve,3000))])}
 instance.watchdog?.kill();
 await rm(instance.directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
async function createInstance(){
 const instance={directory:await mkdtemp(join(tmpdir(),'exam-mysql-')),secret:''};const data=join(instance.directory,'data');
 try{
  await mkdir(data);await execute(mysqld(),['--no-defaults',...(process.platform==='win32'?['--no-monitor']:[]),'--initialize-insecure','--datadir='+data],{windowsHide:true,timeout:60000,maxBuffer:1024*1024});instance.port=await port();
  instance.server=spawn(mysqld(),['--no-defaults',...(process.platform==='win32'?['--no-monitor']:[]),'--datadir='+data,'--pid-file='+join(instance.directory,'mysql.pid'),...(process.platform==='win32'?[]:['--socket='+join(instance.directory,'mysql.sock')]),'--port='+instance.port,'--bind-address=127.0.0.1','--character-set-server=utf8mb4','--collation-server=utf8mb4_0900_ai_ci','--mysqlx=OFF','--local-infile=OFF','--secure-file-priv=NULL','--event-scheduler=OFF','--max-connections=10','--innodb-buffer-pool-size=32M','--performance-schema=OFF'],{windowsHide:true,stdio:'ignore'});
  let spawnError;instance.server.on('error',e=>spawnError=e);instance.closed=new Promise(resolve=>instance.server.once('close',resolve));
  instance.watchdog=spawn(process.execPath,[fileURLToPath(new URL('./mysql-watchdog.mjs',import.meta.url)),String(process.pid),String(instance.server.pid||0),instance.directory],{windowsHide:true,detached:true,stdio:['ignore','ignore','ignore','ipc']});instance.watchdog.on('error',()=>{});instance.watchdog.send({port:instance.port,mysql:mysql(),secret:''});instance.watchdog.unref();instance.watchdog.channel?.unref();
  let ready=false;const readyUntil=Date.now()+30000;for(let i=0;i<150&&Date.now()<readyUntil;i++){if(spawnError)throw spawnError;if(instance.server.exitCode!==null||instance.server.signalCode!==null)throw failure('MySQL 实例启动失败');try{const reported=(await admin(instance,'SELECT @@datadir;')).trim();const canonical=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);if(canonical(reported)!==canonical(data))throw failure('MySQL 实例目录不匹配');instance.verified=true;ready=true;break}catch{await new Promise(r=>setTimeout(r,100))}}
  if(!ready)throw failure('MySQL 实例启动超时');const secret=randomBytes(24).toString('hex');instance.watchdog.send({port:instance.port,mysql:mysql(),secret});await admin(instance,"ALTER USER 'root'@'localhost' IDENTIFIED BY '"+secret+"';");instance.secret=secret;await admin(instance,'SELECT 1;');return instance;
 }catch(error){await destroy(instance);throw error}
}
async function ensure(slot){
 if(slot.instance&&(slot.instance.server.exitCode!==null||slot.instance.server.signalCode!==null)){const old=slot.instance;slot.instance=null;await destroy(old)}
 if(!slot.instance){if(!slot.starting)slot.starting=createInstance().then(i=>slot.instance=i).finally(()=>slot.starting=null);await slot.starting}
 return slot.instance;
}
async function reset(instance,signal){
 const ids=(await admin(instance,"SELECT ID FROM information_schema.PROCESSLIST WHERE USER='exam_student';",signal)).trim().split(/\s+/).filter(id=>/^\d+$/.test(id));
 for(const id of ids)try{await admin(instance,'KILL CONNECTION '+id+';',signal)}catch(error){if(signal?.aborted)throw error;/* It may already have disconnected. */}
 await admin(instance,"DROP DATABASE IF EXISTS exam_db; DROP USER IF EXISTS 'exam_student'@'127.0.0.1';",signal);
 const count=await admin(instance,"SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='exam_db')+(SELECT COUNT(*) FROM mysql.user WHERE User='exam_student');",signal);
 if(count.trim()!=='0')throw failure('MySQL 环境清理校验失败');
}
async function executeJob(instance,job){
 const details=[],signal=job.controller.signal;await reset(instance,signal);
 for(const sample of job.cases){
  const password=randomBytes(20).toString('hex');
  let tableNames;try{tableNames=[...new Set([...inspectStudentSQL(sample.input||'').tables,...job.tables])]}catch(error){details.push({status:'用例初始化失败',actual:'',diagnostic:error.message});continue}
  const tableGrants=tableNames.map(name=>"GRANT CREATE, ALTER, DROP ON exam_db.`"+name.replaceAll('`','``')+"` TO 'exam_student'@'127.0.0.1';").join('');
  await admin(instance,"CREATE DATABASE exam_db CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; CREATE USER 'exam_student'@'127.0.0.1' IDENTIFIED BY '"+password+"'; GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,INDEX,REFERENCES,CREATE TEMPORARY TABLES,LOCK TABLES ON exam_db.* TO 'exam_student'@'127.0.0.1';"+tableGrants,signal);
  try{
   let initialized=true;try{if(sample.input?.trim())await query(instance,'exam_student',password,sample.input,'exam_db',signal)}catch(error){if(signal.aborted)throw error;initialized=false;details.push({status:'用例初始化失败',actual:'',diagnostic:(error.diagnostic||error.message).slice(0,2000)})}
   if(initialized){try{const actual=normalize(await query(instance,'exam_student',password,'SET SESSION MAX_EXECUTION_TIME=3000;\n'+job.code,'exam_db',signal));details.push({status:actual===normalize(sample.output)?'通过':'答案错误',actual,diagnostic:''})}
    catch(error){if(signal.aborted)throw error;details.push({status:error.killed||/maximum statement execution time|query execution was interrupted/i.test(error.diagnostic||'')?'运行超时':'运行错误',actual:'',diagnostic:(error.diagnostic||error.message).slice(0,2000)})}}
  }finally{await reset(instance,signal)}
 }
 await admin(instance,'SELECT 1;',signal);return details;
}
function notify(job,state,position=0){try{job.onState?.({state,position})}catch{}}
function positions(){queue.forEach((job,i)=>notify(job,'queued',i+1))}
function drain(){
 if(closing)return;
 for(const slot of slots){if(slot.busy||!queue.length)continue;const job=queue.shift();clearTimeout(job.waitTimer);slot.busy=true;slot.job=job;job.slot=slot;positions();notify(job,'preparing');
  slot.done=(async()=>{
   let instance,timer;try{instance=await ensure(slot);if(job.controller.signal.aborted)throw failure('测试已取消',499);notify(job,'running');timer=setTimeout(()=>{job.controller.abort();instance.server.kill('SIGKILL')},taskMs);const details=await executeJob(instance,job);job.resolve(details)}
   catch(error){const broken=slot.instance;slot.instance=null;try{await destroy(broken)}catch{};job.reject(job.controller.signal.aborted?failure('MySQL 测试超时或已取消',job.cancelled?499:504):error)}
   finally{clearTimeout(timer);job.signal?.removeEventListener('abort',job.abort);slot.busy=false;slot.job=null;slot.done=null;drain()}
  })();
 }
}
export function mysqlPoolStatus(){return {size,ready:slots.filter(s=>s.instance&&s.instance.server.exitCode===null&&s.instance.server.signalCode===null).length,running:slots.filter(s=>s.busy).length,queued:queue.length,queueLimit}}
export async function warmMySQLPool(){if(closing)throw failure('MySQL 正在关闭');await Promise.all(slots.map(ensure));return mysqlPoolStatus()}
export function runMySQL(code,cases,{signal,onState}={}){
 let policy;try{policy=inspectStudentSQL(code)}catch(error){return Promise.resolve(cases.map(()=>({status:'运行错误',actual:'',diagnostic:error.message}))) }
 if(closing)return Promise.reject(failure('MySQL 正在关闭'));if(signal?.aborted)return Promise.reject(failure('测试已取消',499));if(queue.length>=queueLimit)return Promise.reject(failure('SQL 等待队列已满，请稍后再试',429));
 return new Promise((resolve,reject)=>{const job={code,cases,tables:policy.tables,signal,onState,resolve,reject,controller:new AbortController()};job.abort=()=>{job.cancelled=true;const i=queue.indexOf(job);if(i>=0){queue.splice(i,1);clearTimeout(job.waitTimer);signal?.removeEventListener('abort',job.abort);reject(failure('测试已取消',499));positions()}else{job.controller.abort();job.slot?.instance?.server.kill('SIGKILL')}};signal?.addEventListener('abort',job.abort,{once:true});
 job.waitTimer=setTimeout(()=>{const i=queue.indexOf(job);if(i<0)return;queue.splice(i,1);signal?.removeEventListener('abort',job.abort);reject(failure('等待 MySQL 判题超时，请稍后再试',504));positions()},waitMs);queue.push(job);positions();drain()});
}
export async function closeMySQLPool(){closing=true;for(const job of queue.splice(0)){clearTimeout(job.waitTimer);job.signal?.removeEventListener('abort',job.abort);job.reject(failure('MySQL 正在关闭'))}for(const slot of slots){slot.job?.controller.abort();slot.instance?.server.kill('SIGKILL')};await Promise.allSettled(slots.map(async slot=>{await slot.starting;await slot.done;await destroy(slot.instance);slot.instance=null}))}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{closeMySQLPool().finally(()=>process.exit(0))});
