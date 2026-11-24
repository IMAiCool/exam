import {appendFileSync} from 'node:fs';
const debug=(event,data={})=>{if(process.env.EXAM_MYSQL_WATCHDOG_DEBUG)try{appendFileSync(process.env.EXAM_MYSQL_WATCHDOG_DEBUG,JSON.stringify({time:Date.now(),event,...data})+'\n')}catch{}};
process.on('exit',code=>debug('exit',{code}));process.on('uncaughtExceptionMonitor',error=>debug('error',{message:error.message}));
import {rm} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
const [parent,server,directory]=process.argv.slice(2),owner=Number(parent),child=Number(server),target=resolve(directory||'');
debug('start',{owner,child,target,temp:resolve(tmpdir())});
if(!Number.isSafeInteger(owner)||owner<1||!Number.isSafeInteger(child)||child<1||dirname(target)!==resolve(tmpdir())||!/^exam-mysql-[\w-]+$/.test(basename(target)))process.exit(1);
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
let config;
process.on('message',value=>{if(Number.isInteger(value?.port)&&value.port>0&&value.port<65536&&typeof value.mysql==='string'&&typeof value.secret==='string'&&/^[0-9a-f]*$/.test(value.secret)){config=value;debug('config',{port:value.port,secretSet:!!value.secret})}});
async function shutdown(secret){
 const run=sql=>new Promise(resolveQuery=>{const process=execFile(config.mysql,['--no-defaults','--protocol=TCP','--host=127.0.0.1','--port='+config.port,'--user=root','--batch','--skip-column-names','--default-character-set=utf8mb4'],{windowsHide:true,timeout:4000,env:{...globalThis.process.env,MYSQL_PWD:secret}},(error,stdout)=>resolveQuery(error?null:stdout));process.stdin.on('error',()=>{});process.stdin.end(sql+'\n')});
 const directory=await run('SELECT @@datadir;');if(!directory)return;
 const canonical=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
 if(canonical(directory.trim())===canonical(resolve(target,'data')))await run('SHUTDOWN;');
}
let cleaning=false;
async function cleanup(){
 if(cleaning)return;cleaning=true;clearInterval(timer);debug('cleanup',{ownerAlive:alive(owner),childAlive:alive(child)});
 if(config){await shutdown(config.secret);if(config.secret)await shutdown('')}
 await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(e=>debug('removeError',{message:e.message}));debug('cleaned');process.exit(0);
}
const timer=setInterval(()=>{if(!alive(owner)||!alive(child))void cleanup()},1000);
// IPC disconnect identifies this exact parent, even if Windows immediately reuses its PID.
process.once('disconnect',()=>void cleanup());
