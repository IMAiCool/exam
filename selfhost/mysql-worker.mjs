import {createServer} from 'node:http';
import {mkdirSync,unlinkSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {runMySQL,warmMySQLPool,mysqlPoolStatus} from './mysql-judge.mjs';
const socket=process.env.EXAM_MYSQL_SOCKET||'/run/exam-judge/mysql.sock',states=new Map();
if(process.platform!=='win32'){mkdirSync(dirname(socket),{recursive:true});try{unlinkSync(socket)}catch(e){if(e.code!=='ENOENT')throw e}}
function prewarm(){warmMySQLPool().catch(e=>{console.error('MySQL 预热未完成',e.message);setTimeout(prewarm,5000).unref()})}prewarm();
createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/health'){const status=mysqlPoolStatus();res.writeHead(status.ready?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify(status));return}
 if(url.pathname==='/status'&&req.method==='GET'){const state=states.get(url.searchParams.get('id'));res.writeHead(state?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(state||null));return}
 if(req.method!=='POST'||url.pathname!=='/judge'){res.writeHead(404).end();return}
 const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort()});let id;
 try{
  let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>300000)throw Error('请求过大')}
  const payload=JSON.parse(body),{code,cases}=payload;id=typeof payload.id==='string'&&payload.id.length<=128?payload.id:undefined;
  if(typeof code!=='string'||Buffer.byteLength(code)>65536||!Array.isArray(cases)||!cases.length||cases.length>12||!cases.every(c=>c&&typeof c.output==='string'&&typeof(c.input??'')==='string'&&Buffer.byteLength(c.output)<=8192&&Buffer.byteLength(c.input??'')<=8192))throw Error('无效用例');
  const details=await runMySQL(code,cases,{signal:controller.signal,onState:state=>{if(id)states.set(id,state)}});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(details));
 }catch(e){if(!res.destroyed)res.writeHead(e.status||500).end(e.message)}finally{if(id)states.delete(id)}
}).listen(socket,()=>{if(process.platform!=='win32')chmodSync(socket,0o666)});
