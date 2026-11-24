import {readFileSync} from 'node:fs';

export function loadStyles(template){
  const tags=template.match(/<link rel="stylesheet" href="styles\/[a-z-]+\.css">/g);
  if(!tags?.length)throw new Error('Missing exam stylesheets');
  const assets=Object.fromEntries(tags.map(tag=>{
    const href=tag.match(/href="([^"]+)"/)[1];
    return ['/'+href,readFileSync(new URL(href,import.meta.url),'utf8')];
  }));
  const icon='<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
  assets['/favicon.svg']=readFileSync(new URL('favicon.svg',import.meta.url),'utf8');
  return {links:icon+'\n'+tags.join('\n').replaceAll('href="styles/', 'href="/styles/'),assets};
}
