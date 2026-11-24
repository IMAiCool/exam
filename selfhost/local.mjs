import {readFileSync,existsSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore, addAccount} from './store.mjs';

// Run in the project directory so the CLI and server use the same database.
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const db = openStore();

db.close();
const {listen}=await import('./server.mjs');
const lanConfig=join(process.env.EXAM_DATA||'selfhost/data','lan-interface.txt');
if(!process.env.HOST && existsSync(lanConfig)){
  const adapter=readFileSync(lanConfig,'utf8').trim();
  const address=networkInterfaces()[adapter]?.find(a=>a.family==='IPv4'&&!a.internal);
  if(address)listen(address.address).on('error',err=>console.error('局域网监听失败：',err.message));
}

