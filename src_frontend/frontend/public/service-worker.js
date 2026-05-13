self.addEventListener("install", event => {
    console.log("Service Worker installed.");
    self.skipWaiting(); // 即座にアクティブ化
});

self.addEventListener("activate", event => {
    console.log("Service Worker activated.");
});

self.addEventListener("fetch", event => {
    // 特別なキャッシュ処理は行わない
});