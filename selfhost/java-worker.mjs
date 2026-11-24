import http from 'node:http';
import {chmodSync, lstatSync, unlinkSync} from 'node:fs';
import {judge, validCases} from './judge.mjs';

const socket=process.argv[2]??'/run/exam-judge/java.sock';
const probe=await judge({type:5,score:1,testCases:[{input:'',output:'8'}]},{
  language:'Java',
  code:'public class Main { public static void main(String[] args){ System.out.println(8); } }'
});
if(probe.passed!==1)throw Error('Java 8 启动自检失败');
if(process.platform!=='win32' && lstatSync(socket,{throwIfNoEntry:false})?.isSocket())unlinkSync(socket);
let running=0;
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET' && req.url==='/health')return res.end('ok');
  if(req.method!=='POST'||req.url!=='/judge'){res.writeHead(404).end();return}
  if(running>=4){res.writeHead(503).end();return}
  running++;
  try{
    const chunks=[];
    let size=0;
    for await(const chunk of req){
      size+=chunk.length;
      if(size>2*1024*1024){res.writeHead(413).end();return}
      chunks.push(chunk);
    }
    let payload;
    try{payload=JSON.parse(Buffer.concat(chunks).toString())}catch{res.writeHead(400).end();return}
    if(typeof payload?.code!=='string'||Buffer.byteLength(payload.code)>65536||
       !validCases(payload.cases)||!payload.cases.length){res.writeHead(400).end();return}
    const grade=await judge({type:5,score:1,testCases:payload.cases},{language:'Java',code:payload.code});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(grade.details));
  }catch(error){
    console.error('Java 判题请求失败',error.message);
    res.writeHead(503).end();
  }finally{running--}
});
server.listen(socket,()=>{
  if(process.platform!=='win32')chmodSync(socket,0o600);
});
