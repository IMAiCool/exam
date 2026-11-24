import {cleanupDeletedArchives} from './archives.mjs';
import {randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {createAccount,issueReset,validName} from './store.mjs';
const derive=promisify(scrypt);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function csvRows(text){
 text=text.replace(/^\uFEFF/,'');
 const delimiter=text.split(/\r?\n/)[0].includes('\t')?'\t':',';
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
  else if(!quoted&&c===delimiter){row.push(cell);cell=''}
  else if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell=''}
  else cell+=c;
 }
 if(quoted)throw Error('CSV 引号未闭合。');
 row.push(cell);if(row.some(Boolean))rows.push(row);
 return rows;
}
export function deleteAccount(db,name){
 db.exec('CREATE TABLE IF NOT EXISTS archive_cleanup(paper INTEGER,filename TEXT,PRIMARY KEY(paper,filename))');
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
 const quote=x=>'"'+x.replaceAll('"','""')+'"';
 const visited=new Set();
 function remove(table,where,values){
  for(const row of db.prepare('SELECT rowid AS internalRow,* FROM '+quote(table)+' WHERE '+where).all(...values)){
   if(table==='answer_archives'&&row.filename)db.prepare('INSERT OR IGNORE INTO archive_cleanup VALUES(?,?)').run(row.paper,row.filename);
   if(table==='accounts'){if(tables.includes('programming_jobs'))db.prepare('DELETE FROM programming_jobs WHERE name=?').run(row.name);if(tables.includes('expired_offline_answers'))db.prepare('DELETE FROM expired_offline_answers WHERE name=?').run(row.name)}
   if(table==='papers'){if(tables.includes('programming_jobs'))db.prepare('DELETE FROM programming_jobs WHERE paper=?').run(row.id);if(tables.includes('expired_offline_answers'))db.prepare('DELETE FROM expired_offline_answers WHERE id=?').run(row.id)}
   const key=table+':'+row.internalRow;if(visited.has(key))continue;visited.add(key);
   for(const child of tables){
    const groups=new Map();
    for(const fk of db.prepare('PRAGMA foreign_key_list('+quote(child)+')').all()){
     if(fk.table!==table)continue;
     if(!groups.has(fk.id))groups.set(fk.id,[]);
     groups.get(fk.id).push(fk);
    }
    for(const keys of groups.values())remove(child,keys.map(k=>quote(k.from)+'=?').join(' AND '),keys.map(k=>row[k.to||db.prepare('PRAGMA table_info('+quote(table)+')').all().find(c=>c.pk===k.seq+1)?.name]));
   }
   db.prepare('DELETE FROM '+quote(table)+' WHERE rowid=?').run(row.internalRow);
  }
 }
 db.exec('BEGIN IMMEDIATE');
 try{remove('accounts','name=?',[name]);db.exec('COMMIT');cleanupDeletedArchives(db)}catch(e){db.exec('ROLLBACK');throw e}
}
export async function manageAccounts({req,db,path,html,send,redirect,frame,body,logout}){
 if(path==='/logout'){
  return redirect('/login');
 }
 if(path!=='/management'&&path!=='/')return redirect('/management');
 db.exec("CREATE TABLE IF NOT EXISTS account_groups(account TEXT PRIMARY KEY REFERENCES accounts(name) ON DELETE CASCADE,label TEXT NOT NULL)");
 let message='';
 if(req.method==='POST'){
  const form=new URLSearchParams(await body(req)),action=form.get('action'),name=form.get('name')?.trim();
  try{
   const target=name?db.prepare('SELECT role FROM accounts WHERE name=?').get(name):null;
   if(action==='create'||action==='import'){
    let rows;
    if(action==='import'){
     rows=csvRows(form.get('rows')||'');
     if(['账号','name','username'].includes(rows[0]?.[0]?.replace(/^\uFEFF/,'')))rows.shift();
    }else rows=[[name,form.get('display')||'',form.get('password')||'',form.get('group')||'']];
    if(!rows.length||rows.length>1000)throw Error('每次导入 1 至 1000 个账号。');
    const role=action==='import'?'student':form.get('role');
    if(!['teacher','student'].includes(role))throw Error('只可创建教师或学生。');
    if(rows.some(row=>row.length>4))throw Error('每行最多四列：账号、姓名、密码、分组。');
    const seen=new Set(),prepared=rows.map(([name,display='',password='',group=''])=>{
     name=name?.trim();password=password||form.get('defaultPassword')||randomBytes(15).toString('base64url');
     if(!validName(name)||seen.has(name)||db.prepare('SELECT 1 FROM accounts WHERE name=?').get(name))throw Error('账号无效、重复或已存在 '+name);
     if(password.length<8||password.length>128)throw Error('密码须为 8 至 128 字符。');
     if(display.length>64||group.length>64)throw Error('姓名和分组最多 64 个字符。');
     seen.add(name);return {name,display,password,group};
    });
    const created=[];
    try{for(const item of prepared){if(!await createAccount(db,item.name,role,item.password,item.display))throw Error('账号已存在 '+item.name);created.push(item);if(item.group)db.prepare('INSERT INTO account_groups VALUES(?,?)').run(item.name,item.group)}}
    catch(e){for(const item of created)db.prepare('DELETE FROM accounts WHERE name=?').run(item.name);throw e}
    message='<p>创建成功，请保存登录信息。</p><pre>'+esc(created.map(x=>x.name+'\t'+x.password).join('\n'))+'</pre>';
   }else{
    if(!target||target.role==='admin')throw Error('请选择教师或学生账号。');
    if(action==='password'){
     const password=form.get('password')||'';if(password.length<8||password.length>128)throw Error('密码须为 8 至 128 字符。');
     const salt=randomBytes(16).toString('hex'),hash=await derive(password,salt,32);
     db.exec('BEGIN IMMEDIATE');
     try{db.prepare('UPDATE accounts SET salt=?,hash=? WHERE name=?').run(salt,hash.toString('hex'),name);
     db.prepare('DELETE FROM sessions WHERE name=?').run(name);db.prepare('DELETE FROM password_resets WHERE name=?').run(name);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}message='<p>密码已修改。</p>';
    }else if(action==='reset'){message='<p>15 分钟内有效的重置码</p><pre>'+esc(issueReset(db,name))+'</pre>'}
    else if(action==='group'){db.prepare('INSERT INTO account_groups VALUES(?,?) ON CONFLICT(account) DO UPDATE SET label=excluded.label').run(name,form.get('group')||'');message='<p>分组已保存。</p>'}
    else if(action==='delete'){
     deleteAccount(db,name);message='<p>账号及关联数据已删除。</p>';
    }else throw Error('无效操作。');
   }
  }catch(e){message='<p role="alert">'+esc(e.message)+'</p>'}
 }
 const rows=db.prepare("SELECT a.name,a.role,a.display_name,g.label FROM accounts a LEFT JOIN account_groups g ON g.account=a.name WHERE a.role IN ('teacher','student') ORDER BY a.role,a.name").all();
 const content=message+`<section><h2>新建账号</h2><form method="post"><input type="hidden" name="action" value="create"><label>身份<select name="role" class="exam-select"><option value="student">学生</option><option value="teacher">教师</option></select></label><label>账号<input name="name" required></label><label>姓名<input name="display"></label><label>密码<input type="password" name="password" placeholder="留空随机生成"></label><label>分组<input name="group"></label><button>创建</button></form></section>
 <section><h2>批量创建学生</h2><p>列顺序为账号、姓名、密码、分组。支持 CSV 和从表格复制粘贴。</p><form method="post"><input type="hidden" name="action" value="import"><label>默认密码<input name="defaultPassword" type="password" placeholder="留空随机生成"></label><input type="file" accept=".csv,.tsv,.txt" onchange="this.files[0]?.text().then(t=>this.form.rows.value=t)"><textarea name="rows" required rows="6" placeholder="账号,姓名,密码,分组"></textarea><button>导入学生</button></form></section>
 <section><h2>账号列表</h2><div class="management-table-scroll"><table><thead><tr><th>账号</th><th>身份</th><th>姓名</th><th>分组及操作</th></tr></thead><tbody>`+rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.role==='teacher'?'教师':'学生'}</td><td>${esc(r.display_name)}</td><td><form method="post"><input type="hidden" name="name" value="${esc(r.name)}"><input name="group" value="${esc(r.label)}" aria-label="分组"><button name="action" value="group">保存分组</button><input type="password" name="password" placeholder="新密码"><button name="action" value="password">修改密码</button><button name="action" value="reset">生成重置码</button><button name="action" value="delete" data-confirm="确认删除此账号及其关联记录？">删除</button></form></td></tr>`).join('')+'</tbody></table></div></section>';
 return html(frame('账号管理','<div class="management-page">'+content+'</div>','','', `<div class="management-logout">${logout}</div>`));
}

