import {bundledExecutable} from './runtime.mjs';
import {warmMySQLPool} from './mysql-judge.mjs';
import {gzipSync} from 'node:zlib';
import {manageAccounts} from './management.mjs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeAnswerCard,readAnswerCard} from './answer-card.mjs';
import {loadStyles} from '../worker/styles.mjs';
import http from 'node:http';
import {judge,judgeLanguages,casesFor,validCases} from './judge.mjs';
import {gradeWithAI,autoScores,parseKey,readAnswerFile,applyKeys,hasBlankPlaceholder} from './grading.mjs';
import {writePendingArchives} from './archives.mjs';
import {importMarkdown,langs} from './markdown.mjs';
import {randomBytes, createHash, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {openStore, createAccount, validName, issueReset, resetDigest} from './store.mjs';
import {createExamWorker,renderAccountIdentity,validQuestionTables,questionBlankCount,formatBlanks,subquestionNumbers,subquestionParts,subquestionText} from '../worker/index.mjs';

const derive = promisify(scrypt);
const db = openStore();
// Both manual submissions and deadline submissions pass through this insert.
db.function('objective_scores',(snapshot,answers)=>{
  const scores=autoScores(JSON.parse(snapshot).questions,JSON.parse(answers));
  return scores.some(score=>score!==null)?JSON.stringify(scores):null;
});
db.exec(`CREATE TEMP TRIGGER score_new_submission AFTER INSERT ON main.submissions BEGIN
  INSERT INTO grades(paper,name,scores,version,reviewed)
  SELECT NEW.paper,NEW.name,scores,1,0 FROM (
    SELECT objective_scores(v.paper,NEW.answers) AS scores FROM attempts a
    JOIN paper_versions v ON v.id=a.id AND v.revision=a.revision
    WHERE a.id=NEW.paper AND a.name=NEW.name
  ) WHERE scores IS NOT NULL;
END`);
db.function('has_program_cases',snapshot=>Number(JSON.parse(snapshot).questions.some(q=>casesFor(q).length)));
db.exec(`CREATE TABLE IF NOT EXISTS programming_jobs(paper INTEGER,name TEXT,retry_at INTEGER DEFAULT 0,PRIMARY KEY(paper,name));
  CREATE TEMP TRIGGER queue_program_grading AFTER INSERT ON main.submissions BEGIN
    INSERT INTO programming_jobs(paper,name) SELECT NEW.paper,NEW.name FROM attempts a
    JOIN paper_versions v ON v.id=a.id AND v.revision=a.revision
    WHERE a.id=NEW.paper AND a.name=NEW.name AND has_program_cases(v.paper);
  END`);
db.exec(`CREATE TABLE IF NOT EXISTS written_grading(
  paper INTEGER,name TEXT,idx INTEGER,tries INTEGER DEFAULT 0,retry_at INTEGER DEFAULT 0,
  score REAL,reason TEXT,PRIMARY KEY(paper,name,idx),FOREIGN KEY(paper,name) REFERENCES submissions(paper,name) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS written_pending ON written_grading(retry_at) WHERE score IS NULL AND tries<3;`);
if(process.env.DEEPSEEK_API_KEY)db.exec(`CREATE TEMP TRIGGER queue_written_grading AFTER INSERT ON main.submissions BEGIN
  INSERT INTO written_grading(paper,name,idx)
  SELECT NEW.paper,NEW.name,q.key FROM attempts a JOIN paper_versions v ON v.id=a.id AND v.revision=a.revision,
    json_each(v.paper,'$.questions') q WHERE a.id=NEW.paper AND a.name=NEW.name
    AND coalesce(json_extract(v.paper,'$.aiGrading'),1)=1
    AND (json_extract(q.value,'$.type') IN (3,4)
      OR (json_extract(q.value,'$.type') IN (0,1,2) AND trim(coalesce(json_extract(q.value,'$.referenceAnswer'),''))=''));
END`);
// Merge only this grader's questions with the latest saved scores inside the caller's transaction.
function mergeAutomatic(paper,name,questions,answers,updates){
  const grade=db.prepare('SELECT scores,auto_scores,reviewed FROM grades WHERE paper=? AND name=?').get(paper,name);
  const saved=grade?.reviewed?grade.auto_scores:grade?.scores;
  const scores=saved?JSON.parse(saved):autoScores(questions,answers);
  for(const [index,score] of updates)scores[index]=score;
  const encoded=JSON.stringify(scores);
  if(grade?.reviewed)db.prepare('UPDATE grades SET auto_scores=? WHERE paper=? AND name=?').run(encoded,paper,name);
  else db.prepare(`INSERT INTO grades(paper,name,scores,version,reviewed) VALUES(?,?,?,1,0)
    ON CONFLICT(paper,name) DO UPDATE SET scores=excluded.scores,version=grades.version+1`).run(paper,name,encoded);
}
// Retry the database operation without repeating a completed model or judge request.
async function writeWhenAvailable(operation){
  for(;;){
    try{return operation()}catch(error){
      if(![5,6].includes(error.errcode & 255))throw error;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
}
let gradingWritten=false;
async function gradeWritten(){
  if(gradingWritten||!process.env.DEEPSEEK_API_KEY)return;
  const job=db.prepare('SELECT paper,name,idx,tries FROM written_grading WHERE score IS NULL AND reason IS NULL AND tries<3 AND retry_at<=? ORDER BY retry_at,rowid LIMIT 1').get(Date.now());
  if(!job)return;
  gradingWritten=true;
  const key=[job.paper,job.name,job.idx];
  try{
    const submission=getSubmission(job.paper,job.name,true);
    const {questions}=JSON.parse(submission.paper),answers=JSON.parse(submission.answers);
    let result;
    try{result=await gradeWithAI(questions[job.idx],answers[job.idx])}
    catch(error){
      await writeWhenAvailable(()=>db.prepare('UPDATE written_grading SET tries=tries+1,retry_at=? WHERE paper=? AND name=? AND idx=? AND score IS NULL AND reason IS NULL AND tries=?').run(Date.now()+60000,...key,job.tries));
      console.error('AI 判卷未完成',error.message);
      return;
    }
    await writeWhenAvailable(()=>{
      db.exec('BEGIN IMMEDIATE');
      try{
        const changed=db.prepare('UPDATE written_grading SET score=?,reason=? WHERE paper=? AND name=? AND idx=? AND score IS NULL AND reason IS NULL').run(result.score,result.reason,...key);
        if(changed.changes)mergeAutomatic(job.paper,job.name,questions,answers,[[job.idx,result.score]]);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error}
    });
  }finally{gradingWritten=false}
}
const testingAccounts=new Map(),testStates=new Map();
let gradingPrograms=false;
async function gradePrograms(){
  if(gradingPrograms)return;
  const job=db.prepare('SELECT paper,name FROM programming_jobs WHERE retry_at<=? ORDER BY rowid LIMIT 1').get(Date.now());
  if(!job)return;
  gradingPrograms=true;
  try{
    const row=db.prepare(`SELECT v.paper,s.answers FROM submissions s JOIN attempts a ON a.id=s.paper AND a.name=s.name
      JOIN paper_versions v ON v.id=a.id AND v.revision=a.revision
      WHERE s.paper=? AND s.name=?`).get(job.paper,job.name);
    if(row){
      const {questions}=JSON.parse(row.paper),answers=JSON.parse(row.answers);
      const updates=[];
      for(const [i,q] of questions.entries()){
        if(q.type===5){
          const report=await judge(q,answers[i]);
          if(report)updates.push([i,report.score]);
        }
      }
      await writeWhenAvailable(()=>{
        db.exec('BEGIN IMMEDIATE');
        try{
          const removed=db.prepare('DELETE FROM programming_jobs WHERE paper=? AND name=?').run(job.paper,job.name);
          if(removed.changes && updates.length)mergeAutomatic(job.paper,job.name,questions,answers,updates);
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error}
      });
    }else await writeWhenAvailable(()=>db.prepare('DELETE FROM programming_jobs WHERE paper=? AND name=?').run(job.paper,job.name));
  }catch(error){
    console.error('编程判卷稍后重试',error.message);
    await writeWhenAvailable(()=>db.prepare('UPDATE programming_jobs SET retry_at=? WHERE paper=? AND name=?').run(Date.now()+60000,job.paper,job.name));
  }finally{gradingPrograms=false}
}
const template = readFileSync(new URL('../worker/exam.html',import.meta.url),'utf8');
const styles=loadStyles(template);
// Only public styles/icons are cached; account pages and answers remain no-store.
const publicAssets=new Map(Object.entries(styles.assets).map(([path,source])=>{
  const identity=Buffer.from(source),gzip=gzipSync(identity);
  const variant=body=>({body,etag:'"'+createHash('sha256').update(body).digest('hex')+'"'});
  return [path,{identity:variant(identity),gzip:variant(gzip)}];
}));
const offlineWorker=readFileSync(new URL('./offline-sw.js',import.meta.url),'utf8');
db.exec(`CREATE TABLE IF NOT EXISTS expired_offline_answers(id INTEGER,name TEXT,changes TEXT,PRIMARY KEY(id,name));
  CREATE TRIGGER IF NOT EXISTS remember_expired_exam AFTER DELETE ON timed_attempts
  WHEN OLD.deadline<=unixepoch('subsec')*1000 AND EXISTS(SELECT 1 FROM submissions WHERE paper=OLD.id AND name=OLD.name)
  BEGIN INSERT OR IGNORE INTO expired_offline_answers(id,name) VALUES(OLD.id,OLD.name); END;`);
const themeScript = template.match(/<script id="theme-script">[\s\S]*?<\/script>/)[0];
const syntaxScript = template.match(/<script id="syntax-script">[\s\S]*?<\/script>/)[0];
const previewHighlight = syntaxScript+'<script>for(const code of document.querySelectorAll("code[data-language]"))code.innerHTML=highlightCode(code.textContent,code.dataset.language);</script>';
const themeButton = template.match(/<button id="theme-mode"[^>]*>[\s\S]*?<\/button>/)[0];
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const frame = (title,body,dock='',dockClass='',headerAction='',beforeHeader='',toolbarBack='') => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${themeScript}${styles.links}<body class="exam-shell"><main>${beforeHeader}<header class="toolbar">${toolbarBack}<h1>${title}</h1>${headerAction?`<div class="account-actions"><div class="account-controls">${headerAction}</div></div>`:themeButton}</header>${body}</main>${dock?`<nav class="floating-dock ${dockClass}" aria-label="页面导航">${dock}</nav>`:''}</body></html>`;
const logout='<form method="post" action="/logout"><button><svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H5v16h6m-1-8h11m-4-4 4 4-4 4"/></svg>退出登录</button></form>';
const settingsTemplate=template.match(/<details class="settings-menu">[\s\S]*?<\/details>/)[0];
const peopleLink=(account,paperId)=>account.role==='teacher'?'<a class="people-link" href="/students"><svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2"/></svg>管理学生</a>':'<a class="people-link" href="/teachers'+(paperId?'?paper='+paperId:'')+'"><svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="13" height="11" rx="2"/><circle cx="6" cy="13" r="3"/><path d="M2 21a4 4 0 0 1 8 0m3-11h4"/></svg>我的教师</a>';
const settingsMenu=account=>renderAccountIdentity(settingsTemplate,account)
  .replace('<!-- people-menu -->',peopleLink(account))
  .replace(/<a class="sign-out"[\s\S]*?<\/a>/,()=>logout);
function teacherDock(editorHref='/teacher',inEditor=false){
  const mode=(id,label,href)=>inEditor
    ?`<button class="segment" id="${id}" type="button">${label}</button>`
    :`<a href="${href}">${label}</a>`;
  return '<span class="dock-indicator" aria-hidden="true"></span>'+
    mode('teacher','教师组卷',editorHref)+mode('student','预览题目',editorHref+'#trial')+
    '<a href="/"'+(inEditor?'':' aria-current="page"')+'>试卷目录</a>';
}
function backButton(href,label){
  return `<a class="people-back" href="${esc(href)}" aria-label="${esc(label)}" title="${esc(label)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg></a>`;
}
function teacherFrame(account,title,body,editorHref,toolbarBack){
  return frame(title,body,teacherDock(editorHref),'teacher-dock',settingsMenu(account),'',toolbarBack);
}
// Only replace score text so a reader keeps their current question or dialog position.
function studentScoreReport(paper,name){
  const grade=db.prepare(`SELECT g.scores,g.auto_scores,g.reviewed FROM submissions s
    LEFT JOIN grades g ON g.paper=s.paper AND g.name=s.name WHERE s.paper=? AND s.name=?`).get(paper,name);
  if(!grade)return null;
  return {
    initial:JSON.parse((grade.reviewed?grade.auto_scores:grade.scores)??'[]'),
    final:grade.reviewed?JSON.parse(grade.scores):null,
    written:db.prepare('SELECT idx,score,reason,tries FROM written_grading WHERE paper=? AND name=? ORDER BY idx').all(paper,name),
    testing:Boolean(db.prepare('SELECT 1 FROM programming_jobs WHERE paper=? AND name=?').get(paper,name))
  };
}
function watchPublishedScores(paperId){
  const dialog=document.getElementById('history-dialog');
  const catalog=document.querySelector('[data-catalog-score]');
  const query=()=>catalog?'catalog=1':paperId?'paper='+paperId:dialog?.open?'student='+encodeURIComponent(dialog.dataset.student):null;
  let pending=false;
  async function refresh(){
    const scope=query();
    if(!scope||pending||document.hidden||!navigator.onLine)return;
    pending=true;
    try{
      const response=await fetch('/api/published-scores?'+scope);
      if(!response.ok)return;
      const scores=await response.json();
      if(scope!==query())return;
      if(paperId){
        if(JSON.stringify(hosted.scoreReport)!==JSON.stringify(scores)){
          hosted.scoreReport=scores;renderStudentScores(scores);
        }
        return;
      }
      for(const {paper,total} of scores){
        if(catalog){
          const cell=document.querySelector('[data-catalog-score="'+paper+'"]');
          if(cell&&cell.textContent!==String(total)){
            cell.textContent=total;
            cell.nextElementSibling.textContent='查看最终成绩';
            document.querySelector('[data-card-status="'+paper+'"]').textContent=' · 最终成绩 '+total+' 分';
          }
        }else{
          const cell=dialog.querySelector('[data-score-paper="'+paper+'"]');
          if(cell){const text=total+' / '+cell.dataset.max+' 分';if(cell.textContent!==text)cell.textContent=text;}
        }
      }
    }catch{
      // A later poll retries after a temporary disconnect.
    }finally{pending=false}
  }
  window.addEventListener('pageshow',refresh);
  window.addEventListener('online',refresh);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
  dialog?.addEventListener('toggle',refresh);
  setInterval(refresh,2000);
}
function studentGroups(teacher){
  return db.prepare('SELECT name FROM student_groups WHERE teacher=? ORDER BY name').all(teacher).map(row=>row.name);
}
function studentTeachers(student){
  return db.prepare('SELECT a.name,a.display_name,a.course,b.course_alias,b.joined_at FROM teacher_students b JOIN accounts a ON a.name=b.teacher WHERE b.student=? ORDER BY a.name').all(student);
}
function teacherLabel(account,name){
  const display=name?.trim();
  return display?display+'（'+account+'）':account;
}
function peoplePage(account,message='',sourcePaper=''){
  const teacher=account.role==='teacher';
  const rows=teacher?db.prepare("SELECT a.name,a.display_name,b.student_group,b.joined_at,(b.can_reset=1 OR b.teacher='teacher') AS may_reset FROM teacher_students b JOIN accounts a ON a.name=b.student WHERE b.teacher=? ORDER BY a.name").all(account.name):studentTeachers(account.name);
  const form=teacher?`<section><h2>我的课程</h2><form method="post" action="/students"><div class="row"><label>课程名称 <input name="course" maxlength="64" value="${esc(account.course||'')}"></label><button name="action" value="course">保存课程</button></div></form></section><section><h2>添加学生</h2><form class="bind-student" method="post" action="/students"><label for="existing-student">已有学生账号</label><input id="existing-student" name="student" required maxlength="64"><button type="submit" name="action" value="bind" aria-label="添加到我的学生" title="添加到我的学生"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></form>
    <button type="button" aria-haspopup="dialog" aria-controls="new-student-dialog" onclick="document.getElementById('new-student-dialog').showModal()">创建新学生账号</button>
    <dialog id="new-student-dialog" aria-labelledby="new-student-title" onclose="this.querySelector('form').reset()"><header><strong id="new-student-title">创建新学生账号</strong><button id="close-new-student" type="button" aria-label="关闭创建新学生账号" onclick="this.closest('dialog').close()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><form class="create-student" method="post" action="/students"><label><span>学生账号</span><input autofocus name="student" required maxlength="64"></label><label><span>姓名</span><input name="display" required maxlength="64"></label><label><span>初始密码</span><input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><div class="row"><button type="submit" name="action" value="create">创建并添加</button></div></form></dialog></section>`:'';
  const histories=new Map();
  if(teacher){
    const records=db.prepare(`SELECT s.name,s.paper,a.revision,json_extract(v.paper,'$.title') AS title,
      json_extract(v.paper,'$.target') AS total,a.started_at,ar.submitted_at,g.reviewed,g.scores
      FROM teacher_students b JOIN submissions s ON s.name=b.student
      JOIN papers p ON p.id=s.paper AND p.teacher=b.teacher
      JOIN attempts a ON a.id=s.paper AND a.name=s.name
      JOIN paper_versions v ON v.id=a.id AND v.revision=a.revision
      LEFT JOIN grades g ON g.paper=s.paper AND g.name=s.name
      LEFT JOIN answer_archives ar ON ar.paper=s.paper AND ar.name=s.name
      WHERE b.teacher=? ORDER BY ar.submitted_at DESC,s.paper DESC`).all(account.name);
    for(const record of records){
      if(!histories.has(record.name))histories.set(record.name,[]);
      const score=record.reviewed&&record.scores?gradeTotal(JSON.parse(record.scores))+' / '+record.total+' 分':'待评卷';
      const seconds=record.started_at!=null&&record.submitted_at>=record.started_at?Math.floor((record.submitted_at-record.started_at)/1000):null;
      const duration=seconds===null?'未记录':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';
      const when=ms=>ms==null?'未记录':new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      histories.get(record.name).push(`<tr><td><a href="/?paper=${record.paper}&amp;student=${encodeURIComponent(record.name)}&amp;history=1">${esc(record.title)}</a><br><small>编号 ${record.paper} · 第 ${record.revision} 版</small></td><td>${when(record.started_at)}</td><td>${when(record.submitted_at)}</td><td>${duration}</td><td data-score-paper="${record.paper}" data-max="${esc(record.total)}">${esc(score)}</td></tr>`);
    }
  }
  const groups=teacher?studentGroups(account.name):[];
  function groupCell(student){
    const current=student.student_group;
    return `<form method="post" action="/students#roster">
      <input type="hidden" name="action" value="group"><input type="hidden" name="student" value="${esc(student.name)}">
      <select class="exam-select" name="student_group" aria-label="${esc(student.name)}的分组" onchange="this.form.requestSubmit()">
        <option value="">未分组</option>${groups.map(g=>`<option value="${esc(g)}" ${g===current?'selected':''}>${esc(g)}</option>`).join('')}
      </select></form>`;
  }
  const colleagues=teacher?db.prepare(`SELECT g.group_name,a.name,a.display_name FROM group_teachers g JOIN accounts a ON a.name=g.teacher WHERE g.owner=? ORDER BY a.name`).all(account.name):[];
  const otherTeachers=teacher?db.prepare("SELECT name,display_name FROM accounts WHERE role='teacher' AND name<>? ORDER BY name").all(account.name):[];
  const teacherGroups=new Map();
  for(const colleague of colleagues){
    if(!teacherGroups.has(colleague.name))teacherGroups.set(colleague.name,[]);
    teacherGroups.get(colleague.name).push(colleague.group_name);
  }
  const joined=teacher?db.prepare(`SELECT g.owner,g.group_name,b.student,a.display_name FROM group_teachers g
    LEFT JOIN teacher_students b ON b.teacher=g.owner AND b.student_group=g.group_name
    LEFT JOIN accounts a ON a.name=b.student WHERE g.teacher=? ORDER BY g.owner,g.group_name,b.student`).all(account.name):[];
  const joinedGroups=new Map();
  for(const row of joined){
    const key=JSON.stringify([row.owner,row.group_name]);
    if(!joinedGroups.has(key))joinedGroups.set(key,{owner:row.owner,name:row.group_name,members:[]});
    if(row.student)joinedGroups.get(key).members.push(row);
  }
  const groupViews=groups.map((name,i)=>({name,id:'group-members-'+i,members:rows.filter(r=>r.student_group===name)}));
  function openDialog(id){
    return `aria-haspopup="dialog" aria-controls="${id}" onclick="document.getElementById(this.getAttribute('aria-controls')).showModal()"`;
  }
  function addGroupTeacher(name){
    return `<button type="button" data-add-teacher="${esc(name)}" aria-haspopup="dialog" aria-controls="add-group-teacher">添加教师</button>`;
  }
  function addGroupStudent(name,icon=false){
    const glyph='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    return `<button type="button" data-add-student="${esc(name)}" aria-haspopup="dialog" aria-controls="group-add-student" ${icon?'class="paper-icon" title="添加学生"':''} aria-label="添加学生到${esc(name)}">${icon?glyph:'添加学生'}</button>`;
  }
  const groupPanel=teacher?`<section id="groups"><div class="group-heading"><h2>学生分组</h2><button id="group-layout-toggle" type="button" aria-label="切换为宫格" title="切换为宫格"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <g class="list-icon"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h1M4 12h1M4 18h1"/></g>
          <g class="grid-icon"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></g>
        </svg></button><button type="button" aria-label="新建分组" title="新建分组" aria-haspopup="dialog" aria-controls="new-group-dialog" onclick="document.getElementById('new-group-dialog').showModal()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
    <dialog id="new-group-dialog" class="exam-prompt" aria-labelledby="new-group-title" onclose="this.querySelector('form').reset()"><h2 id="new-group-title">新建分组</h2><form method="post" action="/students"><label>分组名称<input autofocus name="group_name" maxlength="64" required></label><div class="row"><button type="button" onclick="this.closest('dialog').close()">取消</button><button name="action" value="create-group">保存</button></div></form></dialog>
    <dialog id="group-add-student" class="exam-prompt group-form-dialog" aria-labelledby="group-add-title"><h2 id="group-add-title">添加学生</h2>
      <form method="post" action="/students"><input type="hidden" name="action" value="group"><input type="hidden" name="from" value="groups"><input type="hidden" name="student_group">
      <input type="hidden" name="student"><label>选择学生<input type="search" id="group-student-query" autocomplete="off" placeholder="输入姓名或账号，或从列表选择" aria-controls="group-student-options"></label>
      <div id="group-student-options" role="group" aria-label="可选学生" hidden>${[...rows].sort((a,b)=>(b.joined_at??0)-(a.joined_at??0)).map(r=>`<button type="button" data-account="${esc(r.name)}" data-name="${esc(r.display_name||'')}" data-group="${esc(r.student_group||'')}">${esc(r.display_name||r.name)}（${esc(r.name)}） · ${esc(r.student_group||'未分组')}</button>`).join('')}</div>
      <p data-empty hidden>没有可添加的学生。</p><div class="row"><button type="button" onclick="this.closest('dialog').close()">取消</button><button type="submit">添加</button></div></form></dialog>
    <dialog id="add-group-teacher" class="exam-prompt group-form-dialog" aria-labelledby="add-teacher-title">
      <header class="group-members-heading"><h2 id="add-teacher-title">添加教师</h2>
        <button type="button" aria-label="关闭添加教师弹窗" title="关闭" onclick="this.closest('dialog').close()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header><form method="post" action="/students">
      <input type="hidden" name="action" value="add-group-teacher"><input type="hidden" name="group_name">
      <input type="hidden" name="colleague"><label>选择教师<input type="search" autocomplete="off" placeholder="输入姓名或账号，或从列表选择" aria-controls="group-teacher-options"></label>
      <div id="group-teacher-options" role="group" aria-label="可选教师" hidden>${otherTeachers.map(t=>`<button type="button" data-account="${esc(t.name)}" data-name="${esc(t.display_name||'')}" data-groups="${esc(JSON.stringify(teacherGroups.get(t.name)||[]))}">${t.display_name?esc(t.display_name)+'（'+esc(t.name)+'）':esc(t.name)}</button>`).join('')}</div>
      <p data-empty hidden></p><div class="row"><button type="submit" disabled>添加</button></div></form></dialog>
    <div class="group-cards" data-catalog-layout="grid">${groupViews.length?`<ul class="paper-grid">${groupViews.map(({name,id,members})=>`<li>
      <a class="paper-card" href="#${id}" aria-haspopup="dialog" aria-controls="${id}" onclick="event.preventDefault();document.getElementById(this.getAttribute('aria-controls')).showModal()"><strong>${esc(name)}</strong><span class="meta">${members.length} 人</span></a>
      <div class="paper-tools">${addGroupStudent(name,true)}<button type="button" class="paper-icon" aria-label="修改分组 ${esc(name)}" title="修改分组" ${openDialog(id+'-edit')}>${paperIcon('edit')}</button>
      <button type="submit" class="paper-icon" form="${id}-delete" aria-label="删除分组 ${esc(name)}" title="删除分组">${paperIcon('delete')}</button></div></li>`).join('')}</ul>`:'<p>暂无分组。</p>'}</div>
    <div class="roster-scroll"><table class="groups-table" aria-label="学生分组"><thead><tr><th scope="col">分组名称</th><th scope="col">人数</th><th scope="col">添加教师</th><th scope="col">添加学生</th><th scope="col">修改</th><th scope="col">删除</th></tr></thead><tbody>
    ${groupViews.map(({name,id,members})=>`<tr class="group-entry"><td><button type="button" class="group-name" ${openDialog(id)}>${esc(name)}</button></td><td>${members.length} 人</td>
      <td>${addGroupTeacher(name)}</td><td>${addGroupStudent(name)}</td><td><button type="button" ${openDialog(id+'-edit')}>修改</button></td><td><button type="submit" form="${id}-delete">删除</button></td></tr>`).join('')||'<tr><td colspan="6">暂无分组。</td></tr>'}</tbody></table></div>
    ${groupViews.map(({name,id,members})=>`<form id="${id}-delete" method="post" action="/students" class="delete-group" hidden><input type="hidden" name="original" value="${esc(name)}"><input type="hidden" name="action" value="delete-group"></form>
      <dialog id="${id}-edit" class="exam-prompt group-form-dialog" aria-labelledby="${id}-edit-title" onclose="this.querySelector('form').reset()"><h2 id="${id}-edit-title">修改分组</h2><form method="post" action="/students"><input type="hidden" name="original" value="${esc(name)}"><label>分组名称<input autofocus name="group_name" value="${esc(name)}" required maxlength="64"></label><div class="row"><button type="button" onclick="this.closest('dialog').close()">取消</button><button class="primary" name="action" value="rename-group">保存</button></div></form></dialog>
      <dialog id="${id}" class="exam-prompt group-members" aria-labelledby="${id}-title">
        <header class="group-members-heading"><h2 id="${id}-title">${esc(name)} · ${members.length} 人</h2>
          <form method="dialog"><button aria-label="关闭分组详情" title="关闭分组详情"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></form>
        </header>
        <h3 id="${id}-teachers">分组教师</h3>
        <table aria-labelledby="${id}-teachers"><thead><tr><th scope="col">姓名</th><th scope="col">账号</th><th scope="col">角色</th></tr></thead><tbody>
          <tr><td>${esc(account.display_name||account.name)}</td><td>${esc(account.name)}</td><td>创建者</td></tr>
          ${colleagues.filter(t=>t.group_name===name).map(t=>`<tr><td>${esc(t.display_name||t.name)}</td><td>${esc(t.name)}</td><td>分组教师</td></tr>`).join('')}
        </tbody></table>
        <h3 id="${id}-students">分组学生</h3>
        <table aria-labelledby="${id}-students"><thead><tr><th scope="col">姓名</th><th scope="col">账号</th></tr></thead><tbody>
          ${members.map(r=>`<tr><td>${esc(r.display_name||'—')}</td><td>${esc(r.name)}</td></tr>`).join('')||'<tr><td colspan="2">该分组暂无学生。</td></tr>'}
        </tbody></table>
        <div class="row">${addGroupTeacher(name)}${addGroupStudent(name)}</div>
      </dialog>`).join('')}
    ${joinedGroups.size?`<h3>我加入的分组</h3>${Array.from(joinedGroups.values(),g=>`<details><summary>${esc(g.name)} · ${esc(g.owner)} · ${g.members.length} 人</summary>${g.members.length?`<ul>${g.members.map(r=>`<li>${esc(r.display_name||r.student)}（${esc(r.student)}）</li>`).join('')}</ul>`:'<p>该分组暂无学生。</p>'}</details>`).join('')}`:''}</section><script>(${bindGroupLayout.toString()})()</script>`:'';
  const roster=teacher
    ? '<div class="roster-scroll"><table class="student-roster" aria-label="我的学生"><thead><tr><th scope="col">姓名</th><th scope="col">账号</th><th scope="col">学生分组</th><th scope="col">移除学生</th><th scope="col">密码重置</th><th scope="col">历史考试成绩</th></tr></thead><tbody>'+
      (rows.map((r,i)=>`<tr><td>${esc(r.display_name||'—')}</td><td>${esc(r.name)}</td><td>${groupCell(r)}</td><td>
        <form method="post" action="/students" class="unbind"><input type="hidden" name="action" value="remove"><input type="hidden" name="student" value="${esc(r.name)}"><button>移除</button></form></td><td>
        ${r.may_reset?`<form method="post" action="/student-reset"><input type="hidden" name="name" value="${esc(r.name)}"><button name="from" value="students">生成重置码</button></form>`:'—'}
      </td><td><button type="button" aria-haspopup="dialog" aria-controls="history-dialog" data-history="history-${i}" data-student="${esc(r.name)}">查看成绩</button>
      <template id="history-${i}"><p>学生姓名 · ${esc(r.display_name||'未填写')}</p>${histories.has(r.name)?'<div class="history-scroll"><table aria-label="考试成绩明细"><thead><tr><th>考试名称</th><th>开始时间</th><th>交卷时间</th><th>实际用时</th><th>成绩</th></tr></thead><tbody>'+histories.get(r.name).join('')+'</tbody></table></div>':'<p>暂无考试记录。</p>'}</template></td></tr>`).join('')||'<tr><td colspan="6">尚未添加学生。</td></tr>')+'</tbody></table></div>' 
    : '<div class="teacher-table-scroll"><table id="my-teachers" aria-label="我的教师"><thead><tr>'+['序号','姓名','账号','课程','加入时间'].map(title=>'<th scope="col">'+title+'</th>').join('')+'</tr></thead><tbody>'+
      (rows.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.display_name?.trim()||r.name)}</td><td>${esc(r.name)}</td><td>${r.course?esc(r.course):`<button type="button" aria-haspopup="dialog" aria-controls="course-dialog" data-course-teacher="${esc(r.name)}" data-alias="${esc(r.course_alias||'')}">${esc(r.course_alias||'设置课程')}</button>`}</td>
        <td>${r.joined_at==null?'未记录':new Date(r.joined_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</td></tr>`).join('')||'<tr><td colspan="5">尚未绑定教师。</td></tr>')+'</tbody></table></div>';
  const rosterSearch=teacher?`<header class="group-heading"><h2>我的学生</h2>
    <form id="roster-search" role="search"><input id="roster-query" type="search" placeholder="姓名或账号" aria-label="按学生姓名或账号搜索">
    <button type="submit" aria-label="搜索学生" title="搜索学生"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></button></form></header>
    <p id="roster-no-match" aria-live="polite" hidden>未找到匹配的学生。</p>`:'';
  const content=(message?'<p role="alert">'+esc(message)+'</p>':'')+form+groupPanel+'<section id="roster">'+rosterSearch+roster+'</section>'+
    '<script>for(const f of document.querySelectorAll("form.unbind"))f.onsubmit=async e=>{e.preventDefault();if(await showExamMessage("确认解绑 "+f.elements.student.value+"？已开始作答的试卷仍可继续作答或查看成绩。其余仅向你的学生发布的试卷将不可见。","移除"))f.submit()}</script>';
  if(teacher)return teacherFrame(account,'管理学生',content+`<dialog id="history-dialog" aria-labelledby="history-title"><header><strong id="history-title">历史考试成绩</strong><button type="button" id="close-history" aria-label="关闭历史考试成绩"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div id="history-content"></div></dialog>
    <script>
    const query=document.getElementById('roster-query');
    const students=Array.from(document.querySelector('.student-roster').tBodies[0].rows).filter(row=>row.cells.length>1);
    function filterStudents(){
      const term=query.value.trim().toLowerCase();
      for(const row of students)row.hidden=![row.cells[0],row.cells[1]].some(cell=>cell.textContent.toLowerCase().includes(term));
      document.getElementById('roster-no-match').hidden=!term||!students.length||students.some(row=>!row.hidden);
    }
    query.form.onsubmit=event=>{event.preventDefault();filterStudents();query.focus()};
    query.oninput=filterStudents;
    query.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();query.value='';filterStudents()}};
    const historyDialog=document.getElementById('history-dialog');
    document.querySelector('.student-roster').addEventListener('click',event=>{
      const button=event.target.closest('[data-history]');if(!button)return;
      document.getElementById('history-content').replaceChildren(document.getElementById(button.dataset.history).content.cloneNode(true));
      const url=new URL(location.href);
      url.searchParams.set('historyStudent',button.dataset.student);
      window.history.replaceState(null,'',url);
      historyDialog.dataset.student=button.dataset.student;
      historyDialog.showModal();
    });
    historyDialog.addEventListener('close',()=>{
      const url=new URL(location.href);url.searchParams.delete('historyStudent');window.history.replaceState(null,'',url);
    });
    const requested=new URLSearchParams(location.search).get('historyStudent');
    const trigger=Array.from(document.querySelectorAll('[data-history]')).find(button=>button.dataset.student===requested);
    if(trigger){trigger.focus();trigger.click()}
    document.getElementById('close-history').onclick=()=>historyDialog.close();(${watchPublishedScores.toString()})();</script>`);
  const courseDialog=`<dialog id="course-dialog" aria-labelledby="course-title"><h2 id="course-title">设置课程</h2>
    <form method="post"><input type="hidden" name="teacher"><input name="course" aria-label="课程名" maxlength="64" autofocus placeholder="留空使用教师课程名">
    <div class="row"><button type="button" onclick="this.closest('dialog').close()">取消</button><button name="action" value="course">保存课程</button></div></form></dialog>
    <script>const courseDialog=document.getElementById('course-dialog');
    for(const button of document.querySelectorAll('[data-course-teacher]'))button.onclick=()=>{
      const fields=courseDialog.querySelector('form').elements;
      fields.teacher.value=button.dataset.courseTeacher;fields.course.value=button.dataset.alias;courseDialog.showModal();
    };</script>`;
  const restoreBackLink=`<script>
    if(document.referrer){
      const from=new URL(document.referrer);
      if(from.origin===location.origin && from.pathname==='/'){
        const link=document.querySelector('.people-back');
        link.href=from.href;
        if(from.searchParams.has('paper')){link.title='返回试卷';link.setAttribute('aria-label',link.title)}
      }
    }
  </script>`;
  const current=sourcePaper||currentStudentPaper(account.name)?.id;
  return frame('我的教师',content+courseDialog+restoreBackLink,studentDock('/',current?'/?paper='+current:''),'student-dock',settingsMenu(account),'',backButton('/','返回试卷目录'));
}
function currentStudentPaper(student,resumeId=0){
  return db.prepare(`SELECT a.id,json_extract(p.paper,'$.title') AS title FROM attempts a
        JOIN published_versions p ON p.id=a.id AND p.revision=a.revision
        WHERE a.name=? AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.paper=a.id AND s.name=a.name)
        AND NOT EXISTS(SELECT 1 FROM timed_attempts t WHERE t.id=a.id AND t.name=a.name AND t.deadline<=?)
        ORDER BY (a.id=?) DESC,a.rowid DESC LIMIT 1`).get(student,Date.now(),Number.isSafeInteger(resumeId)?resumeId:0);
}
function studentDock(listHref,paperHref,onPaper=false){
  const current=' aria-current="page"';
  const catalog='<a href="'+esc(listHref)+'"'+(onPaper?'':current)+'>试卷目录</a>';
  const check='onclick="openCurrentExam(event,this)"';
  const paper=paperHref?'<a data-paper-href="'+esc(paperHref)+'" href="'+(onPaper?'#view':esc(paperHref))+'" '+check+(onPaper?current:'')+'>当前考题</a>':
    '<button type="button" class="segment" aria-haspopup="dialog" '+check+'>当前考题</button>';
  const navigation=onPaper?'<button class="segment" id="question-nav-toggle" type="button" aria-controls="question-nav-dialog" aria-haspopup="dialog" aria-expanded="false">题目导航</button>':
    '<button type="button" class="segment" aria-haspopup="dialog" data-paper-href="'+esc(paperHref||'')+'" onclick="openCurrentExam(event,this,true)">题目导航</button>';
  return '<span class="dock-indicator" aria-hidden="true"></span>'+catalog+paper+navigation+'<script>'+openCurrentExam.toString()+'</script>';
}
function bindCatalogExamPrompt(student,active){
  const dialog=document.getElementById('resume-exam-dialog');
  const selectionKey='exam:catalog-selection:'+student;
  let checking=false;
  if(active&&!location.search&&(!sessionStorage.getItem(selectionKey)||!document.referrer||document.referrer.startsWith(location.origin+'/login'))){
    dialog.querySelector('p').textContent='还有正在进行的《'+active.title+'》考试，是否继续作答？';
    dialog.addEventListener('close',()=>{
      sessionStorage.setItem(selectionKey,String(active.id));
      if(dialog.returnValue==='yes')location.assign('/?paper='+active.id+'#resume-question');
    },{once:true});
    dialog.showModal();
  }
  document.addEventListener('click',async event=>{
    const link=event.target.closest('.paper-grid a.paper-card,.catalog-table a[href]');
    if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const target=new URL(link.href);
    const selected=target.searchParams.get('paper');
    if(!selected)return;
    event.preventDefault();
    if(checking)return;
    checking=true;
    try{
      const selection=sessionStorage.getItem(selectionKey);
      const resume=selection||new URLSearchParams(location.search).get('resume')||'';
      const response=await fetch('/api/current-exam?title=1&resume='+encodeURIComponent(resume),{cache:'no-store'});
      if(!response.ok)throw Error();
      const current=await response.json();
      if(current.id&&(!selection||String(current.id)===selection)&&String(current.id)!==selected){
        dialog.querySelector('p').textContent='当前正在进行《'+current.title+'》考试，是否返回考试？';
        dialog.returnValue='';
        const closed=new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));
        dialog.showModal();
        await closed;
        if(dialog.returnValue==='yes'){
          target.searchParams.set('paper',current.id);
          target.hash='resume-question';
        }else if(dialog.returnValue!=='no')return;
      }
      location.assign(target.href);
    }catch{showExamMessage('无法查询当前考试，请重试。')}
    finally{checking=false}
  });
}
async function openCurrentExam(event,control,navigate=false){
  event.preventDefault();
  const preferred=new URL(control.dataset.paperHref||location.href,location.origin).searchParams.get('paper');
  try{
    const response=await fetch('/api/current-exam?resume='+encodeURIComponent(preferred||''));
    if(!response.ok)throw Error();
    const {id}=await response.json();
    if(!id){showExamMessage('无当前正在进行的考试');return false}
    if(navigate){
      const target=new URL(String(id)===preferred?(control.dataset.paperHref||location.href):'/?paper='+id,location.origin);
      target.hash='question-nav';
      if(target.pathname+target.search===location.pathname+location.search){
        history.replaceState(history.state,'',target.href);
        location.reload();
      }else location.assign(target.href);
      return false;
    }
    location.href=String(id)===preferred?control.href:'/?paper='+id;
  }catch{showExamMessage('无法查询当前考试，请重试。')}
}
const authDock = active => (active?'<span class="dock-indicator" aria-hidden="true"></span>':'')+
  ['login'].map((path,i)=>`<a href="/${path}" ${path===active?'aria-current="page"':''}>${i?'注册学生账号':'账号登录'}</a>`).join('');
const login = (message, error=false) => frame('账号登录',`<form method="post">
  <label>用户名<input class="wide" name="name" autocomplete="username" required></label>
  <label>密码<input type="password" class="wide" name="password" autocomplete="current-password" required></label>
  ${message?`<p class="login-message" role="${error?'alert':'status'}">${esc(message)}</p>`:''}
  <div class="row auth-actions"><button>登录</button></div>
  <p class="auth-recovery"><a href="/reset-password">忘记密码？</a></p>
</form>`,'','auth-page');
const register = (message='',name='') => frame('注册学生账号',`
  <form method="post" action="/register">
    <p role="status">${esc(message)}</p>
    <label>用户名<input class="wide" name="name" value="${esc(name)}" autocomplete="username" required aria-describedby="name-help"></label>
    <p class="meta" id="name-help">1 至 64 个字符，可使用中文、字母、数字、点、下划线和短横线。</p>
    <label>密码<input class="wide" type="password" name="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
    <p class="meta">密码长度为 8 至 128 位。</p>
    <label>学生姓名<input class="wide" name="displayName" autocomplete="name" maxlength="64" required></label>
    <label>确认密码<input class="wide" type="password" name="confirm" autocomplete="new-password" maxlength="128" required></label>
    <div class="row auth-actions"><button>注册</button></div>
  </form>`,authDock('register'),'auth-dock');
const resetForm=(message='',name='')=>frame('重置密码',`<form method="post" action="/reset-password">
  <p class="meta">学生请向教师领取重置码。教师请联系网站管理员。</p>
  <label>用户名<input class="wide" name="name" value="${esc(name)}" autocomplete="username" required></label>
  <label>重置码<input class="wide" name="code" autocomplete="one-time-code" spellcheck="false" required></label>
  <label>新密码（8 至 128 位）<input class="wide" type="password" autocomplete="new-password" name="password" minlength="8" maxlength="128" required></label>
  <label>确认新密码<input class="wide" type="password" autocomplete="new-password" name="confirm" required></label>
  ${message?`<p class="login-message" role="alert">${esc(message)}</p>`:''}
  <div class="row auth-actions"><button>重置密码</button></div></form>`,'','auth-page','','',backButton('/login','返回登录'));
const issueForm=(account,message='')=>teacherFrame(account,'学生密码重置',`<form method="post" action="/student-reset">
  <label>学生用户名<input class="wide" name="name" required></label>
  <p class="meta">核对学生身份后，将重置码私下交给本人。重新生成会使上一次的重置码失效。</p>
  ${message}<div class="row auth-actions"><button>生成重置码</button></div></form>`);
const fail = (status,msg) => {throw Object.assign(Error(msg),{status})};
const answerLimit=16*1024*1024;
async function body(req,limit=2*1024*1024) {
  const chunks=[]; let bytes=0;
  for await (const part of req) {
    bytes+=part.length;
    if(bytes>limit) fail(413,limit>answerLimit?'整卷答案最多 16 MiB，请缩短后再试。':'内容过长。');
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString();
}
const jsonBody = async (req,limit) => {
  if(req.headers['content-type']?.split(';')[0]!=='application/json') fail(415,'需要 JSON。');
  try {return JSON.parse(await body(req,limit))} catch(e){if(e.status)throw e;fail(400,'JSON 格式错误。')}
};
const positive = n=>Number.isSafeInteger(Math.round(n*100)) && n>0 && Math.round(n*100)/100===n;
const codeLanguages=new Set(langs);
function paperIcon(action){
  const paths=action==='edit'?'<path d="m4 16-.6 4.6L8 20l12-12-4-4zM14 6l4 4"/>':'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>';
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths+'</svg>';
}
function bindGroupLayout(){
  const panel=document.getElementById('groups'),button=document.getElementById('group-layout-toggle');
  function bindPicker(dialogId,role,accountField,groupKey,belongsToGroup){
    const dialog=document.getElementById(dialogId),picker=dialog.querySelector('form');
    const query=picker.querySelector('[type=search]'),options=picker.querySelector('[role=group]');
    const selected=picker.elements[accountField],groupField=picker.elements[groupKey];
    const submit=picker.querySelector('[type=submit]'),hint=picker.querySelector('[data-empty]');
    function showCandidates(){
      const term=selected.value?'':query.value.trim().toLowerCase();
      let eligible=0,matches=0;
      for(const option of options.children){
        const available=!belongsToGroup(option,groupField.value);
        if(available)eligible++;
        option.hidden=!available||![option.dataset.name,option.dataset.account].some(text=>text.toLowerCase().includes(term));
        if(!option.hidden)matches++;
      }
      options.hidden=!matches;query.disabled=!eligible;
      hint.textContent=(eligible?'没有匹配的':'没有可添加的')+role+'。';
      hint.hidden=Boolean(matches);
    }
    query.onfocus=query.onclick=showCandidates;
    query.oninput=()=>{selected.value='';submit.disabled=true;showCandidates()};
    query.onkeydown=event=>{
      if(event.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='Enter'){
        event.preventDefault();showCandidates();options.querySelector('button:not([hidden])')?.focus();
      }
    };
    options.onclick=event=>{
      const option=event.target.closest('button');
      if(!option)return;
      selected.value=option.dataset.account;
      query.value=option.textContent;submit.disabled=false;hint.hidden=options.hidden=true;submit.focus();
    };
    return (trigger,group)=>{
      picker.reset();selected.value='';groupField.value=group;submit.disabled=true;
      dialog.querySelector('h2').textContent='添加'+role+'到「'+group+'」';
      showCandidates();
      trigger.closest('dialog')?.close();dialog.showModal();
    };
  }
  const openStudent=bindPicker('group-add-student','学生','student','student_group',(option,group)=>option.dataset.group===group);
  const openTeacher=bindPicker('add-group-teacher','教师','colleague','group_name',(option,group)=>JSON.parse(option.dataset.groups).includes(group));
  panel.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-add-teacher],[data-add-student]');
    if(!trigger)return;
    if(trigger.hasAttribute('data-add-teacher'))openTeacher(trigger,trigger.dataset.addTeacher);
    else openStudent(trigger,trigger.dataset.addStudent);
  });
  panel.addEventListener('submit',async event=>{
    const form=event.target;
    if(!form.matches('form.delete-group'))return;
    event.preventDefault();
    const name=form.elements.original.value;
    if(await showExamMessage('删除分组「'+name+'」并将成员移至未分组？','删除'))form.submit();
  });
  const key='exam-student-group-layout';
  function select(grid){
    panel.dataset.layout=grid?'grid':'table';
    button.title=grid?'切换为表格':'切换为宫格';
    button.setAttribute('aria-label',button.title);
  }
  let grid=false;
  try{grid=localStorage.getItem(key)==='grid'}catch{}
  select(grid);
  button.onclick=()=>{
    select(panel.dataset.layout!=='grid');
    try{localStorage.setItem(key,panel.dataset.layout)}catch{}
  };
}
function bindTeacherDrafts(prefix){
  const key=prefix+'teacher-workspace-v1',box=document.getElementById('draft-box');
  const dialog=document.getElementById('new-paper-dialog'),message=dialog.querySelector('p');
  const first=dialog.querySelector('[data-first]'),second=dialog.querySelector('[data-second]');
  let target=null;
  function read(){
    const state=localStorage.getItem(key);
    if(state)return JSON.parse(state);
    const paper=JSON.parse(localStorage.getItem(prefix+'practice-paper-v1'));
    return {active:null,drafts:paper?[{key:'legacy',paper,scope:'own'}]:[]};
  }
  function finish(archive){
    try{
      const state=read();
      if(archive&&state.active){
        const entry=state.drafts.find(d=>d.key===state.editing);
        if(entry)Object.assign(entry,state.active);
        else state.drafts.push({...state.active,key:Date.now()+'-'+Math.random().toString(36).slice(2)});
      }
      state.active=target?state.drafts.find(d=>d.key===target):null;
      if(target&&!state.active)throw Error('草稿已变更，请刷新目录。');
      state.editing=target;delete state.recovery;
      if(state.active)state.active={...state.active,dirty:false};
      localStorage.setItem(key,JSON.stringify(state));
      location.assign('/teacher');
    }catch(error){dialog.close();showExamMessage('无法切换组卷：'+error.message)}
  }
  function start(next){
    target=next;
    const state=read();
    if(!state.active?.dirty||state.drafts.some(d=>d.key===state.editing))return finish(false);
    first.hidden=false;second.hidden=true;
    message.textContent='是否将当前未保存的试卷放入草稿箱？';
    dialog.showModal();
  }
  document.getElementById('new-paper').onclick=()=>start(null);
  dialog.querySelector('[data-yes]').onclick=()=>finish(true);
  dialog.querySelector('[data-no]').onclick=()=>{
    first.hidden=true;second.hidden=false;message.textContent='如何处理当前未保存的试卷？';
    second.querySelector('[data-continue]').focus();
  };
  dialog.querySelector('[data-discard]').onclick=()=>finish(false);
  dialog.querySelector('[data-continue]').onclick=()=>location.assign('/teacher');
  const batch=box.querySelector('[data-batch]'),all=box.querySelector('[data-all]'),remove=box.querySelector('[data-remove]');
  const selected=new Set();
  let multiple=false;
  const layout=box.querySelector('[data-layout-toggle]'),layoutKey=prefix+'draft-layout';
  let tableView=localStorage.getItem(layoutKey)==='table';
  layout.onclick=()=>{
    tableView=!tableView;
    localStorage.setItem(layoutKey,tableView?'table':'grid');
    list();
  };
  function updateSelection(){
    const count=selected.size;
    remove.disabled=!count;
    remove.textContent=count?'删除所选（'+count+'）':'删除所选';
    all.textContent=count&&count===box.querySelectorAll('.paper-check').length?'取消全选':'全选';
  }
  async function erase(keys,label){
    if(!keys.length||!await showExamMessage('确认删除'+label+'？','删除'))return;
    try{
      const state=read();
      state.drafts=state.drafts.filter(d=>!keys.includes(d.key));
      if(keys.includes(state.editing)){
        state.editing=null;
        if(!state.active?.dirty)state.active=null;
      }
      localStorage.setItem(key,JSON.stringify(state));
      multiple=false;list();
    }catch{showExamMessage('草稿删除失败，请重试。')}
  }
  batch.onclick=()=>{multiple=!multiple;selected.clear();list()};
  all.onclick=()=>{
    const checks=Array.from(box.querySelectorAll('.paper-check'));
    const checked=checks.some(input=>!input.checked);
    selected.clear();
    for(const input of checks){input.checked=checked;if(checked)selected.add(input.value)}
    updateSelection();
  };
  remove.onclick=()=>erase([...selected],'所选的 '+selected.size+' 份草稿');
  function list(){
    const grid=box.querySelector('ul'),table=box.querySelector('.draft-table'),body=table.querySelector('tbody');
    grid.replaceChildren();body.replaceChildren();
    const drafts=read().drafts.slice().reverse(),entries=tableView?body:grid;
    for(const key of selected)if(!drafts.some(d=>d.key===key))selected.delete(key);
    table.hidden=!tableView||!drafts.length;
    box.dataset.draftLayout=tableView?'table':'grid';
    layout.title=tableView?'切换为宫格':'切换为表格';layout.setAttribute('aria-label',layout.title);
    for(const draft of drafts){
      const item=document.createElement(tableView?'tr':'li'),card=document.createElement('a');
      card.className='paper-card';card.href='/teacher';
      const title=document.createElement('strong'),meta=document.createElement('span');
      title.textContent=draft.paper.title||'未命名试卷';
      const scope=draft.scope==='all'?'全部学生':draft.scope?.startsWith('group:')?'分组 · '+draft.scope.slice(6):'仅自己学生';
      meta.className='meta';
      meta.textContent=draft.paper.questions.length+' 题 · 满分 '+draft.paper.target+' 分 · '+scope;
      card.append(title,meta);
      function edit(){
        box.close();
        if(draft.editId){
          const state=read();delete state.recovery;localStorage.setItem(key,JSON.stringify(state));
          location.assign('/teacher?paper='+draft.editId+'&draftRevision='+draft.revision);return;
        }
        if(read().editing===draft.key){target=draft.key;finish(false);return}
        start(draft.key);
      }
      const tools=box.querySelector('template').content.firstElementChild.cloneNode(true);
      const [modify,del]=tools.querySelectorAll('button'),check=tools.querySelector('input');
      modify.hidden=del.hidden=multiple;check.hidden=!multiple;
      modify.setAttribute('aria-label','修改草稿 '+title.textContent);modify.onclick=edit;
      del.setAttribute('aria-label','删除草稿 '+title.textContent);del.onclick=()=>erase([draft.key],'草稿《'+title.textContent+'》');
      check.setAttribute('aria-label','选择草稿 '+title.textContent);check.value=draft.key;
      check.onchange=()=>{if(check.checked)selected.add(draft.key);else selected.delete(draft.key);updateSelection()};
      card.onclick=event=>{event.preventDefault();if(multiple)check.click();else edit()};
      check.checked=selected.has(draft.key);
      if(tableView){
        card.className='';card.replaceChildren(title);
        item.insertCell().append(card);
        item.insertCell().textContent=draft.paper.questions.length;
        item.insertCell().textContent=draft.paper.target;
        item.insertCell().textContent=scope;
        item.insertCell().append(tools);
      }else item.append(card,tools);
      entries.append(item);
    }
    box.querySelector('[data-empty]').hidden=Boolean(entries.children.length);
    batch.hidden=!entries.children.length;all.hidden=remove.hidden=!multiple;
    batch.textContent=multiple?'取消':'批量处理';batch.setAttribute('aria-pressed',String(multiple));
    updateSelection();
    document.getElementById('open-draft-box').textContent='草稿箱（'+entries.children.length+'）';
  }
  document.getElementById('open-draft-box').onclick=()=>{multiple=false;selected.clear();list();box.showModal()};
  list();window.addEventListener('pageshow',list);
}
function bindCatalogLayout(){
  const button=document.getElementById('catalog-layout-toggle');
  const main=button.closest('main');
  function select(layout){
    main.dataset.catalogLayout=layout;
    for(const table of main.querySelectorAll('.catalog-table')){
      const cards=table.previousElementSibling.children;
      Array.from(table.querySelectorAll('td.catalog-actions')).forEach((cell,index)=>{
        const target=layout==='list'?cell:cards[index];
        const tools=(layout==='list'?cards[index]:cell).querySelector('.paper-tools');
        if(tools)target.append(tools);
      });
    }
    button.title=layout==='grid'?'切换为列表':'切换为宫格';
    button.setAttribute('aria-label',button.title);
  }
  let initial='grid';
  try{if(localStorage.getItem('exam-catalog-layout')==='list')initial='list'}catch{}
  select(initial);
  button.onclick=()=>{
    const next=main.dataset.catalogLayout==='grid'?'list':'grid';
    select(next);
    try{localStorage.setItem('exam-catalog-layout',next)}catch{}
  };
}
function paperManagement(){
  const roster=document.getElementById('attendance-dialog');
  let request;
  roster.onclose=()=>request?.abort();
  async function showRoster(button){
    const body=roster.querySelector('[data-roster]');
    document.getElementById('attendance-title').textContent=button.dataset.title+' · 考试名单';
    body.textContent='正在加载名单…';
    roster.showModal();
    const controller=new AbortController();
    request=controller;
    try{
      const response=await fetch('/api/papers/attendance?paper='+button.dataset.attendance,{signal:controller.signal});
      if(!response.ok)throw Error(await response.text());
      const rows=await response.json();
      body.replaceChildren();
      const submitted=rows.filter(row=>row.submitted);
      for(const link of document.querySelectorAll('[data-attendance="'+button.dataset.attendance+'"] span'))link.textContent=submitted.length+' / '+rows.length;
      for(const [label,students] of [['已交卷',submitted],['未交卷',rows.filter(row=>!row.submitted)]]){
        const heading=document.createElement('h3');
        heading.textContent=label+'（'+students.length+' 人）';
        body.append(heading);
        const table=document.createElement('table');
        table.setAttribute('aria-label',label+'学生名单');
        table.innerHTML='<thead><tr><th>姓名</th><th>账号</th><th>分组</th></tr></thead>';
        const tbody=table.createTBody();
        for(const student of students){
          const tr=tbody.insertRow();
          for(const value of [student.display_name||'未填写',student.name,student.student_group||'未分组'])tr.insertCell().textContent=value;
        }
        if(!students.length){
          const cell=tbody.insertRow().insertCell();
          cell.colSpan=3;cell.textContent='暂无'+label+'学生';
        }
        body.append(table);
      }
    }catch(error){if(!controller.signal.aborted)body.textContent=error.message||'加载失败，请重新打开名单。'}
  }
  for(const button of document.querySelectorAll('[data-attendance]'))button.onclick=()=>showRoster(button);
  const section=document.getElementById('batch-toggle')?.closest('section');
  const checks=Array.from(section?.querySelectorAll('.paper-check')||[]);
  const toggle=document.getElementById('batch-toggle');
  const all=document.getElementById('batch-all');
  const remove=document.getElementById('batch-delete');
  let busy=false;
  async function erase(ids){
    if(busy||!ids.length)return;
    busy=true;
    try{
      const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})};
      const check=await fetch('/api/papers/delete?check=1',options);
      if(!check.ok)throw Error(await check.text());
      if(!await showExamMessage('确认删除试卷（编号 '+ids.join('、')+'）？删除后学生将无法打开这些试卷。','删除')){busy=false;return}
      const response=await fetch('/api/papers/delete',options);
      if(!response.ok)throw Error(await response.text());
      location.reload();
    }catch(error){busy=false;showExamMessage(error.message||'删除失败，请重试。')}
  }
  document.querySelectorAll('[data-delete]').forEach(button=>button.onclick=()=>erase([Number(button.dataset.delete)]));
  if(!toggle)return;
  function update(){
    const count=checks.filter(box=>box.checked).length;
    remove.disabled=!count;
    remove.textContent=count?'删除所选（'+count+'）':'删除所选';
    all.textContent=count===checks.length?'取消全选':'全选';
  }
  toggle.onclick=()=>{
    const active=toggle.getAttribute('aria-pressed')==='false';
    toggle.setAttribute('aria-pressed',String(active));
    toggle.textContent=active?'取消':'批量处理';
    remove.hidden=all.hidden=!active;
    checks.forEach(box=>{box.hidden=!active;box.checked=false});
    section.querySelectorAll('.paper-tools .paper-icon').forEach(icon=>icon.hidden=active);
    update();
  };
  checks.forEach(box=>box.onchange=update);
  all.onclick=()=>{
    const select=checks.some(box=>!box.checked);
    checks.forEach(box=>box.checked=select);
    update();
  };
  remove.onclick=()=>erase(checks.filter(box=>box.checked).map(box=>Number(box.value)));
}
function validPaper(p) {
  const unfinished=Array.isArray(p?.questions)?p.questions.findIndex(q=>q?.type===3&&hasBlankPlaceholder(q.referenceAnswer)):-1;
  if(unfinished>=0)fail(422,'第 '+(unfinished+1)+' 题的参考答案还有填空占位符，请填写完整。');
  return p && (p.aiGrading===undefined||typeof p.aiGrading==='boolean') && typeof p.title==='string' && p.title.trim() && positive(p.target) && (p.minutes===undefined || Number.isSafeInteger(p.minutes) && p.minutes>=0 && p.minutes<=10080) && Array.isArray(p.questions) && p.questions.length>0 && p.questions.length<=600 && p.questions.every(q=>q && validQuestionTables(q) && (q.sharedStem===undefined||typeof q.sharedStem==='string'&&q.sharedStem.length<=20000) && (q.customType===undefined||typeof q.customType==='string'&&q.customType.trim().length>0&&q.customType.length<=64) && Number.isInteger(q.type) && q.type>=0 && q.type<=5 && (q.codeBlocks===undefined || Array.isArray(q.codeBlocks) && q.codeBlocks.every(b=>b && typeof b.code==='string' && (b.followingText===undefined || typeof b.followingText==='string') && codeLanguages.has(b.language))) && (q.type!==5 || q.defaultLanguage===undefined || codeLanguages.has(q.defaultLanguage)) && (q.testCases===undefined || q.type===5&&validCases(q.testCases)) && (q.referenceAnswer===undefined || (q.type<=3?Boolean(parseKey(q,q.referenceAnswer)):typeof q.referenceAnswer==='string'&&q.referenceAnswer.trim())) && positive(q.score) && typeof q.prompt==='string' && (q.prompt.trim() || q.codeBlocks?.some(b=>b.followingText?.trim()||([0,1,3].includes(q.type)&&b.code?.trim()))) && (q.type>=2 || Array.isArray(q.options) && q.options.length>=2 && q.options.length<=26 && q.options.every(x=>typeof x==='string' && x.trim()))) && p.questions.reduce((sum,q)=>sum+Math.round(q.score*100),0)===Math.round(p.target*100);
}
function examplesInPrompt(q){
  if(q.type!==5||!q.codeBlocks?.length)return false;
  const embedded=casesFor({...q,testCases:undefined}),cases=casesFor(q);
  return embedded.length===cases.length&&cases.every((c,i)=>c.input===embedded[i].input&&c.output===embedded[i].output);
}
function studentPaper(paper,unstarted,submitted){
  if(unstarted)return {title:paper.title,minutes:paper.minutes,questions:paper.questions.map(({type,score,customType})=>({type,score,...(customType?{customType}:{})}))};
  return {...paper,questions:paper.questions.map(({referenceAnswer,...q})=>{
    if(submitted&&referenceAnswer)q.referenceAnswer=referenceAnswer;
    if(q.type===5){
      q.examplesInPrompt=examplesInPrompt(q);
      q.testCases=casesFor(q);
    }
    return q;
  })};
}
function validAnswers(qs,a) {
  if(!Array.isArray(a)||a.length>qs.length)return false;
  return a.every((x,i)=>{
    const q=qs[i];
    if(x==null)return true;
    const option=n=>Number.isInteger(n)&&n>=0&&n<(q.type===2?2:q.options.length);
    if(q.type===1)return Array.isArray(x)&&new Set(x).size===x.length&&x.every(option);
    if(q.type===3&&Array.isArray(x))return x.length>0&&x.length===questionBlankCount(q)&&x.every(text=>typeof text==='string');
    if(x.parts!==undefined){
      const numbers=subquestionNumbers(q),parts=x.parts;
      return numbers.length>0 && parts && typeof parts==='object' && !Array.isArray(parts) &&
        Object.entries(parts).every(([n,text])=>numbers.includes(n)&&typeof text==='string') &&
        (q.type!==5||codeLanguages.has(x.language));
    }
    if(q.type===5 && typeof x==='object')return !Array.isArray(x)&&typeof x.code==='string'&&codeLanguages.has(x.language);
    return q.type<=2?option(x):typeof x==='string';
  });
}
const digest = token=>createHash('sha256').update(token).digest('hex');
const gradeTotal=scores=>scores.reduce((sum,n)=>sum+Math.round(n*100),0)/100;
function roster(id){
  const rows=db.prepare(`SELECT a.name,u.display_name,s.paper IS NOT NULL AS done,g.scores,g.reviewed,r.filename
    FROM attempts a JOIN accounts u ON u.name=a.name
    LEFT JOIN submissions s ON s.paper=a.id AND s.name=a.name
    LEFT JOIN grades g ON g.paper=a.id AND g.name=a.name
    LEFT JOIN answer_archives r ON r.paper=a.id AND r.name=a.name
    WHERE a.id=? ORDER BY done DESC,u.display_name,a.name`).all(id);
  return '<section><h2>学生答卷</h2>'+(rows.length?'<table><thead><tr><th>学生</th><th>成绩</th><th>答卷</th></tr></thead><tbody>'+rows.map(r=>
    '<tr><td>'+esc(r.display_name||r.name)+(r.display_name?' <small>'+esc(r.name)+'</small>':'')+'</span>'+'</td><td>'+
    (r.scores?gradeTotal(JSON.parse(r.scores))+' 分'+(r.reviewed?'（已公布）':'（待教师确认）'):r.done?'待评分':'作答中')+'</td><td>'+
    (r.done?'<a href="/?paper='+id+'&amp;student='+encodeURIComponent(r.name)+'">'+esc(r.filename?.replace(/\.json$/,'')||'查看并评分')+'</a>':'未交卷')+'</td></tr>'
  ).join('')+'</tbody></table>':'<p>暂无学生答题记录。</p>')+'</section>';
}
function getSubmission(id,name,history=false){
  return db.prepare(`SELECT p.paper,s.answers,u.display_name,a.revision,g.scores,g.reviewed,g.auto_scores,COALESCE(g.version,0) AS version
    FROM submissions s JOIN attempts a ON a.id=s.paper AND a.name=s.name
    JOIN ${history?'paper_versions':'published_versions'} p ON p.id=a.id AND p.revision=a.revision JOIN accounts u ON u.name=s.name
    LEFT JOIN grades g ON g.paper=s.paper AND g.name=s.name WHERE s.paper=? AND s.name=?`).get(id,name);
}
function readOnlyCode(code,language){
  return '<div class="question-snippet code-editor"><div class="code-toolbar"><span class="code-lights" aria-hidden="true"><i></i><i></i><i></i></span><span>'+esc(language)+'</span></div><pre class="snippet-source"><code data-language="'+esc(language)+'">'+esc(code)+'</code></pre></div>';
}
function studentAnswer(q,value){
  if(value==null || value==='' || Array.isArray(value)&&!value.length)return '未作答';
  if(q.type===2)return ['正确','错误'][value];
  if(q.type<2)return [value].flat().map(i=>String.fromCharCode(65+i)+'. '+q.options[i]).join('\n');
  if(q.type===3&&Array.isArray(value))return formatBlanks(value.map(text=>text||'未作答'));
  return value;
}
function referenceText(q){
  if(q.type===3&&q.referenceAnswer)return formatBlanks(parseKey(q,q.referenceAnswer));
  return q.referenceAnswer;
}
function renderAnswerPdf(id,submission,student,theme){
  const paper=JSON.parse(submission.paper),answers=JSON.parse(submission.answers),scores=JSON.parse(submission.scores);
  const types=['单选题','多选题','判断题','填空题','简答题','编程题'];
  const counts=types.map(()=>0);
  const items=paper.questions.map((q,i)=>{
    const value=answers[i],language=q.type===5?(q.defaultLanguage||'Python'):null;
    const answer=value?.parts?subquestionText(q,value):q.type===5?(typeof value==='string'?value:value?.code):studentAnswer(q,value);
    return {type:q.type,heading:(q.customType||types[q.type])+' 第 '+(++counts[q.type])+' 题 · '+scores[i]+' / '+q.score+' 分',
      prompt:(q.sharedStem?'共用题干\n'+q.sharedStem+'\n\n':'')+q.prompt,tables:q.tables??[],blocks:q.codeBlocks??[],choices:q.type===2?['正确','错误']:(q.options??[]).map((text,n)=>String.fromCharCode(65+n)+'. '+text),
      cases:casesFor(q),answer:answer||'未作答',reference:referenceText(q)||'教师未提供',
      answerLanguage:language&&(value?.language||language),referenceLanguage:q.type===4?'text':language};
  }).sort((a,b)=>a.type-b.type);
  const payload={id,student,theme,title:paper.title,revision:submission.revision,score:gradeTotal(scores),max:paper.target,items};
  return new Promise((resolve,reject)=>{
    const child=execFile(bundledExecutable('EXAM_PDF_PYTHON',process.platform==='win32'?'python/python.exe':'python/bin/python3'),
      [fileURLToPath(new URL('./answer_pdf.py',import.meta.url))],
      {windowsHide:true,encoding:'buffer',timeout:120000,maxBuffer:64*1024*1024},(error,pdf)=>error?reject(error):resolve(pdf));
    child.stdin.on('error',reject);
    child.stdin.end(JSON.stringify(payload));
  });
}
function reviewAnswer(q,value,reference=false){
  if(q.type>=4){
    const language=q.type===4?'text':(value?.language||q.defaultLanguage||'Python');
    const text=typeof value==='string'?value:value?.code;
    return readOnlyCode(text||(reference?'未提供':'未作答'),language);
  }
  return '<p class="prompt">'+esc(reference?(referenceText(q)||'未提供'):studentAnswer(q,value))+'</p>';
}
function reviewResponses(q,value,history){
  const numbers=subquestionNumbers(q);
  if(numbers.length){
    const student=subquestionParts(numbers,value),reference=subquestionParts([...numbers,...(Array.isArray(q.referencePartOrder)?q.referencePartOrder:[])],q.referenceAnswer);
    return numbers.map(n=>'<section class="subquestion-review"><h4>小题 ('+n+')</h4><strong>学生作答</strong>'+
      readOnlyCode(student[n]||'未作答',q.type===4?'text':value?.language||q.defaultLanguage||'Python')+
      '<strong>参考答案</strong>'+reviewAnswer(q,reference[n],true)+'</section>').join('');
  }
  return '<strong>学生作答</strong>'+reviewAnswer(q,value)+((q.referenceAnswer||history||q.type>=4)?'<strong>参考答案</strong>'+reviewAnswer(q,q.referenceAnswer,true):'');
}
function gradeControl(index,score,max){
  const button=(direction,label,path)=>`<button type="button" data-grade-step="${direction}" aria-label="${label}本题得分"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`;
  return `<div class="score-field"><label for="grade-${index}">本题得分</label><span class="score-control">
    ${button(-1,'减少','M3 8h10')}<input id="grade-${index}" class="score" type="number" name="score" data-index="${index}" value="${score??''}" placeholder="—" min="0" max="${max}" step="0.01" required>${button(1,'增加','M3 8h10M8 3v10')}
    </span><span>/ ${max} 分</span></div>`;
}
function reviewTestControls(q,index){
  const cases=casesFor(q);
  if(!cases.length)return '<p>本题未配置测试用例。</p>';
  const id='review-cases-'+index;
  return `<div data-review-controls><div class="row case-actions">
    <button type="button" class="case-toggle" aria-haspopup="dialog" aria-controls="${id}">测试用例（${cases.length}/${cases.length}）</button>
    <button type="button" data-review-test="${index}">运行测试</button></div>
    <dialog id="${id}" class="case-dialog" aria-labelledby="${id}-title"><h2 id="${id}-title">选择测试用例</h2><label class="grading-toggle case-switch">全选<input type="checkbox" role="switch" data-case-all checked><span class="theme-switch" aria-hidden="true"></span></label><div class="case-list">
    ${cases.map((c,n)=>`<div class="case-item"><details><summary>用例 ${n+1}</summary>${c.input?'<p>示例输入</p><pre>'+esc(c.input)+'</pre>':''}<p>预期输出</p><pre>${esc(c.output||'（空）')}</pre></details><label class="grading-toggle case-switch"><input type="checkbox" role="switch" aria-label="用例 ${n+1}" value="${n}" checked><span class="theme-switch" aria-hidden="true"></span></label></div>`).join('')}
    </div><div class="row"><button type="button" class="case-cancel">取消</button><button type="button" class="case-confirm">确定</button></div></dialog>
    <div class="test-result" role="status"></div></div>`;
}
function bindGrading(){
  const form=document.getElementById('grading');
  const inputs=Array.from(form.querySelectorAll('input[name="score"]')).sort((a,b)=>Number(a.dataset.index)-Number(b.dataset.index));
  function update(){
    const sum=inputs.reduce((n,input)=>n+Math.round((input.valueAsNumber||0)*100),0)/100;
    form.querySelector('output').textContent='合计 '+sum+' 分';
  }
  form.addEventListener('click',event=>{
    const button=event.target.closest('[data-grade-step]');
    if(!button)return;
    const input=button.closest('.score-control').querySelector('input');
    const cents=Math.round((input.valueAsNumber||0)*100)+Number(button.dataset.gradeStep)*50;
    input.value=Math.max(0,Math.min(cents,Math.round(Number(input.max)*100)))/100;
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  for(const controls of form.querySelectorAll('[data-review-controls]')){
    const run=controls.querySelector('[data-review-test]'),toggle=controls.querySelector('.case-toggle');
    const dialog=controls.querySelector('dialog'),result=controls.querySelector('.test-result');
    const boxes=Array.from(dialog.querySelectorAll('.case-list input'));
    const all=dialog.querySelector('[data-case-all]');
    const syncAll=()=>{all.checked=boxes.every(box=>box.checked)};
    all.onchange=()=>{for(const box of boxes)box.checked=all.checked};
    dialog.querySelector('.case-list').onchange=syncAll;
    const selected=()=>boxes.filter(box=>box.checked).map(box=>Number(box.value));
    let caseIndices=selected();
    toggle.onclick=()=>{
      for(const box of boxes)box.checked=caseIndices.includes(Number(box.value));
      syncAll();
      for(const item of dialog.querySelectorAll('.case-item details[open]'))item.open=false;
      dialog.showModal();
    };
    dialog.querySelector('.case-cancel').onclick=()=>dialog.close();
    dialog.querySelector('.case-confirm').onclick=()=>{
      const next=selected();
      dialog.close();
      if(next.length===caseIndices.length&&next.every((n,i)=>n===caseIndices[i]))return;
      caseIndices=next;
      toggle.textContent='测试用例（'+caseIndices.length+'/'+boxes.length+'）';
      run.disabled=!caseIndices.length;
      result.textContent=run.disabled?'请至少选择一组测试用例。':'';
    };
    run.onclick=async()=>{
      run.disabled=toggle.disabled=true;
      result.textContent='正在排队或运行测试…';
      const stopStatus=watchProgramTestStatus(result);
      try{
        const response=await fetch('/api/review-program-test',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({id:Number(form.dataset.paper),name:form.dataset.student,index:Number(run.dataset.reviewTest),caseIndices})});
        if(!response.ok)throw Error(await response.text());
        const {passed,details}=await response.json();
        stopStatus();
        result.textContent='通过 '+passed+' / '+details.length+' 组';
        details.forEach((row,i)=>{
          const section=document.createElement('details'),summary=document.createElement('summary');
          summary.textContent='用例 '+(caseIndices[i]+1)+' · '+row.status;
          section.open=row.status!=='通过';section.append(summary);
          const pre=document.createElement('pre');
          pre.textContent=(row.input?'示例输入：'+row.input+'\n':'')+'预期输出：'+(row.output||'（空）')+'\n实际输出：'+(row.actual||'（无输出）')+(row.diagnostic?'\n诊断信息：'+row.diagnostic:'');
          section.append(pre);result.append(section);
        });
      }catch(error){stopStatus();result.textContent=error.message}finally{stopStatus();run.disabled=false;toggle.disabled=false}
    };
  }
  form.oninput=update;update();
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=form.querySelector('button[type="submit"]');
    if(button.disabled)return;
    button.disabled=true;
    try{
      const response=await fetch('/api/grades',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:Number(form.dataset.paper),name:form.dataset.student,version:Number(form.dataset.version),scores:inputs.map(el=>el.valueAsNumber)})});
      if(!response.ok)throw Error(await response.text());
      form.dataset.version=(await response.json()).version;
      showExamMessage('评分已保存，学生可查看成绩。');
    }catch(error){showExamMessage(error.message)}finally{button.disabled=false}
  };
}
const secure = process.env.COOKIE_SECURE==='1'?'; Secure':'';
const cookie = (v,age)=>`exam_session=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
const failures=new Map();
async function handleRequest(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  const send=(status,data,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(data)};
  const html=(data,status=200)=>send(status,data,'text/html; charset=utf-8');
  const redirect=url=>{res.writeHead(303,{Location:url});res.end()};
  try{
    const url=new URL(req.url,'http://localhost');
    const path=url.pathname;
    if(!['GET','POST'].includes(req.method))return send(405,'请求方法无效。');
    if(path==='/offline-exam-sw.js'&&req.method==='GET')return send(200,offlineWorker,'application/javascript');
    if(Object.hasOwn(styles.assets,path)){
      const type=path==='/favicon.svg'?'image/svg+xml':'text/css';
      if(req.method!=='GET')return send(405,'请求方法无效。');
      const encodings=(req.headers['accept-encoding']||'').split(',').map(part=>part.trim().split(';'));
      const acceptsGzip=encodings.some(([name,...parameters])=>name.toLowerCase()==='gzip'&&!parameters.some(p=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(p)));
      const asset=publicAssets.get(path)[acceptsGzip?'gzip':'identity'];
      res.setHeader('Cache-Control','public, max-age=0, must-revalidate');
      res.setHeader('Vary','Accept-Encoding');res.setHeader('ETag',asset.etag);
      if((req.headers['if-none-match']||'').split(',').some(tag=>tag.trim()===asset.etag||tag.trim()==='*')){res.writeHead(304);return res.end()}
      if(acceptsGzip)res.setHeader('Content-Encoding','gzip');
      res.setHeader('Content-Length',asset.body.length);
      return send(200,asset.body,type+'; charset=utf-8');
    }
    const post=req.method==='POST';
    if(post && req.headers.origin && new URL(req.headers.origin).host!==req.headers.host) return send(403,'来源不匹配。');
    const key=digest((req.headers.cookie||'').match(/(?:^|;\s*)exam_session=([\w-]+)/)?.[1]||'');
    const account=db.prepare('SELECT a.name,a.role,a.display_name,a.course FROM sessions s JOIN accounts a ON a.name=s.name WHERE s.token=? AND s.expires>?').get(key,Date.now());
    if(account)res.setHeader('X-Offline-Owner',encodeURIComponent(account.name));
    if(path==='/student-reset'){
      if(!account)return redirect('/login');
      if(account.role!=='teacher')return send(403,'仅教师可生成重置码。');
      if(!post)return html(issueForm(account));
      const fields=new URLSearchParams(await body(req));
      const name=(fields.get('name')||'').trim();
      const managed=db.prepare('SELECT 1 FROM teacher_students WHERE teacher=? AND student=? AND (can_reset=1 OR teacher=?)').get(account.name,name,'teacher');
      const code=managed?issueReset(db,name,true):null;
      if(fields.get('from')==='students')return html(peoplePage(account,code?name+' 的密码重置码为 '+code+'，15 分钟内有效。请私下交给学生本人。':'未找到可由你重置密码的学生账号。'),code?200:400);
      return code?html(issueForm(account,`<p role="status">${esc(name)} 的重置码（15 分钟有效）<br><code>${code}</code></p>`))
        :html(issueForm(account,'<p class="login-message" role="alert">未找到可由你重置密码的学生账号。</p>'),400);
    }
    if(path==='/reset-password'){
      if(!post)return html(resetForm());
      const form=new URLSearchParams(await body(req));
      const name=(form.get('name')||'').trim(),password=form.get('password')||'';
      if(password.length<8 || password.length>128 || password!==form.get('confirm'))return html(resetForm('请输入 8 至 128 位新密码，并确保两次输入一致。',name),400);
      const hashCode=resetDigest((form.get('code')||'').trim());
      const params=[name,hashCode];
      const match='WHERE name=? AND digest=? AND expires>?';
      const invalid=()=>html(resetForm('用户名或重置码无效，或重置码已过期。',name),400);
      if(!db.prepare('SELECT 1 FROM password_resets '+match).get(...params,Date.now()))return invalid();
      const salt=randomBytes(16).toString('hex');
      const hash=await derive(password,salt,32);
      db.exec('BEGIN IMMEDIATE');
      try{
        if(!db.prepare('DELETE FROM password_resets '+match).run(...params,Date.now()).changes){
          db.exec('ROLLBACK');return invalid();
        }
        db.prepare('UPDATE accounts SET salt=?, hash=? WHERE name=?').run(salt,hash.toString('hex'),name);
        db.prepare('DELETE FROM sessions WHERE name=?').run(name);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error}
      return redirect('/login?reset=1');
    }
    if(path==='/register')return send(403,'账号由管理员或教师创建。');
    if(false){
      if(!post)return html(register());
      const form=new URLSearchParams(await body(req));
      const name=(form.get('name')||'').trim();
      const password=form.get('password')||'';
      if(!validName(name))return html(register('请按下方规则填写用户名。',name.slice(0,128)),400);
      if(password.length<8 || password.length>128)return html(register('请输入 8 至 128 位密码。',name),400);
      if(password!==form.get('confirm'))return html(register('两次输入的密码不一致。',name),400);
      const displayName=(form.get('displayName')||'').trim();
      if(displayName.length>64)return html(register('姓名最多 64 个字符。',name),400);
      const created=await createAccount(db,name,'student',password,displayName||null);
      if(!created)return html(register('该用户名已被使用，请换一个。',name),409);
      return redirect('/login?registered=1');
    }
    const resumePaper=/^[1-9]\d*$/.test(url.searchParams.get('paper')||'')?url.searchParams.get('paper'):null;
    if(path==='/login'){
      if(!post)return html(login(url.searchParams.get('registered')==='1'?'注册成功，请使用新账号登录。':url.searchParams.get('reset')==='1'?'密码已重置，请使用新密码登录。':''));
      const form=new URLSearchParams(await body(req));
      const name=form.get('name')||'';
      const now=Date.now();
      for(const [id,v] of failures)if(v.until<=now)failures.delete(id);
      const rateKey=req.socket.remoteAddress+'|'+name.slice(0,64);
      const rate=failures.get(rateKey)||{count:0,until:now+300000};
      if(rate.count>=10)return html(login('尝试次数过多，请稍后重试。',true),429);
      rate.count++; failures.set(rateKey,rate);
      const row=db.prepare('SELECT * FROM accounts WHERE name=?').get(name);
      const hash=await derive(form.get('password')||'',row?.salt||'unknown-account',32);
      if(!row||!timingSafeEqual(hash,Buffer.from(row.hash,'hex'))||db.prepare('SELECT hash FROM accounts WHERE name=?').get(name)?.hash!==row.hash)return html(login('用户名或密码错误。',true),401);
      failures.delete(rateKey);
      const token=randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires<=? OR token=?').run(now,key);
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),name,now+12*3600000);
      res.setHeader('Set-Cookie',cookie(token,43200));return redirect(row.role==='admin'?'/management':row.role==='teacher'?'/teacher':resumePaper?'/?paper='+resumePaper:'/');
    }
    if(account?.role==='admin'&&path!=='/logout'){return await manageAccounts({req,db,account,path,html,send,redirect,frame,body,logout});}
    if(!account)return path.startsWith('/api/')?send(401,'登录已过期，请重新登录。'):redirect(resumePaper?'/login?paper='+resumePaper:'/login');
    const accessiblePaper = `(? IN (SELECT account FROM paper_access WHERE id=original.id
      ${account.role==='student'?'UNION ALL SELECT name FROM attempts WHERE id=original.id':''})
      ${account.role==='student'?"OR original.audience='all'":''})`;
    const expectedStudent=`student.role='student' AND (original.audience='all' OR student.name IN (
      SELECT account FROM paper_access WHERE id=original.id
      UNION SELECT name FROM attempts WHERE id=original.id
      UNION SELECT name FROM submissions WHERE paper=original.id
    ))`;
    if(req.method==='GET'&&path==='/api/papers/attendance'){
      if(account.role!=='teacher')return send(403,'仅教师可查看考试名单。');
      const id=Number(url.searchParams.get('paper'));
      const paper=db.prepare('SELECT id FROM papers WHERE id=? AND teacher=? AND id NOT IN (SELECT id FROM deleted_papers)').get(id,account.name);
      if(!paper)return send(404,'未找到该试卷。');
      const rows=db.prepare(`SELECT student.display_name,student.name,b.student_group,s.paper IS NOT NULL AS submitted
        FROM papers original JOIN accounts student ON ${expectedStudent}
        LEFT JOIN teacher_students b ON b.teacher=original.teacher AND b.student=student.name
        LEFT JOIN submissions s ON s.paper=original.id AND s.name=student.name
        WHERE original.id=? ORDER BY student.display_name,student.name`).all(id);
      return send(200,JSON.stringify(rows),'application/json');
    }
    const canOpen=id=>Boolean(db.prepare('SELECT 1 FROM papers original WHERE original.id=? AND '+accessiblePaper).get(id,account.name));
    if(req.method==='GET'&&path==='/api/answer-pdf'){
      if(account.role!=='student')return send(403,'请使用学生账号下载。');
      const id=Number(url.searchParams.get('paper'));
      if(!Number.isSafeInteger(id)||!canOpen(id))return send(404,'未找到答卷。');
      const submission=getSubmission(id,account.name,true);
      if(!submission)return send(404,'未找到已交卷的答卷。');
      if(!submission.reviewed)return send(403,'教师公布最终成绩后可下载 PDF。');
      const pdf=await renderAnswerPdf(id,submission,account.display_name||account.name,url.searchParams.get('theme')==='dark'?'dark':'light');
      const filename=JSON.parse(submission.paper).title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)+'-已评答卷.pdf';
      res.setHeader('Content-Disposition',"attachment; filename=exam-"+id+".pdf; filename*=UTF-8''"+encodeURIComponent(filename).replace(/'/g,'%27'));
      return send(200,pdf,'application/pdf');
    }
    if(!post&&path==='/api/current-exam'&&account.role==='student'){
      const active=currentStudentPaper(account.name,Number(url.searchParams.get('resume')));
      return send(200,JSON.stringify({id:active?.id??null,...(url.searchParams.has('title')&&active?{title:active.title}:{})}),'application/json');
    }
    if(!post&&path==='/api/published-scores'){
      if(account.role==='student'&&url.searchParams.has('paper')){
        const report=studentScoreReport(Number(url.searchParams.get('paper')),account.name);
        return report?send(200,JSON.stringify(report),'application/json'):send(404,'未找到已交卷的答卷。');
      }
      const rows=account.role==='teacher'
        ?db.prepare(`SELECT g.paper,g.scores FROM grades g JOIN papers p ON p.id=g.paper
          JOIN teacher_students b ON b.teacher=p.teacher AND b.student=g.name
          WHERE b.teacher=? AND b.student=? AND g.reviewed=1`).all(account.name,url.searchParams.get('student'))
        :url.searchParams.get('catalog')==='1'
          ?db.prepare('SELECT paper,scores FROM grades WHERE name=? AND reviewed=1').all(account.name)
          :db.prepare('SELECT paper,scores FROM grades WHERE name=? AND paper=? AND reviewed=1')
          .all(account.name,Number(url.searchParams.get('paper')));
      return send(200,JSON.stringify(rows.map(row=>({paper:row.paper,total:gradeTotal(JSON.parse(row.scores))}))),'application/json');
    }
    if(path==='/students'||path==='/teachers'){
      if((path==='/students')!==(account.role==='teacher'))return send(403,'无法访问此页面。');
      if(!post){
        const sourceId=Number(url.searchParams.get('paper'));
        return html(peoplePage(account,'',path==='/teachers'&&sourceId&&canOpen(sourceId)?sourceId:''));
      }
      const data=new URLSearchParams(await body(req)),name=(data.get('student')||'').trim(),action=data.get('action');
      if(action==='course'){
        const course=data.get('course')?.trim();
        if(course==null||course.length>64)return html(peoplePage(account,'课程名最多 64 个字符。'),400);
        if(path==='/students')db.prepare('UPDATE accounts SET course=? WHERE name=?').run(course||null,account.name);
        else {
          const teacher=data.get('teacher')||'';
          const updated=db.prepare(`UPDATE teacher_students SET course_alias=? WHERE student=? AND teacher=?
            AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=teacher_students.teacher AND COALESCE(a.course,'')='')`).run(course||null,account.name,teacher);
          if(!updated.changes){
            if(!db.prepare('SELECT 1 FROM teacher_students WHERE student=? AND teacher=?').get(account.name,teacher))return send(404,'未找到已绑定的教师。');
            return html(peoplePage(account,'教师已设置课程名。',Number(url.searchParams.get('paper'))||''),409);
          }
        }
        return redirect(path+(path==='/teachers'?url.search:''));
      }
      if(path!=='/students')return send(405,'请求方法无效。');
      if(action==='add-group-teacher'){
        const group=data.get('group_name'),colleague=data.get('colleague')?.trim();
        if(!studentGroups(account.name).includes(group))return html(peoplePage(account,'分组不存在。'),404);
        if(colleague===account.name)return html(peoplePage(account,'你已是该分组的创建者。'),400);
        if(!db.prepare("SELECT 1 FROM accounts WHERE name=? AND role='teacher'").get(colleague||''))return html(peoplePage(account,'未找到该教师账号。'),404);
        const result=db.prepare('INSERT OR IGNORE INTO group_teachers(owner,group_name,teacher) VALUES(?,?,?)').run(account.name,group,colleague);
        if(!result.changes)return html(peoplePage(account,'该教师已加入分组。'),409);
        return redirect('/students#groups');
      }
      if(['create-group','rename-group','delete-group'].includes(action)){
        const teacher=account.name,original=data.get('original'),group=data.get('group_name')?.trim();
        if(action!=='delete-group'&&(!group||group.length>64))return html(peoplePage(account,'请输入 1 至 64 个字符的分组名称。'),400);
        db.exec('BEGIN IMMEDIATE');
        try{
          const names=studentGroups(teacher);
          if(action!=='create-group'&&!names.includes(original))fail(404,'分组已删除或改名，请返回重新选择。');
          if(action!=='delete-group'&&names.includes(group)&&(action==='create-group'||original!==group))fail(409,'已有同名分组。');
          if(action==='create-group'){
            db.prepare('INSERT INTO student_groups(teacher,name) VALUES(?,?)').run(teacher,group);
          }else if(action==='rename-group'){
            db.prepare('UPDATE student_groups SET name=? WHERE teacher=? AND name=?').run(group,teacher,original);
            db.prepare('UPDATE teacher_students SET student_group=? WHERE teacher=? AND student_group=?').run(group,teacher,original);
            db.prepare('UPDATE papers SET student_group=? WHERE teacher=? AND student_group=? AND group_retired=0').run(group,teacher,original);
          }else{
            db.prepare('DELETE FROM student_groups WHERE teacher=? AND name=?').run(teacher,original);
            db.prepare('UPDATE teacher_students SET student_group=NULL WHERE teacher=? AND student_group=?').run(teacher,original);
            db.prepare('UPDATE papers SET group_retired=1 WHERE teacher=? AND student_group=?').run(teacher,original);
          }
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');if(error.status)return html(peoplePage(account,error.message),error.status);throw error}
        return redirect('/students#groups');
      }
      if(!validName(name))return html(peoplePage(account,'请输入有效的学生账号。'),400);
      if(action==='create'){
        const password=data.get('password')||'',display=(data.get('display')||'').trim();
        if(password.length<8||password.length>128||!display||display.length>64)return html(peoplePage(account,'请填写姓名和 8 至 128 位初始密码。'),400);
        if(!await createAccount(db,name,'student',password,display,account.name))return html(peoplePage(account,'账号已存在。如需绑定，请使用上方的已有学生账号输入框。'),409);
      }else if(action==='group'){
        const group=data.get('student_group')?.trim();
        if(group==null||group.length>64)return send(400,'分组名称最多 64 个字符。');
        if(group&&!studentGroups(account.name).includes(group))return html(peoplePage(account,'分组已变更，请重新选择。'),409);
        if(!db.prepare('UPDATE teacher_students SET student_group=? WHERE teacher=? AND student=?').run(group||null,account.name,name).changes)return send(404,'未找到已绑定的学生。');
        return redirect(data.get('from')==='groups'?'/students#groups':'/students#roster');
      }else if(action==='bind'){
        if(!db.prepare("SELECT 1 FROM accounts WHERE name=? AND role='student'").get(name))return html(peoplePage(account,'未找到该学生账号。'),404);
        db.prepare('INSERT OR IGNORE INTO teacher_students(teacher,student,joined_at) VALUES(?,?,?)').run(account.name,name,Date.now());
      }else if(action==='remove'){
        db.prepare('DELETE FROM teacher_students WHERE teacher=? AND student=?').run(account.name,name);
      }else return send(400,'操作无效。');
      return redirect('/students');
    }
    if(post&&(path==='/api/student-name'||path==='/api/teacher-name')){
      if(account.role!==(path==='/api/student-name'?'student':'teacher'))return send(403,'账号角色不匹配。');
      const fromForm=req.headers['content-type']?.split(';')[0]==='application/x-www-form-urlencoded';
      const data=fromForm?{name:new URLSearchParams(await body(req)).get('name')}:await jsonBody(req);
      const name=typeof data?.name==='string'?data.name.trim():'';
      if(!name||name.length>64)return send(400,'请输入 1 至 64 个字符的姓名。');
      db.prepare('UPDATE accounts SET display_name=? WHERE name=?').run(name,account.name);
      if(fromForm)return redirect('/');
      return send(200,JSON.stringify({name}),'application/json');
    }
    if(post&&path==='/logout'){
      db.prepare('DELETE FROM sessions WHERE token=?').run(key);
      res.setHeader('Set-Cookie',cookie('',0));return redirect('/login');
    }
    if(post&&path==='/api/papers/import-answers'){
      if(account.role!=='teacher')return send(403,'仅教师可导入参考答案。');
      const {source,name,questions}=await jsonBody(req)??{};
      if(typeof source!=='string'||typeof name!=='string'||!Array.isArray(questions))return send(400,'请选择答案文件。');
      const count=applyKeys(questions,readAnswerFile(source,/\.json$/i.test(name)));
      if(!count)return send(422,'未识别到参考答案，请填写模板后再导入。');
      return send(200,JSON.stringify({keys:questions.map(q=>q.referenceAnswer??null),count}),'application/json');
    }
    if(post&&['/api/papers/import-markdown','/api/papers/import-combined','/api/papers/import-html'].includes(path)){
      if(account.role!=='teacher')return send(403,'仅教师可导入试卷。');
      const input=await jsonBody(req)??{},combined=path.endsWith('import-combined');
      let result;
      if(path.endsWith('import-html')){
        const data=typeof input.source==='string'&&input.source.match(/<script type="application\/json" id="exam-paper-data">([\s\S]*?)<\/script>/);
        try{result={paper:JSON.parse(data?.[1]),aiCount:0}}catch{return send(422,'请使用本系统导出的 HTML 试卷文件。')}
        if(!validPaper(result.paper))return send(422,'HTML 中的试卷结构无效。');
      }else if(combined&&/\.json$/i.test(input.name)){
        try{result={paper:JSON.parse(input.source.replace(/^\uFEFF/,'')),aiCount:0}}catch{return send(422,'含答案试卷 JSON 格式无效。')}
        if(!validPaper(result.paper))return send(422,'题目、参考答案或分值无效，请核对 JSON 模板。');
      }else result=await importMarkdown(input);
      if(combined&&!result.paper.questions.some(q=>String(q.referenceAnswer??'').trim()))return send(422,'未识别到参考答案，请按含参考答案试卷模板填写。');
      for(const q of result.paper.questions)if(q.type===5)q.testCases=casesFor(q);
      if(!validPaper(result.paper))return send(422,'解析后的题目、分值或选项无效，请检查原文。');
      return send(200,JSON.stringify(result),'application/json');
    }
    if(post&&path==='/api/papers'){
      if(account.role!=='teacher')return send(403,'仅教师可发布。');
      const paper=await jsonBody(req);
      if(!validPaper(paper))return send(400,'题型、题目、分值或选项无效（选择题最多 26 项）。');
      const audience=url.searchParams.get('audience')??'own';
      const studentGroup=audience.startsWith('group:')?audience.slice(6):null;
      if(studentGroup!==null&&!studentGroups(account.name).includes(studentGroup))return send(400,'请选择自己已有的学生分组。');
      if(studentGroup===null&&!['own','all'].includes(audience))return send(400,'发布范围无效。');
      const result=db.prepare(`
        WITH day(base) AS (SELECT CAST(strftime('%Y%m%d','now','+8 hours') AS INTEGER)*1000),
        next(id) AS (SELECT COALESCE((SELECT MAX(id) FROM papers WHERE id BETWEEN base+1 AND base+999),base)+1 FROM day)
        INSERT INTO papers(id,paper,teacher,audience,student_group)
        SELECT id,?,?,?,? FROM next,day WHERE id<=base+999
      `).run(JSON.stringify(paper),account.name,studentGroup===null?audience:'own',studentGroup);
      if(!result.changes)return send(409,'今天的 999 个试卷编号已用完，请明天再发布。');
      return send(201,JSON.stringify({id:Number(result.lastInsertRowid)}),'application/json');
    }
    if(post&&path==='/api/papers/delete'){
      if(account.role!=='teacher')return send(403,'仅教师可删除试卷。');
      const {ids}=await jsonBody(req)??{};
      if(!Array.isArray(ids)||!ids.length||!ids.every(id=>Number.isSafeInteger(id)&&id>0))return send(400,'请选择要删除的试卷。');
      if(!ids.every(canOpen))return send(404,'试卷不存在。');
      submitExpired();
      db.exec('BEGIN IMMEDIATE');
      try{
        const active=db.prepare('SELECT COUNT(DISTINCT name) AS students FROM timed_attempts WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify(ids));
        if(active.students)fail(409,'所选试卷中有 '+active.students+' 名学生正在限时作答，请在交卷后再删除。');
        if(url.searchParams.get('check')!=='1')db.prepare('INSERT OR IGNORE INTO deleted_papers SELECT id FROM papers WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(200,url.searchParams.get('check')==='1'?'可以删除。':'试卷已删除。');
    }
    const editRoute=path.match(/^\/api\/papers\/(\d+)$/);
    if(post&&editRoute){
      if(account.role!=='teacher')return send(403,'仅教师可修改试卷。');
      const id=Number(editRoute[1]), data=await jsonBody(req);
      if(!Number.isSafeInteger(id)||!Number.isSafeInteger(data?.revision)||!validPaper(data?.paper))return send(400,'请检查试卷内容、分值和版本。');
      if(!canOpen(id))return send(404,'试卷不存在。');
      const result=db.prepare(`INSERT INTO paper_edits(id,revision,paper)
        SELECT id,revision+1,? FROM published_versions WHERE id=? AND revision=?
        AND revision=(SELECT MAX(revision) FROM published_versions WHERE id=?)`)
        .run(JSON.stringify(data.paper),id,data.revision,id);
      if(!result.changes)return send(409,'试卷版本已变化，请重新打开试卷后编辑。');
      return send(200,JSON.stringify({id,revision:data.revision+1}),'application/json');
    }
    if(req.method==='GET'&&path==='/api/program-test/status')return send(200,JSON.stringify(testStates.get(account.name)||null),'application/json');
    if(post&&(path==='/api/program-test'||path==='/api/review-program-test')){
      const review=path==='/api/review-program-test';
      if(account.role!==(review?'teacher':'student'))return send(403,'当前账号无法运行此测试。');
      const data=await jsonBody(req)??{};
      const {id,index,caseIndices}=data;
      if(!Number.isSafeInteger(id)||!Number.isSafeInteger(index)||index<0)return send(400,'试卷或题号无效。');
      if(!canOpen(id))return send(404,'试卷不存在。');
      let q,answer;
      if(review){
        if(typeof data.name!=='string')return send(400,'缺少学生账号。');
        const submission=getSubmission(id,data.name);
        if(!submission)return send(404,'未找到已交卷的答卷。');
        q=JSON.parse(submission.paper).questions[index];
        answer=JSON.parse(submission.answers)[index];
      }else{
        const attempt=db.prepare(`SELECT v.paper FROM attempts a JOIN published_versions v ON v.id=a.id AND v.revision=a.revision
          LEFT JOIN timed_attempts t ON t.id=a.id AND t.name=a.name
          WHERE a.id=? AND a.name=? AND (t.deadline IS NULL OR t.deadline>?) AND NOT EXISTS
          (SELECT 1 FROM submissions s WHERE s.paper=a.id AND s.name=a.name)`).get(id,account.name,Date.now());
        q=attempt&&JSON.parse(attempt.paper).questions[index];
        if(typeof data.code!=='string'||!judgeLanguages.includes(data.language))return send(400,'试跑支持 Python、JavaScript、Java 8 和 MySQL SQL。');
        answer={code:data.code,language:data.language};
      }
      const cases=q&&casesFor(q);
      if(!cases?.length)return send(409,'当前答卷无法试跑或本题未配置用例。');
      if(caseIndices!==undefined&&(!Array.isArray(caseIndices)||!caseIndices.length||
        caseIndices.length>cases.length||new Set(caseIndices).size!==caseIndices.length||
        !caseIndices.every(n=>Number.isInteger(n)&&n>=0&&n<cases.length)))return send(400,'请选择有效的测试用例。');
      const language=answer?.language??q.defaultLanguage??'Python',sql=language==='SQL';
      if(testingAccounts.has(account.name))return send(429,'你已有一个测试正在排队或运行，请等待完成。');
      if(!sql&&[...testingAccounts.values()].filter(language=>language!=='SQL').length>=3)return send(429,'正在运行其他测试，请稍后再试。');
      if(sql&&[...testingAccounts.values()].filter(language=>language==='SQL').length>=32)return send(429,'SQL 等待队列已满，请稍后再试。');
      testingAccounts.set(account.name,language);testStates.set(account.name,{state:sql?'queued':'running',position:0});
      const controller=new AbortController();const disconnected=()=>{if(!res.writableEnded)controller.abort()};res.on('close',disconnected);
      try{
        const testCases=caseIndices?caseIndices.map(n=>cases[n]):cases;
        const report=await judge({...q,testCases},answer,{signal:controller.signal,onState:state=>testStates.set(account.name,state)});
        if(!report)return send(422,'此作答语言不支持运行测试。');
        if(review)report.details=report.details.map((row,i)=>({...row,...testCases[i]}));
        if(testCases.length<cases.length)report.score=null;
        return send(200,JSON.stringify(report),'application/json');
      }
      finally{res.off('close',disconnected);testingAccounts.delete(account.name);testStates.delete(account.name)}
    }
    if(post&&path==='/api/grades'){
      if(account.role!=='teacher')return send(403,'仅教师可评分。');
      const {id,name,version,scores}=await jsonBody(req)??{};
      if(!Number.isSafeInteger(id)||typeof name!=='string'||!Number.isSafeInteger(version)||version<0)return send(400,'评分信息无效。');
      if(!canOpen(id))return send(404,'试卷不存在。');
      const submission=getSubmission(id,name);
      if(!submission)return send(404,'未找到已交卷的答卷。');
      const questions=JSON.parse(submission.paper).questions;
      if(!Array.isArray(scores)||scores.length!==questions.length||!scores.every((v,i)=>typeof v==='number'&&(v===0||positive(v))&&v<=questions[i].score))
        return send(400,'请为每道题填写 0 至该题满分之间的分数，最多两位小数。');
      // Until the first teacher publication, all intervening versions are preliminary.
      const encoded=JSON.stringify(scores);
      let saved=db.prepare(`UPDATE grades SET auto_scores=CASE WHEN reviewed=0 THEN scores ELSE auto_scores END,
        scores=?,reviewed=1,version=version+1 WHERE paper=? AND name=?
        AND (version=? OR (reviewed=0 AND version>?)) RETURNING version`).get(encoded,id,name,version,version);
      if(!saved&&version===0){
        saved=db.prepare('INSERT OR IGNORE INTO grades(paper,name,scores,version,reviewed) VALUES(?,?,?,1,1) RETURNING version').get(id,name,encoded);
      }
      if(!saved)return send(409,'评分已在其他页面更新，请刷新后重新核对。');
      flushArchives();
      return send(200,JSON.stringify({version:saved.version}),'application/json');
    }
    if(post&&path==='/api/offline-expiry'){
      if(account.role!=='student')return send(403,'请使用学生账号。');
      const data=await jsonBody(req,answerLimit+65536);
      if(!Number.isSafeInteger(data?.id)||data.account!==account.name||!canOpen(data.id))return send(403,'账号或试卷不匹配。');
      submitExpired();
      const row=db.prepare('SELECT a.revision,p.paper,e.changes FROM expired_offline_answers e JOIN attempts a ON a.id=e.id AND a.name=e.name JOIN paper_versions p ON p.id=a.id AND p.revision=a.revision WHERE e.id=? AND e.name=?').get(data.id,account.name);
      if(!row||row.revision!==data.revision)return send(409,'该考试没有到期补同步记录。');
      const questions=JSON.parse(row.paper).questions;
      if(!validAnswers(questions,data.answers)||!Array.isArray(data.changed)||!data.changed.length||!data.changed.every(i=>Number.isInteger(i)&&i>=0&&i<data.answers.length))return send(400,'答题记录无效。');
      const changes=JSON.stringify(Object.fromEntries(data.changed.map(i=>[i,data.answers[i]])));
      if(row.changes&&row.changes!==changes)return send(409,'该场考试已有另一份离线记录。');
      db.prepare('UPDATE expired_offline_answers SET changes=? WHERE id=? AND name=?').run(changes,data.id,account.name);
      return send(200,'离线作答已同步，供教师核对。');
    }
    if(post&&(path==='/api/submissions'||path==='/api/attempt-draft')){
      if(account.role!=='student')return send(403,'请使用学生账号交卷。');
      const data=await jsonBody(req,answerLimit+65536);
      if(data?.account!==undefined&&data.account!==account.name)return send(403,'请重新登录本场考试账号。');
      if(!Number.isSafeInteger(data?.id))return send(400,'试卷编号无效。');
      if(!canOpen(data.id))return send(404,'试卷不存在。');
      const revision=data.revision??1;
      if(!Number.isSafeInteger(revision))return send(400,'试卷版本无效。');
      const row=db.prepare('SELECT paper FROM published_versions WHERE id=? AND revision=?').get(data.id,revision);
      if(!row)return send(404,'试卷不存在。');
      const paper=JSON.parse(row.paper);
      if(Object.hasOwn(data,'answerCard')){
        if(path!=='/api/submissions'||Object.hasOwn(data,'answers'))return send(400,'答题卡格式无效。');
        data.answers=readAnswerCard(paper.questions,data.answerCard);
      }
      if(!validAnswers(paper.questions,data.answers))return send(400,'答案格式无效。');
      if(db.prepare('SELECT revision FROM attempts WHERE id=? AND name=?').get(data.id,account.name)?.revision!==revision)return send(409,'请刷新页面以打开当前答卷。');
      if(paper.minutes){
        const attempt=db.prepare('SELECT deadline FROM timed_attempts WHERE id=? AND name=?').get(data.id,account.name);
        if(!attempt||attempt.deadline<=Date.now()){
          submitExpired();
          if(db.prepare('SELECT 1 FROM expired_offline_answers WHERE id=? AND name=?').get(data.id,account.name))res.setHeader('X-Exam-Late-Sync','1');
          if(db.prepare('SELECT 1 FROM submissions WHERE paper=? AND name=?').get(data.id,account.name))res.setHeader('X-Exam-Submitted','1');
          return send(409,'请刷新查看当前答卷。');
        }
      }
      if(db.prepare('SELECT 1 FROM submissions WHERE paper=? AND name=?').get(data.id,account.name)){
        res.setHeader('X-Exam-Submitted','1');
        return send(409,'该试卷已交卷。');
      }
      const timed=Boolean(paper.minutes);
      let answers=data.answers;
      if(data.changed!==undefined){
        if(!Array.isArray(data.changed)||data.changed.length>answers.length||
          !data.changed.every(i=>Number.isInteger(i)&&i>=0&&i<answers.length))return send(400,'草稿题号无效。');
        const previous=db.prepare(timed?'SELECT draft FROM timed_attempts WHERE id=? AND name=?':
          'SELECT draft FROM untimed_drafts WHERE id=? AND name=?').get(data.id,account.name);
        answers=JSON.parse(previous?.draft??'[]');
        for(const i of data.changed)answers[i]=data.answers[i];
      }
      const encoded=JSON.stringify(answers);
      if(Buffer.byteLength(encoded)>answerLimit)return send(413,'整卷答案最多 16 MiB，请缩短后再试。');
      if(path==='/api/attempt-draft'){
        if(timed)db.prepare('UPDATE timed_attempts SET draft=? WHERE id=? AND name=?').run(encoded,data.id,account.name);
        else db.prepare('INSERT INTO untimed_drafts(id,name,draft) VALUES(?,?,?) ON CONFLICT(id,name) DO UPDATE SET draft=excluded.draft').run(data.id,account.name,encoded);
        return send(200,'');
      }
      db.prepare('INSERT INTO submissions VALUES(?,?,?)').run(data.id,account.name,encoded);
      db.prepare('DELETE FROM timed_attempts WHERE id=? AND name=?').run(data.id,account.name);
      db.prepare('DELETE FROM untimed_drafts WHERE id=? AND name=?').run(data.id,account.name);
      flushArchives();
      res.setHeader('X-Exam-Submitted','1');
      return send(201,'交卷成功。');
    }
    if(post&&path==='/'&&resumePaper&&account.role==='student'){
      const form=new URLSearchParams(await body(req));
      if(form.get('action')!=='start')return send(400,'开考请求无效。');
      const id=Number(resumePaper);
      db.exec('BEGIN IMMEDIATE');
      try{
        if(!canOpen(id))fail(404,'试卷不可用，请返回试卷目录。');
        const prior=db.prepare('SELECT revision FROM attempts WHERE id=? AND name=?').get(id,account.name);
        const paper=db.prepare('SELECT revision,paper FROM published_versions WHERE id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1').get(id,prior?.revision??null,prior?.revision??null);
        if(!paper)fail(404,'试卷已删除。');
        if(!prior&&paper.revision!==Number(form.get('revision'))){
          db.exec('ROLLBACK');return redirect(url.pathname+url.search);
        }
        if(!prior){
          const started=Date.now();
          db.prepare('INSERT INTO attempts(id,name,revision,started_at) VALUES(?,?,?,?)').run(id,account.name,paper.revision,started);
          const minutes=JSON.parse(paper.paper).minutes;
          if(minutes)db.prepare('INSERT INTO timed_attempts(id,name,deadline) VALUES(?,?,?)').run(id,account.name,started+minutes*60000);
        }
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error}
      return redirect(url.pathname+url.search+'#begin');
    }
    if(post || !['/','/teacher'].includes(path))return send(404,'页面不存在。');
    if(path==='/teacher'&&account.role!=='teacher')return send(403,'仅教师可访问。');
    const teacher=account.role==='teacher';
    if(path==='/'&&!url.searchParams.has('paper')){
      const byTeacher=!teacher&&url.searchParams.get('group')==='teacher';
      const groupQuery=byTeacher?'&amp;group=teacher':'';
      const search=url.searchParams.get('number')?.trim() || '';
      const attendanceFields=teacher?`
        (SELECT COUNT(*) FROM submissions WHERE paper=p.id) AS submitted_count,
        (SELECT COUNT(*) FROM accounts student WHERE ${expectedStudent}) AS expected_count,`:'';
      const query=`SELECT ${attendanceFields} p.id,original.audience,original.student_group,owner.name AS teacher,owner.display_name AS teacher_name,json_extract(p.paper,'$.title') AS title,
        json_array_length(p.paper,'$.questions') AS count,json_extract(p.paper,'$.target') AS score,s.paper IS NOT NULL AS done,g.reviewed,CASE WHEN g.reviewed=1 THEN g.scores END AS published_scores
        FROM published_versions p JOIN papers original ON original.id=p.id JOIN accounts owner ON owner.name=original.teacher
        LEFT JOIN submissions s ON s.paper=p.id AND s.name=?
        LEFT JOIN grades g ON g.paper=s.paper AND g.name=s.name
        WHERE ${accessiblePaper} AND p.revision=COALESCE((SELECT revision FROM attempts WHERE id=p.id AND name=?),
          (SELECT MAX(revision) FROM published_versions WHERE id=p.id))`;
      const scopeLabel=p=>p.student_group?'分组 · '+p.student_group:p.audience==='all'?'全部学生':'全部自己学生';
      function list(rows,empty){
        if(!rows.length)return '<p>'+empty+'</p>';
        const href=p=>'/?paper='+p.id+groupQuery+(search?'&amp;number='+encodeURIComponent(search):'');
        const studentAction=p=>'<a href="'+href(p)+'">'+(p.done?'查看试卷':'答题')+'</a>';
        const attendanceButton=(p,grid)=>`<button type="button" data-attendance="${p.id}" data-title="${esc(p.title)}" aria-haspopup="dialog" aria-controls="attendance-dialog">${grid?'已考试 / 应考试：':''}<span>${p.submitted_count} / ${p.expected_count}</span>${grid?' 人':''}</button>`;
        const cards='<ul class="paper-grid">'+rows.map(p=>`
          <li><a class="paper-card" href="${href(p)}"${teacher?'':' aria-label="'+(p.done?'查看试卷':'答题')+'：'+esc(p.title)+'，编号 '+p.id+'"'}>
            <span class="paper-number">编号 ${p.id}</span>
            <strong>${esc(p.title)}</strong>
            <span class="meta">${p.count} 题 · 满分 ${esc(p.score)} 分${teacher?' · '+esc(scopeLabel(p)):''}${p.done?'<span data-card-status="'+p.id+'">'+(p.published_scores?' · 最终成绩 '+gradeTotal(JSON.parse(p.published_scores))+' 分':' · 查看初评')+'</span>':''}</span>
          </a>${teacher?attendanceButton(p,true):''}${teacher?`<div class="paper-tools">
            <input type="checkbox" class="paper-check" value="${p.id}" aria-label="选择试卷 ${p.id}" hidden>
            <a class="paper-icon" href="/teacher?paper=${p.id}" aria-label="编辑试卷 ${p.id}" title="编辑试卷">${paperIcon('edit')}</a>
            <button class="paper-icon" data-delete="${p.id}" aria-label="删除试卷 ${p.id}" title="删除试卷">${paperIcon('delete')}</button>
          </div>`:''}</li>`).join('')+'</ul>';
        const showScore=!teacher&&rows.some(p=>p.done);
        const columns=['试卷名称','编号','题数','满分',...(showScore?['得分']:[]),teacher?'发布范围':'状态',...(teacher?['已考试 / 应考试（人）']:[]),'操作'];
        return cards+'<div class="catalog-table"><table><thead><tr>'+columns.map(label=>'<th scope="col">'+label+'</th>').join('')+'</tr></thead><tbody>'+rows.map(p=>
          '<tr><td>'+(teacher?'<a href="'+href(p)+'">'+esc(p.title)+'</a>':esc(p.title))+'</td><td>'+p.id+'</td><td>'+p.count+'</td><td>'+esc(p.score)+'</td>'+
          (showScore?'<td'+(p.done?' data-catalog-score="'+p.id+'"':'')+'>'+(p.published_scores?gradeTotal(JSON.parse(p.published_scores)):'—')+'</td>':'')+'<td>'+
          (teacher?esc(scopeLabel(p)):p.done?(p.reviewed?'查看最终成绩':'查看初评'):'待作答')+'</td>'+(teacher?'<td>'+attendanceButton(p,false)+'</td><td class="catalog-actions"></td>':'<td>'+studentAction(p)+'</td>')+'</tr>'
        ).join('')+'</tbody></table></div>';
      }
      const searchForm=`<form class="paper-search" method="get" action="/" role="search">${byTeacher?'<input type="hidden" name="group" value="teacher">':''}<label for="paper-number">试卷编号</label><input id="paper-number" name="number" value="${esc(search)}" inputmode="numeric" placeholder="输入数字编号" required><button type="submit" aria-label="查找试卷" title="查找试卷"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></button></form>`;
      let sections,scopeFilter='';

      if(search){
        const matches=/^\d+$/.test(search)&&Number.isSafeInteger(Number(search))?db.prepare(query+' AND p.id=?').all(account.name,account.name,account.name,Number(search)):[];
        const ownerHeading=!teacher&&matches.length?'<h3>'+esc(teacherLabel(matches[0].teacher,matches[0].teacher_name))+'</h3>':'';
        sections='<section><h2>查找结果</h2>'+ownerHeading+list(matches,'未找到该编号的试卷，请核对编号。')+'<a href="'+(byTeacher?'/?group=teacher':'/')+'">返回全部试卷</a></section>';
      }else{
        const papers=db.prepare(query+' ORDER BY p.id DESC').all(account.name,account.name,account.name);
        const scope=url.searchParams.get('scope')||'';
        const groupNames=[...new Set(papers.map(p=>p.student_group).filter(Boolean))].sort();
        const scopeOptions=[['','所有试卷'],['all','全部学生'],['own','全部自己学生'],['groups','按学生分组'],...groupNames.map(g=>['group:'+g,'分组 · '+g])];
        if(teacher)scopeFilter='<label>发布范围 <select class="exam-select" aria-label="筛选发布范围" onchange="location.href=&quot;/?scope=&quot;+encodeURIComponent(this.value)">'+scopeOptions.map(([key,label])=>'<option value="'+esc(key)+'"'+(scope===key?' selected':'')+'>'+esc(label)+'</option>').join('')+'</select></label>';
        const visible=teacher&&scope?papers.filter(p=>p.student_group?(scope==='groups'||scope==='group:'+p.student_group):p.audience===scope):papers;
        sections=teacher?'<section><header class="paper-heading"><h2>已发布试卷</h2>'+(visible.length?'<div><button id="batch-all" hidden>全选</button> <button id="batch-delete" hidden disabled>删除所选</button> <button id="batch-toggle" aria-pressed="false">批量处理</button></div>':'')+'</header>'+list(visible,'暂无已发布试卷。')+'</section>':
          '<section><h2>已做试卷</h2>'+list(papers.filter(p=>p.done),'还没有已交卷的试卷。')+'</section>'+
          '<section><h2>待作答试卷</h2>'+list(papers.filter(p=>!p.done),'暂无待作答试卷。')+'</section>';
        if(byTeacher){
          const groups=Map.groupBy(papers,p=>p.teacher);
          sections=Array.from(groups,([owner,rows])=>'<section><h2>'+esc(teacherLabel(owner,rows[0].teacher_name))+'</h2>'+list(rows,'')+'</section>').join('')||'<p>暂无教师发布的试卷。</p>';
        }
      }
      const groupPicker=teacher?scopeFilter:'<nav class="group-picker" aria-label="试卷分组">'+[['status','按完成状态'],['teacher','按教师']].map(([key,label])=>'<a href="/?group='+key+'"'+((key==='teacher')===byTeacher?' aria-current="page"':'')+'>'+label+'</a>').join('')+'</nav>';
      const resumeId=Number(url.searchParams.get('resume'));
      const current=teacher?null:currentStudentPaper(account.name,resumeId);
      const paperHref=current?'/?paper='+current.id+(byTeacher?'&group=teacher':'')+(search?'&number='+encodeURIComponent(search):''):'';
      const nameForm=!account.display_name?.trim()?`<form method="post" action="/api/${teacher?'teacher':'student'}-name"><div class="row"><label>${teacher?'教师':'学生'}姓名 <input name="name" autocomplete="name" maxlength="64" required></label><button>保存姓名</button></div></form>`:'';
      const newPaperButton=teacher?'<button type="button" id="new-paper" aria-label="新增组卷" title="新增组卷"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>':'';
      const draftButton='<button type="button" id="open-draft-box" aria-haspopup="dialog" aria-controls="draft-box">草稿箱</button>';
      const draftBox=teacher?`
        <dialog id="draft-box" class="exam-prompt" aria-labelledby="draft-box-title" data-catalog-layout="grid"><header class="paper-heading"><h2 id="draft-box-title">草稿箱</h2>
        <div class="draft-toolbar"><button type="button" data-batch hidden>批量处理</button>
        <button type="button" data-layout-toggle aria-label="切换为表格"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path class="table-icon" d="M3 9h18M3 15h18M10 3v18"/><path class="grid-icon" d="M12 3v18M3 12h18"/></svg></button>
        <form method="dialog"><button aria-label="关闭草稿箱" title="关闭草稿箱"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></form></div></header>
        <div class="row"><button type="button" data-all hidden>全选</button><button type="button" data-remove hidden disabled>删除所选</button></div>
        <template><div class="paper-tools"><button type="button" class="paper-icon" title="修改草稿">${paperIcon('edit')}</button><button type="button" class="paper-icon" title="删除草稿">${paperIcon('delete')}</button><input type="checkbox" class="paper-check" hidden></div></template>
        <p data-empty>暂无草稿。</p><ul class="paper-grid"></ul><div class="draft-table" hidden><table aria-label="草稿列表"><thead><tr><th>试卷名称</th><th>题数</th><th>满分</th><th>发布范围</th><th>操作</th></tr></thead><tbody></tbody></table></div></dialog>
        <dialog class="exam-prompt" id="new-paper-dialog" aria-labelledby="new-paper-question"><p id="new-paper-question"></p>
        <div data-first><button type="button" data-yes>是</button> <button type="button" data-no>否</button></div>
        <div data-second hidden><button type="button" data-discard>丢弃</button> <button type="button" data-continue>继续组题</button></div></dialog>
        <script>(${bindTeacherDrafts.toString()})(${JSON.stringify('exam:'+createHash('sha256').update('local:'+account.name).digest('hex')+':')})</script>`:'';
      const layoutPicker=`<div class="row catalog-layout">${groupPicker}${newPaperButton}<button id="catalog-layout-toggle" type="button" aria-label="切换为列表" title="切换为列表">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <g class="list-icon"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h1M4 12h1M4 18h1"/></g>
          <g class="grid-icon"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></g>
        </svg></button></div>`;
      const content=nameForm+searchForm+layoutPicker+draftBox+sections+'<script>('+bindCatalogLayout.toString()+')()</script>';
      if(teacher)return html(frame('试卷目录',content+`<dialog id="attendance-dialog" class="exam-prompt" aria-labelledby="attendance-title">
        <header class="paper-heading"><h2 id="attendance-title">考试名单</h2><button type="button" aria-label="关闭考试名单" onclick="this.closest('dialog').close()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
        <div data-roster aria-live="polite"></div></dialog>`+'<script>('+paperManagement.toString()+')()</script>',teacherDock(),'teacher-dock',draftButton+settingsMenu(account)));
      return html(frame('我的试卷',content+`<dialog id="resume-exam-dialog" class="exam-prompt" aria-labelledby="resume-exam-question">
        <p id="resume-exam-question"></p><form method="dialog"><button value="no">否</button><button value="yes" class="primary" autofocus>是</button></form>
        </dialog><script>(${bindCatalogExamPrompt.toString()})(${JSON.stringify(account.name).replace(/</g,'\\u003c')},${JSON.stringify(current??null).replace(/</g,'\\u003c')})</script>`+'<script>('+watchPublishedScores.toString()+')()</script>',studentDock('/',paperHref),'student-dock',settingsMenu(account)));
    }
    const id=Number(url.searchParams.get('paper'));
    const hasPaper=url.searchParams.has('paper');
    if(hasPaper&&(!Number.isSafeInteger(id)||!canOpen(id)))return send(404,'试卷不存在。');
    const attempt=hasPaper&&!teacher&&db.prepare('SELECT revision FROM attempts WHERE id=? AND name=?').get(id,account.name);
    const history=teacher&&path==='/'&&hasPaper&&url.searchParams.get('history')==='1';
    if(history&&!db.prepare('SELECT 1 FROM papers p JOIN teacher_students b ON b.teacher=p.teacher WHERE p.id=? AND p.teacher=? AND b.student=?').get(id,account.name,url.searchParams.get('student')))return send(404,'未找到学生答卷。');
    const historicalSubmission=history?getSubmission(id,url.searchParams.get('student'),true):null;
    if(history&&!historicalSubmission)return send(404,'未找到学生答卷。');
    const row=historicalSubmission??(hasPaper?db.prepare('SELECT revision,paper FROM published_versions WHERE id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1')
      .get(id,attempt?.revision??null,attempt?.revision??null):null);
    if(hasPaper&&!row)return send(404,'试卷不存在。');
    if(teacher&&row&&path==='/'){
      const reviewing=url.searchParams.has('student');
      const name=url.searchParams.get('student');
      const submission=historicalSubmission??(reviewing?getSubmission(id,name):null);
      if(reviewing&&!submission)return send(404,'未找到已交卷的答卷。');
      const paper=JSON.parse(submission?.paper??row.paper);
      const answers=submission?JSON.parse(submission.answers):[];
      const late=reviewing?JSON.parse(db.prepare('SELECT changes FROM expired_offline_answers WHERE id=? AND name=?').get(id,name)?.changes||'{}'):{};
      const scores=JSON.parse(submission?.scores??'[]');
      const written=new Map((reviewing?db.prepare('SELECT idx,tries,score,reason FROM written_grading WHERE paper=? AND name=?').all(id,name):[]).map(r=>[r.idx,r]));
      function writtenNote(index){
        const r=written.get(index);
        if(!r)return '';
        const label=r.score!=null?'AI 建议 '+r.score+' 分 · '+esc(r.reason):
          r.reason?esc(r.reason):r.tries>=3?'AI 判分失败，请人工评分。':'AI 判分中，可稍后刷新或直接人工评分。';
        return '<p class="meta">'+label+'</p>';
      }
      const automatic=history?(submission.reviewed?JSON.parse(submission.auto_scores??'[]'):scores):[];
      const points=(value,max,missing)=>value==null?missing:esc(value)+' / '+esc(max)+' 分';
      let sectionIndex=0;
      const sectionGroups=new Map();
      paper.questions.forEach((q,index)=>{
        const key=q.customType?'custom:'+q.customType:'type:'+q.type;
        if(!sectionGroups.has(key))sectionGroups.set(key,[]);
        sectionGroups.get(key).push({q,index});
      });
      const items=[...sectionGroups.values()].map(group=>{
        const name=group[0].q.customType||['单选题','多选题','判断题','填空题','简答题','编程题'][group[0].q.type];
        if(!group.length)return '';
        return '<section class="question-group"><h2>'+String(++sectionIndex)+'、'+esc(name)+'</h2>'+group.map(({q,index},i)=>{
        const choices=q.type===2?['正确','错误']:q.options;
        return '<article><h3>第 '+(i+1)+' 题 · '+q.score+' 分</h3><p class="prompt">'+esc(q.prompt)+'</p>'+(q.sharedStem?'<section class="shared-stem"><strong>共用题干</strong><p>'+esc(q.sharedStem).replaceAll('\n','<br>')+'</p></section>':'')+(q.tables??[]).map(table=>'<div class="question-table-scroll"><table>'+table.map((row,i)=>'<tr>'+row.map(cell=>'<'+(i?'td':'th')+'>'+esc(cell).replaceAll('\n','<br>')+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</table></div>').join('')+(q.codeBlocks??[]).map(b=>readOnlyCode(b.code,b.language)+(b.followingText?'<p class="prompt">'+esc(b.followingText)+'</p>':'')).join('')+
          (examplesInPrompt(q)?[]:(q.testCases??[])).map((c,i)=>(c.input?'<p>示例输入 '+(i+1)+'</p>'+readOnlyCode(c.input,'text'):'')+'<p>预期输出 '+(i+1)+'</p>'+readOnlyCode(c.output,'text')).join('')+
          (Array.isArray(choices)?'<ol type="A">'+choices.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ol>':'')+
          (reviewing?reviewResponses(q,answers[index],history)+(Object.hasOwn(late,index)?'<p><strong>到期后同步的离线作答</strong></p><pre>'+esc(late[index]?.parts?subquestionText(q,late[index]):q.type===5?(late[index]?.code??late[index]??''):studentAnswer(q,late[index]))+'</pre>':'')+writtenNote(index)+(!history&&q.type===5?reviewTestControls(q,index):'')+(history?'<p>自动评分 · '+points(automatic[index],q.score,'无评分记录')+'</p><p>教师评分 · '+points(submission.reviewed?scores[index]:null,q.score,'待评分')+'</p>':gradeControl(index,scores[index],q.score)):'')+'</article>';
        }).join('')+'</section>';
      }).join('');
      if(history){
        const back=backButton('/students?historyStudent='+encodeURIComponent(name),'返回历史成绩');
        return html(teacherFrame(account,esc(paper.title),'<p>第 '+submission.revision+' 版 · 满分 '+paper.target+' 分</p>'+items+previewHighlight,undefined,back));
      }
      const pendingJudge=reviewing&&db.prepare('SELECT 1 FROM programming_jobs WHERE paper=? AND name=?').get(id,name);
      const judgeNote=pendingJudge?'<p role="status">编程题正在自动判分，可稍后刷新查看，也可直接人工评分。</p>':'';
      const content=reviewing?'<p><a href="/?paper='+id+'">返回学生答卷列表</a></p><h2>'+esc(submission.display_name||name)+'的答卷</h2>'+judgeNote+'<p>第 '+submission.revision+' 版 · 满分 '+paper.target+' 分</p><form id="grading" data-paper="'+id+'" data-student="'+esc(name)+'" data-version="'+submission.version+'">'+items+'<div class="row"><output></output><button type="submit">保存评分并公布成绩</button></div></form><script>('+bindGrading.toString()+')()</script>':
        roster(id)+'<p>试卷编号 '+id+' · 总分 '+paper.target+' 分</p>'+items;
      return html(teacherFrame(account,esc(paper.title),content+previewHighlight,'/teacher?paper='+id));
    }
    let timed;
    if(!teacher&&row&&JSON.parse(row.paper).minutes){
      submitExpired();
      timed=db.prepare('SELECT deadline,draft FROM timed_attempts WHERE id=? AND name=?').get(id,account.name);
    }
    const submission=!teacher&&db.prepare('SELECT s.answers,g.scores FROM submissions s LEFT JOIN grades g ON g.paper=s.paper AND g.name=s.name AND g.reviewed=1 WHERE s.paper=? AND s.name=?').get(id,account.name);
    const listParams=new URLSearchParams({resume:String(id)});
    if(url.searchParams.get('group')==='teacher')listParams.set('group','teacher');
    const number=url.searchParams.get('number');
    if(number&&/^\d+$/.test(number))listParams.set('number',number);
    const listHref='/?'+listParams.toString();
    const editorPaper=teacher&&row?JSON.parse(row.paper):null;
    if(editorPaper)for(const q of editorPaper.questions)if(q.type===5)q.testCases=casesFor(q);
    const draft=timed||(!teacher&&!submission&&db.prepare('SELECT draft FROM untimed_drafts WHERE id=? AND name=?').get(id,account.name));
    const expiryRecord=submission&&db.prepare('SELECT changes FROM expired_offline_answers WHERE id=? AND name=?').get(id,account.name);
    const state=teacher?{teacher:true,workspacePrefix:'exam:'+createHash('sha256').update('local:'+account.name).digest('hex')+':',groups:studentGroups(account.name),...(row?{editId:id,revision:row.revision,paper:editorPaper}:{})}:{id,expiredOffline:Boolean(expiryRecord),lateAnswers:JSON.parse(expiryRecord?.changes||'{}'),account:account.name,studentName:account.display_name,revision:row.revision,listHref,...(timed?{deadline:timed.deadline,serverNow:Date.now()}:{}),...(draft?{draft:JSON.parse(draft.draft)}:{}),paper:studentPaper(JSON.parse(row.paper),!attempt,Boolean(submission)),unstarted:!attempt,...(submission?{scoreReport:studentScoreReport(id,account.name)}:{}),answers:submission?JSON.parse(submission.answers):null};
    const signedInTemplate=template.replace('<!-- people-menu -->',peopleLink(account,id)).replace(/<a class="sign-out"[\s\S]*?<\/a>/,()=>logout);
    const source=teacher?signedInTemplate.replace('<div class="account-controls">',()=>template.match(/<button id="question-nav-toggle"[^>]*>[\s\S]*?<\/button>/)[0]+'<div class="account-controls">')
      .replace(/<nav class="floating-dock"[\s\S]*?<\/nav>/,()=>'<nav class="floating-dock teacher-dock" aria-label="教师导航">'+teacherDock('/teacher',true)+'</nav>'):
      signedInTemplate.replace(/<nav class="floating-dock"[\s\S]*?<\/nav>/,
        ()=>'<nav class="floating-dock student-dock" aria-label="考试导航">'+studentDock(listHref,url.pathname+url.search,true)+'</nav>');
    const worker=createExamWorker(source,{identifyAccount:()=>({id:'local:'+account.name+(teacher?(row?':edit:'+id:''):':paper:'+id+(row.revision>1?':v'+row.revision:'')),role:account.role,name:account.name,display_name:account.display_name})});
    const response=await worker.fetch(new Request(url));
    const page=(await response.text()).replace('const hosted = null;',()=> makeAnswerCard.toString()+'\nconst hosted = '+JSON.stringify(state).replace(/</g,'\\u003c')+';');
    const liveScores=submission?'<script>('+watchPublishedScores.toString()+')('+id+')</script>':'';
    const trackPaper=teacher?'':`<script>if(window===window.top)addEventListener('pageshow',()=>sessionStorage.setItem(${JSON.stringify('exam:catalog-selection:'+account.name).replace(/</g,'\\u003c')},'${id}'))</script>`;
    if(!teacher&&attempt&&!submission)res.setHeader('X-Offline-Exam',encodeURIComponent(account.name)+':'+id+':'+row.revision);
    return html(page.replace('</body>',()=>trackPaper+liveScores+'</body>'),response.status);
  }catch(e){if(!e.status)console.error(e.message);send(e.status||500,e.status?e.message:'服务器暂时无法处理请求。')}
}
function submitExpired(){
  const now=Date.now();
  if(!db.prepare('SELECT 1 FROM timed_attempts WHERE deadline<=? LIMIT 1').get(now))return;
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT OR IGNORE INTO submissions SELECT id,name,draft FROM timed_attempts WHERE deadline<=?').run(now);
    db.prepare('DELETE FROM timed_attempts WHERE deadline<=?').run(now);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
}
function flushArchives(){
  try{writePendingArchives(db)}catch(error){console.error('答卷归档待重试：',error.message)}
}
function maintain(){
  try{submitExpired()}catch(error){console.error('到期交卷待重试',error.message)}
  flushArchives();
  gradePrograms().catch(error=>console.error('编程判卷待重试',error.message));
  gradeWritten().catch(error=>console.error('AI 判卷待重试',error.message));
}
if(!process.env.EXAM_MYSQL_SOCKET)warmMySQLPool().catch(error=>console.error('MySQL 预热未完成：',error.message));
maintain();
const expiryCheck=setInterval(maintain,1000);
expiryCheck.unref();
export function listen(host){
  const server=http.createServer(handleRequest);
  return server.listen(Number(process.env.PORT||8787),host,()=>console.log('Exam listening on',server.address()));
}
listen(process.env.HOST||'127.0.0.1');
