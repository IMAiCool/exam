import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../runtime/',import.meta.url));
export function bundledExecutable(setting,relative){
 const value=process.env[setting]||join(root,relative);
 if(!existsSync(value))throw Error('缺少随程序分发的运行环境：'+relative+'。请使用完整独立运行包。');
 return value;
}
const jdk=join(root,'jdk8');
if(!process.env.EXAM_JAVA8_HOME&&existsSync(join(jdk,'release')))process.env.EXAM_JAVA8_HOME=jdk;
