import assert from 'node:assert/strict';
import {judge} from '../selfhost/judge.mjs';
import {closeMySQLPool} from '../selfhost/mysql-judge.mjs';

const cases = [{input:'3\n',output:'6'}, {input:'-4\n',output:'-8'}];
const programs = {
  Python: 'print(2 * int(input()))',
  JavaScript: 'console.log(2 * Number(readline()))',
  Java: 'import java.util.Scanner; public class Main { public static void main(String[] args) { System.out.println(2 * new Scanner(System.in).nextInt()); } }'
};
try{
for(const [language,code] of Object.entries(programs)){
  const grade=await judge({type:5,score:10,testCases:cases},{language,code});
  assert.equal(grade.score,10,language+' '+JSON.stringify(grade.details));
  assert.deepEqual(grade.details.map(row=>row.actual.trim()),['6','-8']);
  console.log(language+'：2/2，10/10 分');
}
const sql=await judge({type:5,score:10,testCases:[{input:'CREATE TABLE t (n INT); INSERT INTO t VALUES (3);',output:'6'},{input:'CREATE TABLE t (n INT); INSERT INTO t VALUES (-4);',output:'-8'}]},{language:'SQL',code:'SELECT n*2 FROM t;'});
assert.equal(sql.score,10,JSON.stringify(sql.details));
console.log('SQL/MySQL：2/2，10/10 分');
}finally{await closeMySQLPool()}
