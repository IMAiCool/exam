// Parse statement boundaries using MySQL's default quoting/comment rules.
// Dynamic SQL and parser-mode changes are deliberately excluded from this sandbox.
const denied=message=>{throw Object.assign(new Error('SQL 权限限制：'+message),{code:'SQL_POLICY'})};
export function inspectStudentSQL(source){
 const statements=[];let current=[];
 for(let i=0;i<source.length;){
  const c=source[i];if(/\s/.test(c)){i++;continue}
  if(c==='#'||c==='-'&&source[i+1]==='-'&&(i+2===source.length||source.charCodeAt(i+2)<=32)){while(i<source.length&&source[i]!=='\n'&&source[i]!=='\r')i++;continue}
  if(c==='/'&&source[i+1]==='*'){if(source[i+2]==='!'||/^m!/i.test(source.slice(i+2,i+4)))denied('不支持可执行注释');const end=source.indexOf('*/',i+2);if(end<0)denied('注释未闭合');i=end+2;continue}
  if(c==='\x27'||c==='"'||c==='`'){
   const quote=c,identifier=c==='`';let value='',closed=false;i++;
   while(i<source.length){if(source[i]===quote){if(source[i+1]===quote){value+=quote;i+=2;continue}i++;closed=true;break}if(!identifier&&source[i]==='\\'){value+=source.slice(i,i+2);i+=2;continue}value+=source[i++]}
   if(!closed)denied('字符串或标识符未闭合');current.push({value,kind:identifier?'identifier':'literal'});continue;
  }
  if(c===';'){if(current.length)statements.push(current);current=[];i++;continue}
  if(c==='\\')denied('不支持 MySQL 客户端命令');
  const word=source.slice(i).match(/^[\p{L}\p{N}_$]+/u);if(word){current.push({value:word[0],kind:'word'});i+=word[0].length}else{current.push({value:c,kind:'symbol'});i++}
 }
 if(current.length)statements.push(current);
 const tables=new Set(),word=(tokens,i)=>tokens[i]?.kind==='word'?tokens[i].value.toUpperCase():'';
 function table(tokens,i){const token=tokens[i];if(!token||!['word','identifier'].includes(token.kind))denied('请明确填写表名');let name=token.value;i++;
  if(tokens[i]?.value==='.'){if(name!=='exam_db')denied('只能操作 exam_db 内的表');name=tokens[i+1]?.value;if(!name||!['word','identifier'].includes(tokens[i+1].kind))denied('表名无效');i+=2}
  if(name.includes('\0')||Array.from(name).length>64)denied('表名无效');tables.add(name);if(tables.size>128)denied('单次脚本最多操作 128 个明确表名');return i;
 }
 for(const tokens of statements){
  const head=word(tokens,0),second=word(tokens,1);
  for(let i=0;i<tokens.length-1;i++)if(['mysql','sys','performance_schema','information_schema'].includes(tokens[i].value.toLowerCase())&&tokens[i].kind!=='literal'&&tokens[i+1].value==='.')denied('不允许访问系统数据库');
  if(head==='USE'){if(tokens.length!==2||tokens[1].value!=='exam_db')denied('只能使用 exam_db');continue}
  if(head==='CREATE'){
   let i=1;if(word(tokens,i)==='TEMPORARY')i++;
   if(word(tokens,i)==='TABLE'){i++;if(word(tokens,i)==='IF'&&word(tokens,i+1)==='NOT'&&word(tokens,i+2)==='EXISTS')i+=3;table(tokens,i)}
   else{if(['UNIQUE','FULLTEXT','SPATIAL'].includes(word(tokens,i)))i++;if(word(tokens,i)!=='INDEX')denied('只允许创建表或索引，禁止创建数据库和其他对象')}
  }else if(head==='ALTER'){
   if(second!=='TABLE')denied('禁止修改数据库，只允许 ALTER TABLE');table(tokens,2);
   for(let i=3;i<tokens.length;i++)if(word(tokens,i)==='RENAME'&&!['COLUMN','INDEX','KEY'].includes(word(tokens,i+1))){let n=i+1;if(['TO','AS'].includes(word(tokens,n)))n++;table(tokens,n);break}
  }else if(head==='DROP'){
   let i=1;if(word(tokens,i)==='TEMPORARY')i++;
   if(word(tokens,i)==='TABLE'){i++;if(word(tokens,i)==='IF'&&word(tokens,i+1)==='EXISTS')i+=2;i=table(tokens,i);while(tokens[i]?.value===',')i=table(tokens,i+1)}
   else if(word(tokens,i)!=='INDEX')denied('禁止删除数据库，只允许删除表或索引');
  }else if(head==='TRUNCATE'){table(tokens,second==='TABLE'?2:1)}
  else if(head==='RENAME'){
   if(second!=='TABLE')denied('只允许重命名表');let i=2;while(i<tokens.length){i=table(tokens,i);if(word(tokens,i)!=='TO')denied('表重命名语法无效');i=table(tokens,i+1);if(tokens[i]?.value!==',')break;i++}
  }else if(head==='SET'){
   const forbidden=new Set('GLOBAL PERSIST PERSIST_ONLY PASSWORD ROLE SQL_MODE NAMES CHARACTER CHARACTER_SET_CLIENT CHARACTER_SET_CONNECTION CHARACTER_SET_RESULTS COLLATION_CONNECTION MAX_EXECUTION_TIME'.split(' '));
   if(tokens.some(t=>t.kind!=='literal'&&forbidden.has(t.value.toUpperCase())))denied('不允许修改账号、全局设置或 SQL 解析模式');
  }else if(head==='SHOW'){
   let i=1;if(word(tokens,i)==='FULL')i++;const type=word(tokens,i++);
   if(type==='CREATE'){if(word(tokens,i)!=='TABLE')denied('只允许查看表结构');table(tokens,i+1)}
   else if(type==='TABLES'||type==='TABLE'&&word(tokens,i)==='STATUS'){if(type==='TABLE')i++;if(['FROM','IN'].includes(word(tokens,i))&&tokens[i+1]?.value!=='exam_db')denied('只能查看 exam_db')}
   else if(['COLUMNS','FIELDS','INDEX','INDEXES','KEYS'].includes(type)){
    if(!['FROM','IN'].includes(word(tokens,i)))denied('请指定本库表名');i=table(tokens,i+1);
    if(['FROM','IN'].includes(word(tokens,i))&&tokens[i+1]?.value!=='exam_db')denied('只能查看 exam_db');
   }else denied('只允许查看本库表、字段或索引');
  }else if(head==='DESC'||head==='DESCRIBE'){table(tokens,1);
  }else if(head==='START'){if(second!=='TRANSACTION')denied('只允许启动本次事务');
  }else if(head==='BEGIN'){if(tokens.length!==1)denied('只允许事务 BEGIN');
  }else if(head==='LOCK'||head==='UNLOCK'){if(second!=='TABLES')denied('只允许操作本库表锁');
  }else if(head==='RELEASE'){if(second!=='SAVEPOINT')denied('只允许释放保存点');
  }else if(head==='EXPLAIN'){
   if(!['SELECT','WITH','INSERT','UPDATE','DELETE','REPLACE','ANALYZE','FORMAT'].includes(second))denied('只允许解释数据查询');
  }else if(!['SELECT','WITH','INSERT','UPDATE','DELETE','REPLACE','BEGIN','START','COMMIT','ROLLBACK','SAVEPOINT','RELEASE','LOCK','UNLOCK','DO'].includes(head))denied('仅允许表、字段、记录及事务操作，不支持动态 SQL、存储程序或管理命令');
  if(tokens.some(t=>t.kind==='word'&&['OUTFILE','DUMPFILE','TABLESPACE'].includes(t.value.toUpperCase())))denied('不允许文件或表空间操作');
 }
 return {tables:[...tables]};
}
