import http from 'node:http';
import {chmodSync,lstatSync,unlinkSync} from 'node:fs';
import {judge,validCases} from './judge.mjs';

// Only this private worker may invoke the image's bundled Python/WASI runner.
delete process.env.EXAM_WASI_SOCKET;
const socket=process.argv[2]??'/run/exam-judge/wasi.sock';
for(const [language,code] of [['Python','print(8)'],['JavaScript','console.log(8)']]){
 const result=await judge({type:5,score:1,testCases:[{input:'',output:'8'}]},{language,code});
 if(result?.passed!==1)throw Error(language+' 判题运行时自检失败');
}
if(process.platform!=='win32'&&lstatSync(socket,{throwIfNoEntry:false})?.isSocket())unlinkSync(socket);
let running=0;
http.createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/health')return res.end('ok');
 if(req.method!=='POST'||req.url!=='/judge')return res.writeHead(404).end();
 if(running>=3)return res.writeHead(503).end();
 running++;
 try{
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)return res.writeHead(413).end();chunks.push(chunk)}
  let data;try{data=JSON.parse(Buffer.concat(chunks))}catch{return res.writeHead(400).end()}
  if(!['Python','JavaScript'].includes(data?.language)||typeof data.code!=='string'||Buffer.byteLength(data.code)>65536||!validCases(data.cases)||!data.cases.length)return res.writeHead(400).end();
  const result=await judge({type:5,score:1,testCases:data.cases},{language:data.language,code:data.code});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result.details));
 }catch(error){console.error('WASI 判题失败',error.message);res.writeHead(503).end()}
 finally{running--}
}).listen(socket,()=>{if(process.platform!=='win32')chmodSync(socket,0o600)});
