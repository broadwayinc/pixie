/*
    app.js: the memoji social app.

    It is the photo gallery of the Skapi HTML template (database.html) with a memoji camera in front:
    - Every post is a record in the table "posts" with the photo (pic), a caption, tags and the animals in it.
      Posts are fetched with skapi.getRecords() and skapi.getFeed(); the URL hash picks the view.
    - A private post goes to the access group "private" and has no likes or comments.
    - A like is a record in "likes" that references the post (reference count = number of likes).
    - A comment is a record in "comments" with the index name "comment.<record_id>".
    - Following someone is skapi.subscribe() with get_feed and get_notified: their posts show in
      "Following" and, once push notifications are on, every new post of theirs notifies you.
    - Likes, comments and follows also notify the other user at once over skapi.postRealtime(),
      or with a push notification when they are not online.
    - Custom 3D models are private records in "spirit_models" with the model file attached.

    `skapi`, `userReady`, `pageUrl` and `leavingOnPurpose` come from service.js.
*/
import {
    ANIMALS, MemojiStage, renderThumbnail, loadFaceLandmarker, ensureAnimal, prewarmAnimals,
    registerCustomModel, unregisterCustomModel, customModelInfo, setCustomFit,
} from "./memoji-engine.js";

const $ = (id) => document.getElementById(id);
const section_posts = $("section_posts");
const fetchMoreButton = $("fetchMoreButton");
const postButton = $("postButton");

let me = null;

/* ================================================================== small helpers */

function toast(text, { img = null, onClick = null, ms = 3200 } = {}) {
    const t = $("toast");
    t.replaceChildren();
    if (img) {
        const i = document.createElement("img");
        i.src = img;
        i.alt = "";
        t.append(i);
    }
    t.append(text);
    t.onclick = () => {
        t.classList.remove("show");
        onClick?.();
    };
    // Only a toast that leads somewhere takes clicks; the others never cover a button.
    t.classList.toggle("actionable", !!onClick);
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

function timeAgo(ts) {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h";
    const d = Math.round(h / 24);
    if (d < 7) return d + "d";
    return new Date(ts).toLocaleDateString();
}

function timeEl(ts) {
    const t = document.createElement("time");
    t.dateTime = new Date(ts).toISOString();
    t.title = new Date(ts).toLocaleString();
    t.textContent = timeAgo(ts);
    return t;
}

function svgIcon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
}

/*
    What a post or a comment shows as its author.
    A guest (made with skapi.anonymousLogin(), user.anonymous is true) has no name and no email address.
*/
function authorLabel(user) {
    if (!user) return "Someone";
    if (user.anonymous) return "Guest";
    return user.name || user.email || "User";
}

function disableForm(form, disabled) {
    for (const field of form.querySelectorAll("input, textarea, button")) field.disabled = disabled;
}

function lockScroll(on) {
    document.body.classList.toggle("locked", on);
}

/* ================================================================== spirit animals & thumbnails */

const THUMB_VERSION = "v6";
const thumbs = {};
const thumbQueue = [];
let thumbBusy = false;

function emojiOf(id) {
    if (String(id).startsWith("custom")) return "✨";
    return ANIMALS.find((a) => a.id === id)?.emoji || "🐾";
}

function nameOf(id) {
    if (String(id).startsWith("custom:")) return customModels.find((m) => m.id === id)?.name || "My model";
    if (id === "custom") return "Custom model";
    return ANIMALS.find((a) => a.id === id)?.name || "Animal";
}

function placeholder(id) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#ffe4ee"/><text x="32" y="43" font-size="30" text-anchor="middle">${emojiOf(id)}</text></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
}

/*
    A thumbnail is the 3D head rendered once. Built-in animals are kept in localStorage,
    so they are rendered only the first time. Images show an emoji until their thumbnail is ready.
*/
function thumbUrl(id) {
    if (thumbs[id]) return thumbs[id];
    if (!String(id).startsWith("custom")) {
        try {
            const saved = localStorage.getItem(`memoji:thumb:${THUMB_VERSION}:${id}`);
            if (saved) return (thumbs[id] = saved);
        } catch (err) { /* storage blocked */ }
    }
    requestThumb(id);
    return placeholder(id);
}

function requestThumb(id) {
    if (thumbs[id] || thumbQueue.includes(id) || id === "custom") return;
    if (String(id).startsWith("custom:") && !customModelInfo(id)) return;
    thumbQueue.push(id);
    if (!thumbBusy) setTimeout(drainThumbs, 30);
}

async function drainThumbs() {
    const id = thumbQueue.shift();
    if (!id) {
        thumbBusy = false;
        return;
    }
    thumbBusy = true;
    try {
        // The head is sculpted in a worker first, so rendering the thumbnail does not block the page.
        if (!String(id).startsWith("custom")) await ensureAnimal(id);
        const url = renderThumbnail(id, 160);
        thumbs[id] = url;
        if (!String(id).startsWith("custom")) {
            try { localStorage.setItem(`memoji:thumb:${THUMB_VERSION}:${id}`, url); } catch (err) { /* full */ }
        }
        for (const img of document.querySelectorAll(`img[data-spirit="${CSS.escape(id)}"]`)) img.src = url;
    } catch (err) {
        console.error("Thumbnail failed", id, err);
    }
    setTimeout(drainThumbs, 30);
}

function avatarImg(spirit, size = "md") {
    const img = document.createElement("img");
    img.className = "avatar " + size;
    img.alt = "";
    img.dataset.spirit = spirit || "bunny";
    img.src = thumbUrl(img.dataset.spirit);
    return img;
}

let spirit = "bunny";
let profileMisc = {};

function readSpirit(user) {
    try {
        profileMisc = JSON.parse(user.misc || "{}") || {};
    } catch (err) {
        profileMisc = {};
    }
    let saved = null;
    try { saved = localStorage.getItem("memoji:spirit:" + user.user_id); } catch (err) { /* blocked */ }
    const id = profileMisc.spirit || saved || "bunny";
    // An animal that is no longer offered (or a model saved by its id) falls back to the bunny.
    return id.startsWith("custom:") || ANIMALS.some((a) => a.id === id) ? id : "bunny";
}

/*
    The spirit animal is kept in the profile's misc field (visible only to its user), so it follows the
    user to other devices. A guest cannot edit a profile, so a guest's choice stays in this browser.
*/
async function setSpirit(id, { save = true } = {}) {
    if (String(id).startsWith("custom:")) {
        try {
            await ensureCustomLoaded(id);
        } catch (err) {
            toast("Could not load that model: " + err.message);
            return;
        }
    }
    spirit = id;
    stage?.setSpirit(id);
    try { localStorage.setItem("memoji:spirit:" + me.user_id, id); } catch (err) { /* blocked */ }
    for (const img of document.querySelectorAll("img[data-me-avatar]")) {
        img.dataset.spirit = id;
        img.src = thumbUrl(id);
    }
    renderSpiritPickers();
    updateFitPanel();
    if (save && !me.anonymous && profileMisc.spirit !== id) {
        profileMisc.spirit = id;
        skapi.updateProfile({ misc: JSON.stringify(profileMisc) }).catch((err) => console.error(err));
    }
}

function spiritOption(id, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spirit-opt";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(id === spirit));
    b.setAttribute("aria-label", label);
    b.title = label;
    const img = document.createElement("img");
    img.alt = "";
    img.dataset.spirit = id;
    img.src = thumbUrl(id);
    const span = document.createElement("span");
    span.textContent = label;
    b.append(img, span);
    b.onclick = () => setSpirit(id);
    return b;
}

function renderSpiritPickers() {
    const strip = $("spiritStrip");
    const grid = $("spiritGrid");
    const opts = ANIMALS.map((a) => [a.id, a.name]).concat(customModels.map((m) => [m.id, m.name]));
    strip.replaceChildren(...opts.map(([id, name]) => spiritOption(id, name)));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "spirit-opt";
    add.innerHTML = `<span class="add"><svg><use href="#i-plus"/></svg></span><span>Your model</span>`;
    add.onclick = () => $("modelInput").click();
    strip.append(add);

    grid.replaceChildren(...opts.map(([id, name]) => {
        const opt = spiritOption(id, name);
        if (id.startsWith("custom:")) {
            const wrap = document.createElement("div");
            wrap.style.display = "grid";
            wrap.style.justifyItems = "center";
            const del = document.createElement("button");
            del.type = "button";
            del.className = "del";
            del.textContent = "remove";
            del.onclick = () => deleteCustomModel(id);
            wrap.append(opt, del);
            return wrap;
        }
        return opt;
    }));
    // Keep the chosen animal in view in the camera strip.
    strip.querySelector('[aria-checked="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
}

/* ================================================================== custom 3D models */

let customModels = []; // { id, name, record, fit }

async function loadCustomModelList() {
    try {
        const res = await skapi.getRecords(
            { table: { name: "spirit_models", access_group: "private" }, index: { name: "$user_id", value: me.user_id } },
            { limit: 50, ascending: false }
        );
        customModels = res.list.map((r) => ({ id: "custom:" + r.record_id, name: r.data?.name || "My model", record: r, fit: r.data?.fit || {} }));
    } catch (err) {
        console.error(err);
        customModels = [];
    }
}

async function ensureCustomLoaded(id) {
    if (customModelInfo(id)) return;
    const m = customModels.find((x) => x.id === id);
    if (!m) throw new Error("This model was removed.");
    const file = m.record.bin?.model?.[0];
    if (!file) throw new Error("The model file is missing.");
    const blob = await file.getFile("blob");
    await registerCustomModel(id, await blob.arrayBuffer(), { name: m.name, fit: m.fit });
    requestThumb(id);
}

async function uploadCustomModel(file) {
    const status = $("modelStatus");
    if (!file) return;
    if (!/\.(glb|gltf|vrm)$/i.test(file.name)) {
        status.textContent = "Please choose a .glb, .gltf or .vrm file.";
        return;
    }
    if (file.size > 40 * 1024 * 1024) {
        status.textContent = "That file is over 40 MB.";
        return;
    }
    const name = file.name.replace(/\.(glb|gltf|vrm)$/i, "").slice(0, 40) || "My model";
    status.textContent = "Checking the model…";
    const buffer = await file.arrayBuffer();
    let info;
    try {
        info = await registerCustomModel("custom:checking", buffer, { name });
        unregisterCustomModel("custom:checking");
    } catch (err) {
        status.textContent = "This file could not be read as a 3D model: " + err.message;
        return;
    }
    try {
        status.textContent = "Uploading… 0%";
        const fit = { scale: 1, y: 0, z: 0, ry: 0 };
        // A private record: only its uploader can read it and its file.
        const rec = await skapi.postRecord(
            { name, fit },
            {
                table: { name: "spirit_models", access_group: "private" },
                progress: (p) => {
                    if (p.status === "upload" && p.currentFile) status.textContent = `Uploading… ${Math.floor(p.progress)}%`;
                },
            },
            [{ name: "model", file }]
        );
        const id = "custom:" + rec.record_id;
        customModels.unshift({ id, name, record: rec, fit });
        await registerCustomModel(id, buffer, { name, fit });
        const what = info.humanoid ? "avatar (cut at the neck)" : "model";
        status.textContent = info.expressions
            ? `Added the ${what} "${name}" with ${info.expressions} expressions.`
            : info.morphCount
                ? `Added the ${what} "${name}" with ${info.morphCount} face shapes.`
                : `Added the ${what} "${name}". It has no face shapes, so it follows your head but not your expressions.`;
        await setSpirit(id);
    } catch (err) {
        status.textContent = "Upload failed: " + err.message;
    }
}

async function deleteCustomModel(id) {
    const m = customModels.find((x) => x.id === id);
    if (!m || !confirm(`Remove "${m.name}"?`)) return;
    try {
        await skapi.deleteRecords({ record_id: m.record.record_id });
        customModels = customModels.filter((x) => x !== m);
        unregisterCustomModel(id);
        if (spirit === id) await setSpirit("bunny");
        else renderSpiritPickers();
    } catch (err) {
        alert(err.message);
    }
}

// The fit sliders show while a custom model is the spirit animal, in the camera.
let fitSaveTimer = 0;
function updateFitPanel() {
    const panel = $("fitPanel");
    const info = spirit.startsWith("custom:") ? customModelInfo(spirit) : null;
    panel.hidden = !info;
    if (!info) return;
    $("fitScale").value = info.fit.scale;
    $("fitY").value = info.fit.y;
    $("fitZ").value = info.fit.z;
    $("fitRY").value = info.fit.ry;
}

function onFitInput() {
    const id = spirit;
    const fit = { scale: +$("fitScale").value, y: +$("fitY").value, z: +$("fitZ").value, ry: +$("fitRY").value };
    setCustomFit(id, fit);
    const m = customModels.find((x) => x.id === id);
    if (!m) return;
    m.fit = fit;
    clearTimeout(fitSaveTimer);
    fitSaveTimer = setTimeout(() => {
        skapi.postRecord({ name: m.name, fit }, { record_id: m.record.record_id }).catch((err) => console.error(err));
        delete thumbs[id];
        requestThumb(id);
    }, 800);
}

/* ================================================================== camera */

let stage = null;
let currentShot = null;
let facing = "user";

function camHint(text) {
    $("camHint").textContent = text || "";
}

async function openCamera({ photo = null } = {}) {
    $("cameraSheet").hidden = false;
    lockScroll(true);
    $("shutterButton").disabled = true;
    $("backToCameraButton").hidden = true;
    $("viewfinder").classList.remove("still");
    if (!stage) {
        stage = new MemojiStage($("viewfinder"), {
            onFaces: (n) => {
                if (stage.mode !== "live") return;
                camHint(n === 0 ? "Looking for faces…" : "");
                $("camStatus").textContent = n === 0 ? "memoji cam" : n === 1 ? "1 face" : `${n} faces`;
            },
        });
    }
    stage.setSpirit(spirit);
    stage.setAutoLight($("lightButton").getAttribute("aria-pressed") === "true");
    renderSpiritPickers();
    updateFitPanel();
    if (photo) {
        prewarmAnimals([spirit, ...ANIMALS.map((a) => a.id)].filter((id) => !String(id).startsWith("custom")));
        return usePhotoFromGallery(photo);
    }
    camHint("Starting camera…");
    try {
        const loading = loadFaceLandmarker();
        await stage.startCamera(facing);
        syncMirrorButton();
        camHint("Loading the face tracker…");
        // Every animal is sculpted in a background worker, so a new face gets its head without a pause.
        prewarmAnimals([spirit, ...ANIMALS.map((a) => a.id).filter((id) => id !== spirit)].filter((id) => !String(id).startsWith("custom")));
        await loading;
        camHint("Looking for faces…");
        $("shutterButton").disabled = false;
    } catch (err) {
        console.error(err);
        const denied = err?.name === "NotAllowedError";
        camHint(denied ? "Camera access was blocked. You can still turn a gallery photo into memoji." : err.message || "The camera could not start.");
        $("shutterButton").disabled = true;
    }
}

function closeCamera() {
    if (stage) {
        stage.stopCamera();
        stage.stopLoop();
        stage.clearTracks();
    }
    $("cameraSheet").hidden = true;
    lockScroll(false);
}


async function takePhoto() {
    if (!stage) return;
    const btn = $("shutterButton");
    btn.disabled = true;
    try {
        $("viewfinder").classList.remove("flash");
        void $("viewfinder").offsetWidth;
        $("viewfinder").classList.add("flash");
        currentShot = await stage.capture();
        openCompose(currentShot);
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
    }
}

async function usePhotoFromGallery(file) {
    if (!file || !stage) return;
    $("shutterButton").disabled = true;
    $("viewfinder").classList.add("still");
    camHint("Finding faces…");
    try {
        const n = await stage.showPhoto(file);
        camHint(n ? "" : "No faces found in this photo. You can still post it.");
        $("camStatus").textContent = n === 0 ? "No faces" : n === 1 ? "1 face" : `${n} faces`;
        $("backToCameraButton").hidden = false;
        $("shutterButton").disabled = false;
        $("shutterButton").setAttribute("aria-label", "Use this photo");
    } catch (err) {
        console.error(err);
        camHint("This photo could not be opened: " + err.message);
    }
}

function openCompose(shot) {
    const url = URL.createObjectURL(shot.blob);
    const img = $("img_preview");
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    img.src = url;
    const counts = {};
    for (const a of shot.animals) counts[a] = (counts[a] || 0) + 1;
    $("composeAnimals").textContent = shot.animals.length
        ? "In this photo: " + Object.entries(counts).map(([a, n]) => `${emojiOf(a)} ${nameOf(a)}${n > 1 ? " ×" + n : ""}`).join(", ")
        : "No memoji in this photo.";
    $("composeSheet").hidden = false;
    $("postForm").elements.description.focus({ preventScroll: true });
}

function closeCompose() {
    $("composeSheet").hidden = true;
}

/* ================================================================== posting */

/*
    Upload a post. The JPEG from the memoji camera is attached as the file "pic"
    (the third argument of skapi.postRecord()).
*/
async function postPhoto(event) {
    event.preventDefault();
    if (!currentShot) return;
    const form = event.target;
    disableForm(form, true);
    postButton.textContent = "0%";

    const isPrivate = $("input_private").checked;
    const description = form.elements.description.value.trim();
    // "tag1, tag2," becomes ["tag1", "tag2"]: an empty tag would make postRecord() refuse the whole post.
    const tags = $("input_tags").value.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
    const spiritTag = spirit.startsWith("custom:") ? "custom" : spirit;
    if (!tags.includes(spiritTag) && spiritTag !== "custom") tags.push(spiritTag);
    const animals = currentShot.animals.map((a) => (a.startsWith("custom:") ? "custom" : a));
    const file = new File([currentShot.blob], "memoji.jpg", { type: "image/jpeg" });

    const params = {
        table: {
            name: "posts",
            // A private post can only be read by its uploader. Other posts can be read by any logged in user.
            access_group: isPrivate ? "private" : "authorized",
            subscription: {
                is_subscription_record: false, // The posts stay queryable together with everyone else's posts.
                upload_to_feed: !isPrivate, // Goes to the "Following" feed of the user's followers.
                notify_subscribers: !isPrivate, // Followers who turned notifications on get a push.
            },
        },
        source: {
            prevent_multiple_referencing: true, // Each user can reference (like) a post only once.
        },
        progress: (p) => {
            if (p.status === "upload" && p.currentFile) postButton.textContent = `${Math.floor(p.progress)}%`;
        },
        tags: tags.length ? tags.slice(0, 10) : null,
    };
    if (!isPrivate) {
        params.notification = {
            title: `${authorLabel(me)} posted a new memoji ${emojiOf(spiritTag)}`,
            body: description.slice(0, 140) || "Tap to see it",
        };
    }

    try {
        const rec = await skapi.postRecord({ description, spirit: spiritTag, animals }, params, [{ name: "pic", file }]);
        // The list fetched right after the upload may not carry the file yet: show the photo we just took.
        if (rec?.record_id) localPics[rec.record_id] = URL.createObjectURL(currentShot.blob);
        form.reset();
        closeCompose();
        closeCamera();
        currentShot = null;
        toast(isPrivate ? "Saved to your private posts 🔒" : "Shared! ✨");
        const target = isPrivate ? "#myprivate" : "";
        if (location.hash.slice(1) !== target.slice(1)) location.hash = target;
        else initialFetch();
    } catch (err) {
        alert(err.message);
    } finally {
        postButton.textContent = "Share";
        disableForm(form, false);
    }
}

/* ================================================================== fetching posts (as in database.html) */

let fetchQuery = {};
let fetchGeneration = 0;
const localPics = {}; // record_id -> object URL of a photo this page just uploaded
const pendingLikes = new Set();
const pendingSubscriptions = new Set();
const likeId = {}; // record_id of my like per post
const userInfo = {}; // cached profiles
const subscription_list = {}; // cached subscription per uploader: subscription object or false

function getUserInfo(user_id) {
    if (!userInfo[user_id]) {
        userInfo[user_id] = skapi.getUsers({ searchFor: "user_id", value: user_id })
            .then((res) => res.list[0] || { name: "Unknown user" })
            .catch((err) => {
                console.error(err);
                return { name: "Unknown user" };
            });
    }
    return userInfo[user_id];
}

function getSubscriptionStatus(user_id) {
    if (!subscription_list[user_id]) {
        const request = skapi.getSubscriptions({ subscriber: me.user_id, subscription: user_id }).then((res) => res.list[0] || false);
        subscription_list[user_id] = request;
        request.catch(() => {
            if (subscription_list[user_id] === request) delete subscription_list[user_id];
        });
    }
    return subscription_list[user_id];
}

function showEmptyMessage(text) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = text;
    section_posts.replaceChildren(p);
}

function emptyTextForView() {
    const hash = location.hash.slice(1);
    if (hash === "feed") return "Nothing here yet. Follow people and their new posts show up here.";
    if (hash === "myposts" || hash === "myprivate") return "No posts yet. Tap the camera to make your first memoji!";
    return "No posts yet. Be the first: tap the camera! 📸";
}

// Returns false, and changes nothing, when a newer fetch has started meanwhile.
function showPosts(articles, fetchMore, requestGeneration) {
    if (requestGeneration !== fetchGeneration) return false;
    if (!fetchMore) section_posts.replaceChildren();
    const found = articles.filter(Boolean);
    if (found.length) {
        section_posts.querySelector(":scope > p")?.remove();
        section_posts.append(...found);
    }
    if (!section_posts.querySelector("article")) showEmptyMessage(emptyTextForView());
    return true;
}

function showFetchError(err, fetchMore, retry) {
    if (!navigator.onLine) {
        // The app itself works offline (it is cached); posts come back with the connection.
        if (!section_posts.querySelector("article")) showEmptyMessage("You're offline 📴 Posts will load as soon as you're back online.");
        else toast("You're offline. More posts will load when you're back online.");
        fetchMoreButton.disabled = false;
        fetchMoreButton.onclick = retry;
        return;
    }
    if (fetchMore && section_posts.querySelector("article")) {
        toast(`Unable to load more posts: ${err.message}`);
        fetchMoreButton.disabled = false;
        fetchMoreButton.onclick = retry;
    } else {
        showEmptyMessage(`Unable to load posts: ${err.message}`);
    }
}

function setMore(endOfList, fn) {
    fetchMoreButton.disabled = endOfList;
    fetchMoreButton.hidden = endOfList;
    fetchMoreButton.onclick = fn;
}

async function getPosts(fetchMore = true) {
    fetchMoreButton.disabled = true;
    const requestGeneration = ++fetchGeneration;
    let posts;
    try {
        posts = await skapi.getRecords(fetchQuery, { ascending: false, limit: 6, fetchMore });
    } catch (err) {
        console.error(err);
        if (requestGeneration === fetchGeneration) showFetchError(err, fetchMore, () => getPosts());
        return;
    }
    if (requestGeneration !== fetchGeneration) return;
    const articles = await Promise.all(posts.list.map((p) => createArticleContent(p)));
    if (!showPosts(articles, fetchMore, requestGeneration)) return;
    setMore(posts.endOfList, () => getPosts());
}

// The feed holds the posts of the users the user follows.
async function getFeed(fetchMore = true) {
    fetchMoreButton.disabled = true;
    const requestGeneration = ++fetchGeneration;
    let posts;
    try {
        posts = await skapi.getFeed({ access_group: "authorized" }, { ascending: false, limit: 6, fetchMore });
    } catch (err) {
        console.error(err);
        if (requestGeneration === fetchGeneration) showFetchError(err, fetchMore, () => getFeed());
        return;
    }
    if (requestGeneration !== fetchGeneration) return;
    const articles = await Promise.all(posts.list.map((p) => createArticleContent(p)));
    if (!showPosts(articles, fetchMore, requestGeneration)) return;
    setMore(posts.endOfList, () => getFeed());
}

/*
    Most commented posts: skapi.getIndexes() lists the index names under "comment." ordered by their totals.
    The record id of each post is taken from the index name.
*/
async function getMostCommentedPost(fetchMore = true) {
    fetchMoreButton.disabled = true;
    const requestGeneration = ++fetchGeneration;
    let commentIndex;
    try {
        commentIndex = await skapi.getIndexes(
            { table: "comments", index: "comment.", order: { by: "total_bool" } },
            { ascending: false, limit: 6, fetchMore }
        );
    } catch (err) {
        console.error(err);
        if (requestGeneration === fetchGeneration) showFetchError(err, fetchMore, () => getMostCommentedPost());
        return;
    }
    if (requestGeneration !== fetchGeneration) return;
    // A post that was deleted keeps its comments' index, so its getRecords() finds nothing (null).
    const posts = await Promise.all(commentIndex.list.map((i) =>
        skapi.getRecords({ record_id: i.index.slice("comment.".length) })
            .then((res) => res.list[0])
            .catch((err) => {
                console.error(err);
                return null;
            })
    ));
    const articles = await Promise.all(posts.map((p) => (p ? createArticleContent(p) : null)));
    if (!showPosts(articles, fetchMore, requestGeneration)) return;
    setMore(commentIndex.endOfList, () => getMostCommentedPost());
    if (!articles.some(Boolean) && !commentIndex.endOfList) return getMostCommentedPost(true);
}

// One post, for links from notifications (#post=<record_id>).
async function getOnePost(record_id) {
    fetchMoreButton.disabled = true;
    fetchMoreButton.hidden = true;
    const requestGeneration = ++fetchGeneration;
    try {
        const res = await skapi.getRecords({ record_id });
        const article = res.list[0] ? await createArticleContent(res.list[0]) : null;
        if (!showPosts([article], false, requestGeneration)) return;
        if (!article) showEmptyMessage("This post was removed.");
    } catch (err) {
        if (requestGeneration === fetchGeneration) showEmptyMessage(err.code === "NOT_EXISTS" ? "This post was removed." : `Unable to load the post: ${err.message}`);
    }
}

/* ================================================================== a post */

/*
    Build the <article> for a post. Text from other users is always set with textContent.
*/
async function createArticleContent(p) {
    if (!me || !p || !p.record_id) return null;
    const record_id = p.record_id;
    const uploader = await getUserInfo(p.user_id);
    const isMine = p.user_id === me.user_id;
    const isPrivate = p.table?.access_group === "private";
    const postSpirit = p.data?.spirit || "bunny";

    const article = document.createElement("article");
    article.className = "post";
    article.id = "post-" + record_id;
    article.dataset.owner = p.user_id; // who to notify on a like
    article.innerHTML = `
        <header class="post-head">
            <span class="ring"></span>
            <div class="post-who">
                <button type="button" class="uploader"></button>
                <small><span class="spirit-name"></span> · <span class="when"></span></small>
            </div>
            <button type="button" class="btn small primary subscribe" hidden disabled>Follow</button>
            <button type="button" class="icon-btn delete" hidden aria-label="Delete post"><svg><use href="#i-more"/></svg></button>
        </header>
        <div class="photo">
            <img alt="" hidden>
            <div class="heart-burst"><svg><use href="#i-heart"/></svg></div>
        </div>
        <div class="post-body">
            <div class="actions social">
                <button type="button" class="icon-btn like" aria-pressed="false" aria-label="Like" disabled><svg><use href="#i-heart"/></svg></button>
                <button type="button" class="icon-btn comment-jump" aria-label="Comment"><svg><use href="#i-comment"/></svg></button>
            </div>
            <p class="likes-line social"><span class="like-count">0</span> <span class="like-word">likes</span></p>
            <p class="caption"><strong class="cap-name"></strong><span class="description"></span></p>
            <p class="tags"></p>
            <p class="animals-line"></p>
            <section class="comments-block social">
                <h3>Comments (<span class="comment-count">0</span>)</h3>
                <ul class="comments"></ul>
                <button type="button" class="link-btn more-comments" hidden>Show more comments</button>
                <form class="inline-form">
                    <input type="text" name="comment" placeholder="Add a comment…" aria-label="Write a comment" maxlength="300" required>
                    <button type="submit">Post</button>
                </form>
            </section>
        </div>`;

    article.querySelector(".ring").append(avatarImg(postSpirit, "md"));
    const name = authorLabel(uploader);
    const upBtn = article.querySelector(".uploader");
    upBtn.textContent = name;
    upBtn.onclick = () => (location.hash = "user=" + encodeURIComponent(p.user_id));
    article.querySelector(".cap-name").textContent = name;
    article.querySelector(".spirit-name").textContent = `${emojiOf(postSpirit)} ${nameOf(postSpirit)}`;
    article.querySelector(".when").append(timeEl(p.uploaded || p.updated));

    const imageUrl = p.bin?.pic?.[0]?.url;
    const img = article.querySelector(".photo img");
    if (!imageUrl && localPics[record_id]) {
        img.src = localPics[record_id];
        img.alt = p.data?.description || "memoji photo";
        img.hidden = false;
    } else if (!imageUrl) {
        // A post fetched in the moment after its upload: read it again shortly for its file.
        setTimeout(() => {
            skapi.getRecords({ record_id }).then((res) => {
                const f = res.list[0]?.bin?.pic?.[0];
                if (!f) return;
                (isPrivate ? f.getFile("endpoint") : Promise.resolve(f.url)).then((u) => {
                    img.src = u;
                    img.alt = p.data?.description || "memoji photo";
                    img.hidden = false;
                });
            }).catch((err) => console.error(err));
        }, 1500);
    }
    if (imageUrl) {
        img.alt = p.data?.description || "memoji photo";
        img.hidden = false;
        img.loading = "lazy";
        img.decoding = "async";
        // A private post's file is read through a signed, cached endpoint.
        if (isPrivate) {
            p.bin.pic[0].getFile("endpoint").then((u) => (img.src = u)).catch(() => (img.src = imageUrl));
        } else {
            img.src = imageUrl;
        }
    }
    if (isPrivate) {
        const tag = document.createElement("span");
        tag.className = "private-tag";
        tag.append(svgIcon("lock"), "Private");
        article.querySelector(".photo").append(tag);
    }

    article.querySelector(".description").textContent = p.data?.description || "";

    const tagsP = article.querySelector(".tags");
    if (p.tags?.length) {
        for (const tag of p.tags) {
            const a = document.createElement("a");
            a.href = "#tag=" + encodeURIComponent(tag);
            a.textContent = "#" + tag;
            tagsP.append(a);
        }
    } else {
        tagsP.hidden = true;
    }

    const animals = Array.isArray(p.data?.animals) ? p.data.animals : [];
    const animalsLine = article.querySelector(".animals-line");
    if (animals.length > 1) animalsLine.textContent = "With " + animals.slice(1).map((a) => `${emojiOf(a)} ${nameOf(a)}`).join(", ");
    else animalsLine.hidden = true;

    // Delete, only on the user's own posts.
    const deleteButton = article.querySelector(".delete");
    if (isMine) {
        deleteButton.hidden = false;
        deleteButton.onclick = () => deletePost(article, record_id);
    }

    // Follow, only on other users' posts. Its text is set once the subscription status is known.
    const subscribeButton = article.querySelector(".subscribe");
    if (!isMine) {
        subscribeButton.hidden = false;
        subscribeButton.dataset.userId = p.user_id;
        subscribeButton.onclick = () => subscribe(p.user_id);
        getSubscriptionStatus(p.user_id).then((subscribed) => {
            setFollowButton(subscribeButton, subscribed);
            subscribeButton.disabled = pendingSubscriptions.has(p.user_id);
        }).catch((err) => console.error(err));
    }

    /*
        A private post has no likes or comments: a like is a public record and a comment an authorized one,
        so other users could read them, and every user can list the index names (comment.<record_id>).
    */
    if (isPrivate) {
        for (const el of article.querySelectorAll(".social")) el.hidden = true;
        return article;
    }

    article.querySelector(".like-count").textContent = p.referenced_count || 0;
    setLikeWord(article);

    // Like button: enabled once we know whether the user has liked this post already.
    const likeButton = article.querySelector(".like");
    likeButton.onclick = () => like(record_id);
    skapi.getRecords({
        table: { name: "likes", access_group: "public" },
        index: { name: "$user_id", value: me.user_id },
        reference: record_id,
    }).then((myLike) => {
        if (myLike.list.length) likeId[record_id] = myLike.list[0].record_id;
        likeButton.setAttribute("aria-pressed", String(!!likeId[record_id]));
    }).catch((err) => {
        console.error(err); // prevent_multiple_referencing still refuses a second like.
    }).finally(() => {
        likeButton.disabled = false;
    });

    // Double tap the photo to like.
    let lastTap = 0;
    const photo = article.querySelector(".photo");
    const burst = () => {
        const b = article.querySelector(".heart-burst");
        b.classList.remove("go");
        void b.offsetWidth;
        b.classList.add("go");
    };
    photo.addEventListener("dblclick", () => {
        burst();
        if (!likeId[record_id]) like(record_id);
    });
    photo.addEventListener("touchend", (e) => {
        const now = Date.now();
        if (now - lastTap < 300) {
            e.preventDefault();
            burst();
            if (!likeId[record_id]) like(record_id);
        }
        lastTap = now;
    });

    // Comments
    const form = article.querySelector("form");
    form.onsubmit = (event) => addComment(event, record_id, p.user_id);
    article.querySelector(".comment-jump").onclick = () => {
        form.scrollIntoView({ block: "center", behavior: "smooth" });
        form.elements.comment.focus({ preventScroll: true });
    };

    const moreCommentsButton = article.querySelector(".more-comments");
    const commentList = article.querySelector(".comments");
    const loadComments = (fetchMore) => getComments(record_id, fetchMore).then((c) => {
        commentList.append(...c.items);
        moreCommentsButton.hidden = c.endOfList;
    }).catch((err) => console.error(err));
    moreCommentsButton.onclick = () => loadComments(true);
    loadComments(false);

    // The number of comments is the number of records under the post's comment index.
    skapi.getIndexes({ table: "comments", index: "comment." + record_id }).then((info) => {
        if (info.list.length) article.querySelector(".comment-count").textContent = info.list[0].number_of_records || 0;
    }).catch((err) => console.error(err));

    return article;
}

function setLikeWord(article) {
    const n = Number(article.querySelector(".like-count").textContent);
    article.querySelector(".like-word").textContent = n === 1 ? "like" : "likes";
}

function setFollowButton(button, subscribed) {
    button.textContent = subscribed ? "Following" : "Follow";
    button.classList.toggle("primary", !subscribed);
    button.classList.toggle("following", !!subscribed);
    button.setAttribute("aria-pressed", String(!!subscribed));
}

async function deletePost(article, record_id) {
    if (!confirm("Delete this post?")) return;
    try {
        await skapi.deleteRecords({ record_id });
        article.remove();
        if (!section_posts.querySelector("article")) showEmptyMessage(emptyTextForView());
        toast("Post deleted");
    } catch (err) {
        alert(err.message);
    }
}

/*
    Comments are records in the table "comments" with the index name "comment.<record_id>".
    The four newest comments are fetched first; "Show more comments" continues from there.
*/
async function getComments(record_id, fetchMore = false) {
    const comments = await skapi.getRecords(
        { table: { name: "comments", access_group: "authorized" }, index: { name: "comment." + record_id, value: true } },
        { ascending: false, limit: 4, fetchMore }
    );
    const items = [];
    for (const c of comments.list) {
        const commenter = await getUserInfo(c.user_id);
        items.push(createCommentElement(commenter, c.updated, c.data?.comment, c.data?.spirit));
    }
    return { items, endOfList: comments.endOfList };
}

function createCommentElement(commenter, updated, text, commenterSpirit) {
    const li = document.createElement("li");
    li.append(avatarImg(commenterSpirit || "bunny", "xs"));
    const body = document.createElement("div");
    const p = document.createElement("p");
    const author = document.createElement("strong");
    author.textContent = authorLabel(commenter);
    if (commenter?.user_id) author.dataset.author = commenter.user_id; // renamed in place if you change your name
    p.append(author, text || "");
    body.append(p, timeEl(updated));
    li.append(body);
    return li;
}

async function addComment(event, record_id, ownerId) {
    event.preventDefault();
    const form = event.target;
    const text = form.elements.comment.value.trim();
    if (!text) return;
    disableForm(form, true);
    try {
        const spiritTag = spirit.startsWith("custom:") ? "custom" : spirit;
        const comment = await skapi.postRecord(
            { comment: text, spirit: spiritTag },
            { table: { name: "comments", access_group: "authorized" }, index: { name: "comment." + record_id, value: true } }
        );
        const article = form.closest("article");
        const counter = article.querySelector(".comment-count");
        counter.textContent = Number(counter.textContent) + 1;
        article.querySelector(".comments").prepend(createCommentElement(me, comment.updated, comment.data?.comment, spiritTag));
        form.reset();
        notifyUser(ownerId, { kind: "comment", post: record_id, text: text.slice(0, 100) }, `💬 ${authorLabel(me)} commented: ${text.slice(0, 80)}`);
    } catch (err) {
        alert(err.message);
    } finally {
        disableForm(form, false);
    }
}

/*
    A like is a record in the table "likes" that references the post.
    Because the post was uploaded with prevent_multiple_referencing, each user can like it only once.
    Unliking deletes the like record.
*/
async function like(record_id) {
    const article = document.getElementById("post-" + record_id);
    if (!article || pendingLikes.has(record_id)) return;
    const likeButton = article.querySelector(".like");
    const likeCount = article.querySelector(".like-count");
    pendingLikes.add(record_id);
    likeButton.disabled = true;
    try {
        if (likeId[record_id]) {
            await skapi.deleteRecords({ record_id: likeId[record_id] });
            delete likeId[record_id];
            likeCount.textContent = Math.max(0, Number(likeCount.textContent) - 1);
        } else {
            const record = await skapi.postRecord(null, { table: { name: "likes", access_group: "public" }, reference: record_id });
            likeId[record_id] = record.record_id;
            likeCount.textContent = Number(likeCount.textContent) + 1;
            const ownerId = article.dataset.owner;
            if (ownerId) notifyUser(ownerId, { kind: "like", post: record_id }, `❤️ ${authorLabel(me)} liked your memoji`);
        }
        likeButton.setAttribute("aria-pressed", String(!!likeId[record_id]));
        setLikeWord(article);
    } catch (err) {
        alert(err.message);
    } finally {
        likeButton.disabled = false;
        pendingLikes.delete(record_id);
    }
}

/*
    Follow with skapi.subscribe(): get_feed puts their posts in "Following",
    get_notified sends a push for each new post (once this device has notifications on).
    Unfollow with skapi.unsubscribe().
*/
function updateSubscribeButtons(user_id) {
    const buttons = document.querySelectorAll(`button.subscribe[data-user-id="${CSS.escape(user_id)}"]`);
    getSubscriptionStatus(user_id).then((subscribed) => {
        for (const button of buttons) setFollowButton(button, subscribed);
    }).catch((err) => console.error(err)).finally(() => {
        for (const button of buttons) button.disabled = pendingSubscriptions.has(user_id);
    });
}

async function subscribe(user_id) {
    if (pendingSubscriptions.has(user_id)) return;
    pendingSubscriptions.add(user_id);
    updateSubscribeButtons(user_id);
    try {
        const subscribed = await getSubscriptionStatus(user_id);
        if (subscribed) {
            await skapi.unsubscribe({ user_id });
            subscription_list[user_id] = Promise.resolve(false);
        } else {
            const sub = await skapi.subscribe({ user_id, get_feed: true, get_notified: true });
            subscription_list[user_id] = Promise.resolve(sub);
            notifyUser(user_id, { kind: "follow" }, `✨ ${authorLabel(me)} started following you`);
            toast("Following! Their new posts show up in Following.");
        }
    } catch (err) {
        alert(err.message);
    } finally {
        pendingSubscriptions.delete(user_id);
        updateSubscribeButtons(user_id);
    }
}

/* ================================================================== views */

function viewTitle(hash) {
    const headings = { "": "Recent", mostliked: "Most liked", mostcomment: "Most commented", myposts: "My posts", myprivate: "My private posts", feed: "Following" };
    if (headings[hash] !== undefined) return headings[hash];
    if (hash.startsWith("tag=")) return "#" + safeDecode(hash.slice(4));
    if (hash.startsWith("post=")) return "Post";
    if (hash.startsWith("user=")) return "Posts";
    return "Recent";
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch (err) {
        return s;
    }
}

function markCurrentTab(hash) {
    for (const a of document.querySelectorAll("[data-hash]")) {
        if (a.dataset.hash === hash) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
    }
}

/*
    The URL hash decides which posts are shown. initialFetch() runs when the page loads and whenever the hash changes.
*/
async function initialFetch() {
    if (!me) return;
    // App shortcuts and notifications open these; they are actions, not views.
    const action = location.hash.slice(1);
    if (["camera", "activity", "profile", "shared"].includes(action)) {
        history.replaceState(null, "", location.pathname + location.search);
        runAction(action);
    }
    const hash = location.hash.slice(1);
    $("postsHeading").textContent = viewTitle(hash);
    $("viewExtra").replaceChildren();
    markCurrentTab(hash);
    fetchMoreButton.hidden = false;
    showEmptyMessage("Loading posts…");
    window.scrollTo({ top: 0 });

    switch (hash) {
        case "mostliked":
            // Ordered by the reserved index $referenced_count: the number of likes.
            fetchQuery = { table: { name: "posts", access_group: "authorized" }, index: { name: "$referenced_count", value: 0, condition: ">" } };
            return getPosts(false);
        case "mostcomment":
            return getMostCommentedPost(false);
        case "myposts":
            fetchQuery = { table: { name: "posts", access_group: "authorized" }, index: { name: "$user_id", value: me.user_id } };
            return getPosts(false);
        case "myprivate":
            fetchQuery = { table: { name: "posts", access_group: "private" }, index: { name: "$user_id", value: me.user_id } };
            return getPosts(false);
        case "feed":
            return getFeed(false);
    }
    if (hash.startsWith("post=")) return getOnePost(safeDecode(hash.slice(5)));
    if (hash.startsWith("user=")) {
        const user_id = safeDecode(hash.slice(5));
        fetchQuery = { table: { name: "posts", access_group: "authorized" }, index: { name: "$user_id", value: user_id } };
        getUserInfo(user_id).then((u) => {
            if (location.hash.slice(1) !== hash) return;
            $("postsHeading").textContent = authorLabel(u);
            if (user_id !== me.user_id) {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "btn small primary subscribe";
                b.dataset.userId = user_id;
                b.onclick = () => subscribe(user_id);
                $("viewExtra").replaceChildren(b);
                updateSubscribeButtons(user_id);
            }
        });
        return getPosts(false);
    }
    // All posts, newest first. With "#tag=<tag>" only the posts with that tag.
    fetchQuery = { table: { name: "posts", access_group: "authorized" } };
    if (hash.startsWith("tag=")) fetchQuery.tag = safeDecode(hash.slice(4));
    return getPosts(false);
}

// Load the next page when the "Load more" button scrolls into view.
new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !fetchMoreButton.disabled && !fetchMoreButton.hidden && section_posts.querySelector("article")) {
        fetchMoreButton.click();
    }
}, { rootMargin: "400px" }).observe(fetchMoreButton);

/* ================================================================== notifications */

/*
    Realtime: while the app is open, likes, comments and follows arrive at once.
    skapi.postRealtime() with a notification also sends a push to a user who is not connected.
*/
let realtimeReady = null;

function connectRealtime() {
    realtimeReady = skapi.connectRealtime((rt) => {
        // Skapi also delivers a private message back to its sender: only messages from others are news.
        if (rt.type === "private" && rt.message?.app === "memoji" && rt.sender && rt.sender !== me?.user_id) {
            addActivity({ ...rt.message, from: rt.sender, at: Date.now() }, true);
        }
    }).catch((err) => {
        console.warn("Realtime is not available", err);
        realtimeReady = null;
    });
}

async function notifyUser(user_id, payload, text) {
    if (!user_id || user_id === me.user_id) return;
    try {
        if (!realtimeReady) connectRealtime();
        await realtimeReady;
        const spiritTag = spirit.startsWith("custom:") ? "custom" : spirit;
        await skapi.postRealtime(
            { app: "memoji", ...payload, from_name: authorLabel(me), from_spirit: spiritTag },
            user_id,
            { title: "memoji", body: text }
        );
    } catch (err) {
        console.warn("Could not notify", err);
    }
}

function activityKey() {
    return "memoji:activity:" + me.user_id;
}

function readActivity() {
    try {
        return JSON.parse(localStorage.getItem(activityKey()) || "[]");
    } catch (err) {
        return [];
    }
}

function writeActivity(list) {
    try { localStorage.setItem(activityKey(), JSON.stringify(list.slice(0, 100))); } catch (err) { /* full */ }
}

function activityText(a) {
    const who = a.from_name || "Someone";
    if (a.kind === "like") return `${who} liked your memoji`;
    if (a.kind === "comment") return `${who} commented: ${a.text || ""}`;
    if (a.kind === "follow") return `${who} started following you`;
    return `${who} sent you something`;
}

function addActivity(item, live) {
    if (item.from && item.from === me?.user_id) return; // never your own likes, comments or follows
    const list = readActivity();
    list.unshift({ ...item, unread: true });
    writeActivity(list);
    renderActivity();
    if (live) {
        toast(activityText(item), {
            img: thumbUrl(item.from_spirit || "bunny"),
            onClick: () => openActivityTarget(item),
        });
        if (item.post && (item.kind === "like") && location.hash === "#post=" + item.post) {
            const c = document.querySelector(`#post-${CSS.escape(item.post)} .like-count`);
            if (c) c.textContent = Number(c.textContent) + 1;
        }
    }
}

function openActivityTarget(item) {
    if (item.post) location.hash = "post=" + encodeURIComponent(item.post);
    else if (item.from) location.hash = "user=" + encodeURIComponent(item.from);
}

function renderActivity() {
    const list = readActivity();
    const unread = list.filter((a) => a.unread).length;
    // The number on the installed app's icon.
    if (unread) navigator.setAppBadge?.(unread).catch(() => { });
    else navigator.clearAppBadge?.().catch(() => { });
    for (const b of document.querySelectorAll("#activityButton .badge, #topActivityButton .badge")) {
        b.hidden = !unread;
        b.textContent = unread > 9 ? "9+" : unread;
    }
    const ul = $("activityList");
    ul.replaceChildren(...list.map((a) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "activity-item" + (a.unread ? " unread" : "");
        b.append(avatarImg(a.from_spirit || "bunny", "md"));
        const div = document.createElement("div");
        const p = document.createElement("p");
        p.textContent = activityText(a);
        const s = document.createElement("small");
        s.textContent = timeAgo(a.at);
        div.append(p, s);
        b.append(div);
        b.onclick = () => {
            closePanels();
            openActivityTarget(a);
        };
        li.append(b);
        return li;
    }));
    $("activityEmpty").hidden = list.length > 0;
}

function openActivity() {
    openPanel("activityPanel");
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_BADGE" });
    renderActivity();
    // Opening the list marks everything read.
    const list = readActivity();
    if (list.some((a) => a.unread)) {
        writeActivity(list.map((a) => ({ ...a, unread: false })));
        setTimeout(renderActivity, 1500);
    }
    updatePushUi();
}

/* push notifications */

function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const out = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i);
    return out;
}

function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

async function currentPushSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
}

async function updatePushUi() {
    const btn = $("pushButton"), status = $("pushStatus");
    if (isIOS && !isStandalone()) {
        btn.hidden = true;
        status.textContent = "On iPhone and iPad, notifications work in the installed app: tap Share, then \u201cAdd to Home Screen\u201d, and open memoji from your Home Screen.";
        return;
    }
    if (!pushSupported()) {
        btn.hidden = true;
        status.textContent = window.isSecureContext
            ? "This browser does not support push notifications. You still get live notifications while memoji is open."
            : "Push notifications need the app on HTTPS. You still get live notifications while memoji is open.";
        return;
    }
    btn.hidden = false;
    const sub = await currentPushSubscription().catch(() => null);
    if (sub) {
        status.textContent = "Notifications are on for this device. 🔔";
        btn.textContent = "Turn off";
        btn.className = "btn ghost";
    } else {
        status.textContent = "Get a notification on this device when someone likes, comments or follows you, and when people you follow post.";
        btn.textContent = "Turn on notifications";
        btn.className = "btn primary";
    }
}

// Ask for permission, subscribe this device with Skapi's VAPID key and register it for the logged in user.
async function enablePush() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notifications were not allowed. You can allow them in the browser's or the phone's settings.");
    const { VAPIDPublicKey } = await skapi.vapidPublicKey();
    const registration = (await swReady) || (await navigator.serviceWorker.register("sw.js"));
    await navigator.serviceWorker.ready;
    const subscription = (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPIDPublicKey),
    })).toJSON();
    await skapi.subscribeNotification(subscription.endpoint, subscription.keys);
    try { localStorage.setItem("memoji:push-user", me.user_id); } catch (err) { /* blocked */ }
    updatePwaBanner();
}

/*
    A device's push subscription belongs to whoever is logged in on it. On every start the subscription
    is sent to Skapi again for the current user (so it survives the browser renewing it, and follows a
    different account logging in on the same device). force: subscribe again if the browser dropped it.
*/
async function syncPushSubscription(force = false) {
    if (!pushSupported() || Notification.permission !== "granted") return;
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        /*
            A device's subscription must belong to one account only. If it was registered for another account
            (someone else logged in here before, or a guest session ended without logging out), that account's
            notifications would keep arriving on this device. Drop it, so its address stops working, and make
            a fresh one for the account logged in now.
        */
        let owner = null;
        try { owner = localStorage.getItem("memoji:push-user"); } catch (err) { /* blocked */ }
        if (sub && owner !== me.user_id) {
            await sub.unsubscribe().catch(() => { });
            sub = null;
            force = true;
        }
        if (!sub && force) {
            await enablePush();
            return;
        }
        if (!sub) return;
        const json = sub.toJSON();
        await skapi.subscribeNotification(json.endpoint, json.keys);
        try { localStorage.setItem("memoji:push-user", me.user_id); } catch (err) { /* blocked */ }
    } catch (err) {
        console.warn("Could not sync the push subscription", err);
    }
}

async function togglePush() {
    const btn = $("pushButton");
    btn.disabled = true;
    try {
        const existing = await currentPushSubscription();
        if (existing) {
            const json = existing.toJSON();
            await existing.unsubscribe();
            await skapi.unsubscribeNotification(json.endpoint, json.keys);
            toast("Notifications off");
        } else {
            await enablePush();
            toast("Notifications on 🔔");
        }
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
        updatePushUi();
    }
}

/* ================================================================== installable app (PWA) */

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installPrompt = null;
let updateRequested = false;

window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the browser's install prompt for the Install buttons.
    event.preventDefault();
    installPrompt = event;
    updatePwaBanner();
    updateInstallUi();
});

window.addEventListener("appinstalled", () => {
    installPrompt = null;
    toast("memoji is installed 🎉 Find it on your home screen.");
    updatePwaBanner();
    updateInstallUi();
});

function canInstall() {
    return !isStandalone() && (!!installPrompt || isIOS);
}

async function installApp() {
    if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => null);
        installPrompt = null;
        updatePwaBanner();
        updateInstallUi();
    } else if (isIOS && !isStandalone()) {
        alert("To install memoji: tap the Share button (the square with an arrow), then \u201cAdd to Home Screen\u201d.");
    }
}

function updateInstallUi() {
    const btn = $("installButton"), status = $("installStatus");
    if (isStandalone()) {
        btn.hidden = true;
        status.textContent = "You're using the memoji app. 🎉";
    } else if (canInstall()) {
        btn.hidden = false;
        status.textContent = isIOS
            ? "Add memoji to your Home Screen: it opens full screen, and on iPhone that is what turns on notifications."
            : "Install memoji: it opens full screen like an app and keeps notifications coming.";
    } else {
        btn.hidden = true;
        status.textContent = "You can install memoji from your browser's menu (\u201cInstall app\u201d or \u201cAdd to Home Screen\u201d).";
    }
}

/*
    One gentle banner above the feed: install the app, or (once installed or where it is not needed)
    turn notifications on. "Not now" hides it for a week.
*/
function bannerDismissed(kind) {
    try {
        return Date.now() - Number(localStorage.getItem("memoji:banner:" + kind) || 0) < 7 * 864e5;
    } catch (err) {
        return false;
    }
}

function updatePwaBanner() {
    const box = $("pwaBanner");
    if (!me) return (box.hidden = true);
    let kind = null;
    if (!isStandalone() && installPrompt && !bannerDismissed("install")) kind = "install";
    else if (!isStandalone() && isIOS && !bannerDismissed("ios")) kind = "ios";
    else if (pushSupported() && Notification.permission === "default" && !bannerDismissed("notify")) kind = "notify";
    box.hidden = !kind;
    if (!kind) return;
    box.dataset.kind = kind;
    const text = {
        install: "Get the memoji app: full screen camera, and notifications for likes, comments and new followers.",
        ios: "Install memoji: tap Share, then \u201cAdd to Home Screen\u201d. On iPhone that's what turns on notifications.",
        notify: "Turn on notifications to hear about likes, comments, new followers and new posts from people you follow.",
    }[kind];
    $("pwaBannerText").textContent = text;
    $("pwaBannerGo").textContent = { install: "Install", ios: "Got it", notify: "Turn on" }[kind];
}

$("pwaBannerGo").onclick = async () => {
    const kind = $("pwaBanner").dataset.kind;
    if (kind === "install") await installApp();
    else if (kind === "ios") dismissBanner("ios");
    else if (kind === "notify") {
        try {
            await enablePush();
            toast("Notifications on 🔔");
        } catch (err) {
            alert(err.message);
        }
    }
    updatePwaBanner();
};
$("pwaBannerLater").onclick = () => dismissBanner($("pwaBanner").dataset.kind);

function dismissBanner(kind) {
    try { localStorage.setItem("memoji:banner:" + kind, String(Date.now())); } catch (err) { /* blocked */ }
    updatePwaBanner();
}

// A new version of the app is ready: offer it, never reload by itself (it could be mid-photo).
function watchForUpdates(reg) {
    if (!reg) return;
    const offer = (worker) => toast("A new version of memoji is ready. Tap to update ✨", {
        ms: 20000,
        onClick: () => {
            updateRequested = true;
            worker.postMessage({ type: "SKIP_WAITING" });
        },
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
        });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (updateRequested) location.reload();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => { });
    });
}

// Messages from the service worker: notification clicks, pushes while the app is open.
navigator.serviceWorker?.addEventListener?.("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "OPEN" && msg.open) {
        if (["camera", "activity", "profile", "shared"].includes(msg.open)) runAction(msg.open);
        else location.hash = msg.open;
    } else if (msg.type === "PUSH" && msg.data?.type === "record") {
        toast(msg.data.title || "New post from someone you follow", { onClick: () => (location.hash = "post=" + msg.data.record_id) });
    } else if (msg.type === "RESUBSCRIBE") {
        syncPushSubscription(true);
    }
});

function runAction(action) {
    if (action === "camera") openCamera();
    else if (action === "activity") openActivity();
    else if (action === "profile") openProfile();
    else if (action === "shared") openSharedPhoto();
}

// A photo shared to memoji from another app (see the share target in sw.js and the manifest).
async function openSharedPhoto() {
    try {
        const cache = await caches.open("memoji-share");
        const key = new URL("shared-photo", location.href).href;
        const res = await cache.match(key);
        if (!res) return openCamera();
        const blob = await res.blob();
        await cache.delete(key);
        await openCamera({ photo: blob });
    } catch (err) {
        console.error(err);
        openCamera();
    }
}

/* ================================================================== panels */

function openPanel(id) {
    closePanels();
    $(id).hidden = false;
    lockScroll(true);
}

function closePanels() {
    for (const p of document.querySelectorAll(".panel")) p.hidden = true;
    if ($("cameraSheet").hidden && $("composeSheet").hidden) lockScroll(false);
}

async function openProfile() {
    openPanel("profilePanel");
    updateInstallUi();
    renderSpiritPickers();
    showName();
    $("guestNote").hidden = !me.anonymous;
    try {
        const u = (await skapi.getUsers({ searchFor: "user_id", value: me.user_id })).list[0];
        $("statFollowers").textContent = u?.subscribers ?? 0;
        $("statFollowing").textContent = u?.subscribed ?? 0;
    } catch (err) {
        console.error(err);
    }
}

/* ================================================================== your name */

function showName() {
    $("profileName").textContent = authorLabel(me);
    $("nameForm").hidden = true;
    $("profileName").parentElement.hidden = false;
    $("nameHint").textContent = "";
}

function editName() {
    if (me.anonymous) {
        // Skapi does not let a temporary (guest) account edit its profile.
        $("nameHint").innerHTML = 'Guests can\'t change their name. <a href="signup.html">Sign up</a> to choose one.';
        return;
    }
    $("profileName").parentElement.hidden = true;
    $("nameForm").hidden = false;
    $("nameHint").textContent = "";
    const input = $("nameInput");
    input.value = me.name || "";
    input.focus();
    input.select();
}

/*
    skapi.updateProfile({ name }) changes the name on the account. Posts and comments look their authors up
    by user id, so they show the new name from now on; the ones already on screen are updated here too.
*/
async function saveName(event) {
    event.preventDefault();
    const name = $("nameInput").value.replace(/\s+/g, " ").trim();
    if (!name) {
        $("nameHint").textContent = "Please enter a name.";
        return;
    }
    if (name === me.name) return showName();
    const form = $("nameForm");
    disableForm(form, true);
    $("nameHint").textContent = "Saving…";
    try {
        const profile = await skapi.updateProfile({ name });
        me = profile && profile.user_id ? profile : { ...me, name };
        // The cached copy of you that posts and comments use.
        userInfo[me.user_id] = Promise.resolve({ ...(await (userInfo[me.user_id] || Promise.resolve({}))), ...me });
        const label = authorLabel(me);
        for (const article of document.querySelectorAll(`article.post[data-owner="${CSS.escape(me.user_id)}"]`)) {
            article.querySelector(".uploader").textContent = label;
            article.querySelector(".cap-name").textContent = label;
        }
        for (const el of document.querySelectorAll(`[data-author="${CSS.escape(me.user_id)}"]`)) el.textContent = label;
        if (location.hash === "#user=" + encodeURIComponent(me.user_id)) $("postsHeading").textContent = label;
        showName();
        toast("Name changed ✨");
    } catch (err) {
        $("nameHint").textContent = err.message;
    } finally {
        disableForm(form, false);
    }
}

$("editNameButton").onclick = editName;
$("nameForm").onsubmit = saveName;
$("cancelNameButton").onclick = showName;

/* ================================================================== wiring */

$("openCameraButton").onclick = openCamera;
$("closeCameraButton").onclick = closeCamera;
$("shutterButton").onclick = takePhoto;
$("shuffleButton").onclick = () => stage?.reshuffle();
$("flipButton").onclick = async () => {
    facing = facing === "user" ? "environment" : "user";
    if (stage) stage.mirrorPref = null; // each camera starts with its own default: front mirrored, back not
    if (stage?.mode === "live") {
        try {
            await stage.startCamera(facing);
        } catch (err) {
            camHint(err.message);
        }
    }
    syncMirrorButton();
};
// Mirror: the selfie camera shows (and saves) the picture like a mirror; tap to see it as others do.
function syncMirrorButton() {
    const on = !!stage?.mirror;
    const b = $("mirrorButton");
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("on", on);
}
$("mirrorButton").onclick = () => {
    if (!stage) return;
    stage.setMirror(!stage.mirror);
    syncMirrorButton();
    toast(stage.mirror ? "Mirror on: like looking in a mirror 🪞" : "Mirror off: as others see you");
};
$("lightButton").onclick = () => {
    const b = $("lightButton");
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("on", on);
    stage?.setAutoLight(on);
    toast(on ? "Memoji follow your lighting ☀️" : "Studio lighting");
};
$("galleryInput").onchange = (e) => {
    usePhotoFromGallery(e.target.files[0]);
    e.target.value = "";
};
$("backToCameraButton").onclick = async () => {
    $("backToCameraButton").hidden = true;
    $("viewfinder").classList.remove("still");
    $("shutterButton").setAttribute("aria-label", "Take photo");
    camHint("Starting camera…");
    try {
        await stage.startCamera(facing);
        camHint("");
    } catch (err) {
        camHint(err.message);
    }
};
$("composeBackButton").onclick = closeCompose;
$("postForm").onsubmit = postPhoto;
for (const id of ["fitScale", "fitY", "fitZ", "fitRY"]) $(id).oninput = onFitInput;
$("modelInput").onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if ($("profilePanel").hidden && $("cameraSheet").hidden) openProfile();
    else if ($("profilePanel").hidden) $("modelStatus").textContent = "";
    uploadCustomModel(f).then(() => {
        if (!$("cameraSheet").hidden) toast($("modelStatus").textContent);
    });
};
$("activityButton").onclick = openActivity;
$("topActivityButton").onclick = openActivity;
$("meButton").onclick = openProfile;
$("topMeButton").onclick = openProfile;
$("pushButton").onclick = togglePush;
$("installButton").onclick = installApp;
$("logoutButton").onclick = async () => {
    leavingOnPurpose = true;
    try {
        // This device stops getting this account's notifications (the next login registers it again).
        const sub = await currentPushSubscription().catch(() => null);
        if (sub) {
            const json = sub.toJSON();
            await skapi.unsubscribeNotification(json.endpoint, json.keys).catch(() => { });
        }
        navigator.clearAppBadge?.().catch(() => { });
        await skapi.logout();
    } catch (err) {
        console.error(err);
    }
    location.href = pageUrl("login.html");
};
for (const p of document.querySelectorAll(".panel")) {
    p.addEventListener("click", (e) => {
        if (e.target === p || e.target.closest("[data-close-panel]")) closePanels();
    });
}
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("composeSheet").hidden) closeCompose();
    else if (!$("cameraSheet").hidden) closeCamera();
    else closePanels();
});
window.addEventListener("hashchange", initialFetch);
// Back online: reload the feed if it could not load.
window.addEventListener("online", () => {
    if (!section_posts.querySelector("article")) initialFetch();
    if (!realtimeReady) connectRealtime();
});

/* ================================================================== start */

(async () => {
    me = await userReady;
    if (!me) return; // service.js sends the visitor to the login page.
    spirit = readSpirit(me);
    for (const img of document.querySelectorAll("img[data-me-avatar]")) {
        img.dataset.spirit = spirit;
        img.src = thumbUrl(spirit);
    }
    initialFetch();
    renderActivity();
    connectRealtime();
    await loadCustomModelList();
    if (spirit.startsWith("custom:")) {
        if (customModels.some((m) => m.id === spirit)) setSpirit(spirit, { save: false });
        else setSpirit("bunny", { save: false });
    }
    // Render the built-in thumbnails in the background for the pickers.
    for (const a of ANIMALS) thumbUrl(a.id);
    // Installable app: banners, notifications for this account on this device, updates.
    updatePwaBanner();
    syncPushSubscription();
    swReady.then(watchForUpdates);
})();
