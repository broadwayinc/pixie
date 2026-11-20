/*
    sw.js: memoji's service worker. It makes memoji an installable app that starts fast and works
    without a connection as far as it can, and it shows push notifications.

    Caching
    - The app shell (pages, styles, scripts, icons) is cached on install. It is fetched from the network
      first, so online you always get one consistent, newest version; offline (or when the network
      takes longer than a few seconds) the cached copy is used, and offline.html for pages never seen.
    - The libraries from CDNs (three.js, MediaPipe and its face model, fonts, skapi-js) have the version
      in their address, so they are cached the first time and served from the cache afterwards.
    - Skapi itself (login, posts, likes, files) is never cached: it always goes to the network.
    A new version waits until the app says so (the "Update ready" toast), so it never reloads mid-photo.

    Notifications
    - From skapi.postRealtime() with a notification (likes, comments, follows): { title, body }.
    - From records posted with notify_subscribers (someone you follow posted):
      { title, body, type: "record" | "reference", record_id, table, user_id, reference? }.
    Clicking one focuses memoji (or opens it) at the post.

    Share target: photos shared to memoji from other apps arrive as a POST to ./share-target; the photo is
    kept in a cache and the app opens it in the memoji camera (index.html#shared).
*/
const VERSION = "memoji-v15";
const SHELL_CACHE = VERSION + "-shell";
const CDN_CACHE = "memoji-cdn-v1";
const SHARE_CACHE = "memoji-share";

const SHELL = [
    "./",
    "index.html",
    "login.html",
    "signup.html",
    "signup-success.html",
    "forgot-password.html",
    "reset-password.html",
    "offline.html",
    "app.css",
    "service.js",
    "manifest.webmanifest",
    "icon.svg",
    "js/app.js",
    "js/memoji-engine.js",
    "js/animals.js",
    "js/heads-sdf.js",
    "js/heads-worker.js",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/maskable-192.png",
    "icons/maskable-512.png",
    "icons/apple-touch-icon.png",
    "icons/favicon-48.png",
    "icons/badge-96.png",
];

// CDN files worth keeping: they are versioned, so a cached copy never goes stale.
const CDN_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com"];

const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map(scoped)))
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key.startsWith("memoji-") && key !== SHELL_CACHE && key !== CDN_CACHE && key !== SHARE_CACHE) await caches.delete(key);
        }
        if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => { });
        await self.clients.claim();
    })());
});

// The app asks the waiting version to take over (after the user tapped "Update").
self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
    if (event.data?.type === "CLEAR_BADGE") self.navigator.clearAppBadge?.().catch(() => { });
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // Photos shared from other apps.
    if (req.method === "POST" && url.href.startsWith(scoped("share-target"))) {
        event.respondWith(receiveShare(req));
        return;
    }
    if (req.method !== "GET") return;

    const sameOrigin = url.origin === self.location.origin;
    if (sameOrigin && req.mode === "navigate") {
        event.respondWith(networkFirstPage(event));
        return;
    }
    if (sameOrigin) {
        event.respondWith(networkFirst(req));
        return;
    }
    if (CDN_HOSTS.includes(url.hostname) && !url.pathname.includes("/@latest")) {
        event.respondWith(cacheFirst(req));
        return;
    }
    // Everything else (Skapi's API, post photos, ...) goes straight to the network.
});

async function networkFirstPage(event) {
    const req = event.request;
    try {
        const preload = await event.preloadResponse;
        const res = preload || (await fetch(req));
        if (res && res.ok) {
            const cache = await caches.open(SHELL_CACHE);
            const u = new URL(req.url);
            cache.put(u.origin + u.pathname, res.clone()); // one copy per page, whatever its ?pid= or #hash
        }
        return res;
    } catch (err) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(req, { ignoreSearch: true })) || (await cache.match(scoped("offline.html")));
    }
}

// The network, unless it fails or is too slow; then the cached copy.
async function networkFirst(req, timeoutMs = 4000) {
    const cache = await caches.open(SHELL_CACHE);
    const fresh = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs, null));
    try {
        const res = await Promise.race([fresh, timeout]);
        if (res) return res;
    } catch (err) {
        // offline: fall through to the cache
    }
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
        return await fresh;
    } catch (err) {
        return new Response("", { status: 504, statusText: "Offline" });
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(CDN_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    // Opaque (no-cors) answers are kept too: fonts and the model are fetched that way by some browsers.
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
}

async function receiveShare(req) {
    try {
        const form = await req.formData();
        const file = form.get("photo");
        if (file && typeof file !== "string") {
            const cache = await caches.open(SHARE_CACHE);
            await cache.put(scoped("shared-photo"), new Response(file, { headers: { "content-type": file.type || "image/jpeg" } }));
        }
    } catch (err) {
        // Nothing usable was shared; open the app anyway.
    }
    return Response.redirect(scoped("index.html#shared"), 303);
}

/* ------------------------------------------------------------------ notifications */

self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (err) {
        data = { body: event.data ? event.data.text() : "" };
    }
    const post = data.type === "reference" ? data.reference : data.type === "record" ? data.record_id : null;
    const open = post ? "post=" + post : data.open || "activity";
    event.waitUntil((async () => {
        // A dot on the app icon until the app is opened (where it shows the real count).
        await self.navigator.setAppBadge?.().catch(() => { });
        // If memoji is open and in front, it shows the news itself (a toast); tell it to refresh.
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of windows) c.postMessage({ type: "PUSH", data });
        await self.registration.showNotification(data.title || "memoji", {
            body: data.body || "Something new on memoji",
            icon: scoped("icons/icon-192.png"),
            badge: scoped("icons/badge-96.png"),
            tag: post ? "post-" + post : "memoji-activity",
            renotify: true,
            timestamp: Date.now(),
            vibrate: [60, 40, 60],
            data: { open },
            actions: [{ action: "open", title: post ? "See the post" : "Open memoji" }],
        });
    })());
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const open = event.notification.data?.open || "activity";
    const url = scoped("index.html#" + open);
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of windows) {
            if (c.url.startsWith(self.registration.scope)) {
                c.postMessage({ type: "OPEN", open });
                return c.focus();
            }
        }
        return self.clients.openWindow(url);
    })());
});

// The browser renewed the push subscription: the app sends the new one to Skapi on its next start.
self.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of windows) c.postMessage({ type: "RESUBSCRIBE" });
    })());
});
