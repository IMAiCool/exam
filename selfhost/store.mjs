import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scrypt, randomBytes, createHash } from 'node:crypto';

import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const validName = name => /^[\p{L}\p{N}_.-]{1,64}$/u.test(name);

export function openStore() {
  const dir = process.env.EXAM_DATA || 'selfhost/data';
  mkdirSync(dir, {recursive:true});
  const db = new DatabaseSync(join(dir, 'exam.sqlite'));
  db.exec(`PRAGMA busy_timeout=500;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS password_resets(name TEXT PRIMARY KEY REFERENCES accounts, digest TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, name TEXT NOT NULL REFERENCES accounts, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS papers(id INTEGER PRIMARY KEY, paper TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS submissions(paper INTEGER REFERENCES papers, name TEXT REFERENCES accounts, answers TEXT NOT NULL, PRIMARY KEY(paper,name));
    CREATE TABLE IF NOT EXISTS grades(paper INTEGER NOT NULL, name TEXT NOT NULL, scores TEXT NOT NULL,
      version INTEGER NOT NULL, PRIMARY KEY(paper,name), FOREIGN KEY(paper,name) REFERENCES submissions(paper,name));
    CREATE TABLE IF NOT EXISTS paper_edits(id INTEGER REFERENCES papers, revision INTEGER NOT NULL, paper TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE VIEW IF NOT EXISTS paper_versions AS SELECT id,1 AS revision,paper FROM papers UNION ALL SELECT id,revision,paper FROM paper_edits;
    CREATE TABLE IF NOT EXISTS deleted_papers(id INTEGER PRIMARY KEY REFERENCES papers);
    CREATE VIEW IF NOT EXISTS published_versions AS SELECT * FROM paper_versions WHERE id NOT IN (SELECT id FROM deleted_papers);
    CREATE TABLE IF NOT EXISTS timed_attempts(id INTEGER REFERENCES papers, name TEXT REFERENCES accounts, deadline INTEGER NOT NULL, draft TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(id,name));
    CREATE TABLE IF NOT EXISTS untimed_drafts(id INTEGER,name TEXT,draft TEXT NOT NULL,PRIMARY KEY(id,name), FOREIGN KEY(id,name) REFERENCES attempts(id,name));
    CREATE INDEX IF NOT EXISTS timed_deadlines ON timed_attempts(deadline);
    CREATE TABLE IF NOT EXISTS attempts(id INTEGER REFERENCES papers, name TEXT REFERENCES accounts, revision INTEGER NOT NULL, PRIMARY KEY(id,name));
    INSERT OR IGNORE INTO attempts(id,name,revision) SELECT paper,name,1 FROM submissions;`);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY);");
  if(!db.prepare("SELECT 1 FROM schema_migrations WHERE name='roles-v2'").get()){db.exec("BEGIN IMMEDIATE; UPDATE accounts SET role='teacher' WHERE role='admin'; UPDATE accounts SET role='student' WHERE role='user'; INSERT INTO schema_migrations VALUES('roles-v2'); COMMIT");}
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(attempts)').all().some(col=>col.name==='started_at')) {
      db.exec(`ALTER TABLE attempts ADD COLUMN started_at INTEGER;
        UPDATE attempts AS a SET started_at=(SELECT t.deadline-json_extract(v.paper,'$.minutes')*60000
        FROM timed_attempts t JOIN paper_versions v ON v.id=t.id AND v.revision=a.revision
        WHERE t.id=a.id AND t.name=a.name) WHERE EXISTS
        (SELECT 1 FROM timed_attempts t WHERE t.id=a.id AND t.name=a.name)`);
    }
    if (!db.prepare('PRAGMA table_info(accounts)').all().some(col=>col.name==='display_name')) {
      db.exec('ALTER TABLE accounts ADD COLUMN display_name TEXT');
    }
    if (!db.prepare('PRAGMA table_info(papers)').all().some(col=>col.name==='teacher')) {
      db.exec('ALTER TABLE papers ADD COLUMN teacher TEXT REFERENCES accounts(name)');
    }
    if (!db.prepare('PRAGMA table_info(papers)').all().some(col=>col.name==='audience')) {
      db.exec("ALTER TABLE papers ADD COLUMN audience TEXT NOT NULL DEFAULT 'own' CHECK(audience IN ('own','all'))");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS teacher_students(
      teacher TEXT NOT NULL REFERENCES accounts(name),student TEXT NOT NULL REFERENCES accounts(name),
      can_reset INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(teacher,student));
      CREATE INDEX IF NOT EXISTS student_teachers ON teacher_students(student,teacher);
      CREATE INDEX IF NOT EXISTS teacher_papers ON papers(teacher);`);
    if (!db.prepare('PRAGMA table_info(papers)').all().some(col=>col.name==='student_group')) {
      db.exec("ALTER TABLE papers ADD COLUMN student_group TEXT; ALTER TABLE teacher_students ADD COLUMN student_group TEXT; DROP VIEW IF EXISTS paper_access");
    }
    if (!db.prepare('PRAGMA table_info(papers)').all().some(col=>col.name==='group_retired')) {
      db.exec(`CREATE TABLE student_groups(teacher TEXT NOT NULL REFERENCES accounts(name),name TEXT NOT NULL,PRIMARY KEY(teacher,name));
        INSERT INTO student_groups SELECT teacher,student_group FROM teacher_students WHERE student_group IS NOT NULL
        UNION SELECT teacher,student_group FROM papers WHERE student_group IS NOT NULL;
        ALTER TABLE papers ADD COLUMN group_retired INTEGER NOT NULL DEFAULT 0;
        DROP VIEW IF EXISTS paper_access;`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_teachers(
        owner TEXT NOT NULL, group_name TEXT NOT NULL, teacher TEXT NOT NULL REFERENCES accounts(name),
        PRIMARY KEY(owner,group_name,teacher), CHECK(owner<>teacher),
        FOREIGN KEY(owner,group_name) REFERENCES student_groups(teacher,name) ON UPDATE CASCADE ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS groups_by_teacher ON group_teachers(teacher);
      CREATE VIEW IF NOT EXISTS paper_access AS
      SELECT id,teacher AS account FROM papers WHERE teacher IS NOT NULL
      UNION ALL SELECT p.id,b.student FROM papers p JOIN teacher_students b ON b.teacher=p.teacher
      WHERE p.student_group IS NULL OR (p.group_retired=0 AND p.student_group=b.student_group);`);
    if (!db.prepare('PRAGMA table_info(accounts)').all().some(col=>col.name==='course')) {
      db.exec('ALTER TABLE accounts ADD COLUMN course TEXT');
    }
    const bindingColumns=db.prepare('PRAGMA table_info(teacher_students)').all();
    if (!bindingColumns.some(col=>col.name==='course_alias')) db.exec('ALTER TABLE teacher_students ADD COLUMN course_alias TEXT');
    if (!bindingColumns.some(col=>col.name==='joined_at')) db.exec('ALTER TABLE teacher_students ADD COLUMN joined_at INTEGER');
    if (!db.prepare('PRAGMA table_info(grades)').all().some(col=>col.name==='reviewed')) {
      // Existing grade records were explicitly saved by teachers.
      db.exec('ALTER TABLE grades ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 1');
    }
    if (!db.prepare('PRAGMA table_info(grades)').all().some(col=>col.name==='auto_scores')) {
      db.exec('ALTER TABLE grades ADD COLUMN auto_scores TEXT');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS answer_archives(
      paper INTEGER NOT NULL, name TEXT NOT NULL, student TEXT NOT NULL, submitted_at INTEGER,
      filename TEXT COLLATE NOCASE, pending INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(paper,name), UNIQUE(paper,filename),
      FOREIGN KEY(paper,name) REFERENCES submissions(paper,name));
      CREATE INDEX IF NOT EXISTS pending_archives ON answer_archives(pending) WHERE pending=1;
      CREATE TRIGGER IF NOT EXISTS archive_submission AFTER INSERT ON submissions BEGIN
        INSERT INTO answer_archives(paper,name,student,submitted_at)
        SELECT NEW.paper,NEW.name,COALESCE(NULLIF(display_name,''),name),
          MIN(CAST(unixepoch('subsec')*1000 AS INTEGER),COALESCE(
            (SELECT deadline FROM timed_attempts WHERE id=NEW.paper AND name=NEW.name),9223372036854775807))
        FROM accounts WHERE name=NEW.name;
      END;
      INSERT OR IGNORE INTO answer_archives(paper,name,student)
        SELECT s.paper,s.name,COALESCE(NULLIF(u.display_name,''),s.name)
        FROM submissions s JOIN accounts u ON u.name=s.name;
      CREATE TRIGGER IF NOT EXISTS archive_grade_insert AFTER INSERT ON grades BEGIN
        UPDATE answer_archives SET pending=1 WHERE paper=NEW.paper AND name=NEW.name;
      END;
      CREATE TRIGGER IF NOT EXISTS archive_grade_update AFTER UPDATE ON grades BEGIN
        UPDATE answer_archives SET pending=1 WHERE paper=NEW.paper AND name=NEW.name;
      END;`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return db;
}

export async function createAccount(db, name, role, password, displayName=null, teacher=null) {
  if (!['admin','teacher','student'].includes(role) || !validName(name)) throw Error('用户名或角色无效。');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password,salt,32);
  db.exec('BEGIN IMMEDIATE');
  try{
    const created=db.prepare('INSERT INTO accounts(name,role,salt,hash,display_name) VALUES(?,?,?,?,?) ON CONFLICT(name) DO NOTHING')
      .run(name,role,salt,hash.toString('hex'),displayName).changes===1;
    if(created&&teacher)db.prepare('INSERT INTO teacher_students(teacher,student,can_reset,joined_at) VALUES(?,?,1,?)').run(teacher,name,Date.now());
    db.exec('COMMIT');
    return created;
  }catch(error){db.exec('ROLLBACK');throw error}

}

export async function addAccount(db, name, role) {
  const password = randomBytes(15).toString('base64url');
  if (!await createAccount(db,name,role,password)) throw Error('用户名已存在。');
  return password;
}

export const resetDigest = code=>createHash('sha256').update(code).digest('hex');
export function issueReset(db,name,studentsOnly=false){
  const account=db.prepare('SELECT role FROM accounts WHERE name=?').get(name);
  if(!account || (studentsOnly && account.role!=='student'))return null;
  const code=randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO password_resets(name,digest,expires) VALUES(?,?,?)').run(name,resetDigest(code),Date.now()+15*60000);
  return code;
}
