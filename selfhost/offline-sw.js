// Cache only the active student's started exam. All writes and authentication stay online.
const papers='exam-offline-paper-v1',assets='exam-offline-styles-v1';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(url.origin!==location.origin)return;
  if(request.method==='POST'&&['/login','/logout'].includes(url.pathname)){
    event.respondWith((async()=>{await caches.delete(papers);return fetch(request)})());
    return;
  }
  if(request.method!=='GET')return;
  if(url.pathname.startsWith('/styles/')){
    event.respondWith(fetch(request).catch(async()=>await (await caches.open(assets)).match(request)||Response.error()));
    return;
  }
  if(request.mode!=='navigate')return;
  event.respondWith((async()=>{
    const id=url.searchParams.get('paper');
    try{
      const response=await fetch(request);
      const cache=await caches.open(papers);
      if(response.redirected&&new URL(response.url).pathname==='/login')await caches.delete(papers);
      else{
        const owner=response.headers.get('X-Offline-Owner');
        if(owner)for(const key of await cache.keys()){
          const page=await cache.match(key);
          if(page.headers.get('X-Offline-Owner')!==owner)await cache.delete(key);
        }
        if(url.pathname==='/'&&id&&!response.headers.has('X-Offline-Exam'))await cache.delete('/?paper='+encodeURIComponent(id));
      }
      return response;
    }catch(error){
      if(url.pathname!=='/')throw error;
      const cache=await caches.open(papers);
      const key=id?'/?paper='+encodeURIComponent(id):(await cache.keys()).at(-1);
      if(key){const page=await cache.match(key);if(page)return page}
      throw error;
    }
  })());
});
