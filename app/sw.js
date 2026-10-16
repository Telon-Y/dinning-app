// 这个 Service Worker 只为「可安装」而存在：不缓存任何东西，所有请求照常走网络。
// 之所以不写缓存，是因为这个应用本来就依赖联网读写 GitHub，离线没有意义。
// 注意：fetch 里不调用 respondWith，浏览器就按没装 SW 一样处理请求。

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  /* 不拦截，直接放行 */
});
