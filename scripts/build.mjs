import {loadStyles} from '../worker/styles.mjs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {existsSync} from 'node:fs';

const root = new URL('../', import.meta.url);
const file = path => new URL(path, root);
const template = await readFile(file('worker/exam.html'), 'utf8');
const worker = await readFile(file('worker/index.mjs'), 'utf8');
if (!template.includes('/* account-context */')) {
  throw new Error('The Worker template is missing its entry markers.');
}
const bundle = worker + '\nexport default createExamWorker(' + JSON.stringify(template) + ', {styles:' + JSON.stringify(loadStyles(template).assets) + '});\n';
await mkdir(file('dist/server/'), { recursive: true });
await mkdir(file('dist/.openai/'), { recursive: true });
await writeFile(file('dist/server/index.js'), bundle);
if(existsSync(file('.openai/hosting.json')))await copyFile(file('.openai/hosting.json'), file('dist/.openai/hosting.json'));
