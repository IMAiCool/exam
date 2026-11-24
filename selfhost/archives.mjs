import {mkdirSync,renameSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,basename,resolve} from 'node:path';
import {makeAnswerCard} from './answer-card.mjs';

function fileStem(student,time){
  const name=student.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/,'')||'学生';
  const stamp=time===null?'时间未记录':new Date(time+8*3600000).toISOString().slice(0,-1).replace('T','_').replaceAll(':','-');
  return (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)?'_':'')+name+'-'+stamp;
}

export function cleanupDeletedArchives(db){
  db.exec('CREATE TABLE IF NOT EXISTS archive_cleanup(paper INTEGER,filename TEXT,PRIMARY KEY(paper,filename))');
  for(const row of db.prepare('SELECT paper,filename FROM archive_cleanup').all()){
    if(!Number.isSafeInteger(row.paper)||basename(row.filename)!==row.filename)throw Error('Invalid archive cleanup path');
    const dir=resolve(process.env.EXAM_DATA||'selfhost/data','submissions',String(row.paper));
    try{
      for(const suffix of ['', '.tmp']){try{unlinkSync(join(dir,row.filename+suffix))}catch(e){if(e.code!=='ENOENT')throw e}}
      db.prepare('DELETE FROM archive_cleanup WHERE paper=? AND filename=?').run(row.paper,row.filename);
      try{rmdirSync(dir)}catch(e){if(!['ENOENT','ENOTEMPTY'].includes(e.code))throw e}
    }catch(e){console.error('归档清理待重试',row.paper,e.message)}
  }
}
export function writePendingArchives(db){
  cleanupDeletedArchives(db);
  const pending=db.prepare('SELECT paper,name FROM answer_archives WHERE pending=1').all();
  for(const {paper,name} of pending){
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=db.prepare(`SELECT r.*,a.revision,v.paper AS snapshot,s.answers,g.scores FROM answer_archives r
        JOIN submissions s ON s.paper=r.paper AND s.name=r.name
        JOIN attempts a ON a.id=r.paper AND a.name=r.name
        JOIN paper_versions v ON v.id=r.paper AND v.revision=a.revision
        LEFT JOIN grades g ON g.paper=r.paper AND g.name=r.name
        WHERE r.paper=? AND r.name=? AND r.pending=1`).get(paper,name);
      if(row){
        const stem=fileStem(row.student,row.submitted_at);
        let filename=row.filename;
        if(!filename){
          filename=stem+'.json';
          let suffix=1;
          while(db.prepare('SELECT 1 FROM answer_archives WHERE paper=? AND filename=?').get(paper,filename))
            filename=stem+'-'+(++suffix)+'.json';
        }
        const dir=join(process.env.EXAM_DATA||'selfhost/data','submissions',String(paper));
        mkdirSync(dir,{recursive:true});
        const path=join(dir,filename);
        const result={paperId:paper,revision:row.revision,student:row.student,username:name,
          submittedAt:row.submitted_at===null?null:new Date(row.submitted_at).toISOString(),
          answerCard:makeAnswerCard(JSON.parse(row.snapshot).questions,JSON.parse(row.answers)),scores:JSON.parse(row.scores)};
        result.totalScore=result.scores&&!result.scores.includes(null)?result.scores.reduce((n,v)=>n+Math.round(v*100),0)/100:null;
        writeFileSync(path+'.tmp',JSON.stringify(result,null,2),'utf8');
        renameSync(path+'.tmp',path);
        db.prepare('UPDATE answer_archives SET filename=?,pending=0 WHERE paper=? AND name=?').run(filename,paper,name);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');console.error('试卷 '+paper+' 的答卷归档待重试：',error.message)}
  }
}

