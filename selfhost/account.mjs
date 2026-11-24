import {deleteAccount} from './management.mjs';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {openStore, addAccount, createAccount, issueReset} from './store.mjs';

const [role,name,option,...extra] = process.argv.slice(2);
if (!['admin','teacher','student','reset','delete','list'].includes(role) || (!name&&role!=='list') || extra.length ||
    (option !== undefined && (option !== '--password' || ['reset','delete','list'].includes(role)))) {
  throw Error('用法：node selfhost/account.mjs admin|teacher|student 用户名 [--password]，或 reset 用户名');
}

async function readPassword(){
  if(!process.stdin.isTTY)throw Error('请在交互式终端输入密码。');
  const hiddenOutput=new Writable({write(chunk,encoding,done){done()}});
  const input=createInterface({input:process.stdin,output:hiddenOutput,terminal:true});
  async function prompt(label){
    process.stdout.write(label);
    try{return await input.question('')}finally{process.stdout.write('\n')}
  }
  try{
    const password=await prompt('输入密码：');
    if(password.length<8||password.length>128)throw Error('密码需要 8 至 128 个字符。');
    if(password!==await prompt('确认密码：'))throw Error('两次输入的密码不一致。');
    return password;
  }finally{input.close()}
}

const password=option==='--password'?await readPassword():undefined;
const db=openStore();
try{
  if(role==='list'){console.table(db.prepare('SELECT name,role,display_name FROM accounts').all())
  }else if(role==='delete'){deleteAccount(db,name);console.log('账号已删除。')
  }else if(role==='reset'){
    const code=issueReset(db,name);
    if(!code)throw Error('账号不存在。');
    console.log('15 分钟内有效的重置码：',code);
  }else if(password!==undefined){
    if(!await createAccount(db,name,role,password))throw Error('用户名已存在。');
    console.log('账号已创建。');
  }else console.log(await addAccount(db,name,role));
}finally{db.close()}
