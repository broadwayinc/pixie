/*
    app.js: the pixie social app.

    It is the photo gallery of the Skapi HTML template (database.html), sharing 16 x 16 pixel art instead of photos:
    - Every pixie is a record in the table "pixies". The art itself is in the record's data (pixels: a 256 character
      string, see nes.js), with a caption, tags and, for a remix, the pixie it started from.
      Pixies are fetched with skapi.getRecords() and skapi.getFeed(); the URL hash picks the view.
    - A private pixie goes to the access group "private" and has no likes or comments.
    - A like is a record in "likes" that references the pixie (reference count = number of likes).
    - A comment is a record in "comments" with the index name "comment.<record_id>".
    - Following someone is skapi.subscribe() with get_feed and get_notified: their pixies show in
      "Following" and, once push notifications are on, every new pixie of theirs notifies you.
    - Likes, comments, remixes and follows also notify the other user at once over skapi.postRealtime(),
      or with a push notification when they are not online.

    `skapi`, `userReady`, `pageUrl` and `leavingOnPurpose` come from service.js.
*/
import {
    NES, BLACK, TRANSPARENT, PICKER_ROWS, colorName, encode, emptyPixels, isValid, toDataURL, toBlob, toIco,
    pictureToPixels, avatarFor,
} from "./nes.js";
import { PixelEditor } from "./editor.js";
import { PRESET_AVATARS } from "./avatars.js";

// The table of pixies. The project may hold other tables too (this app grew out of a photo app): only records
// of this table are shown.
const POSTS_TABLE = "pixies";

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

/* ================================================================== avatars */

/*
    Everyone starts with a random 8 x 8 critter made from their user id (avatarFor() in nes.js).
    Anyone can pick a pre-drawn avatar (avatars.js) or draw their own in the studio. It is a record in the
    table "avatars" (any logged in user can read it) with data { pixels }. Avatars are looked up by the
    reserved index $user_id, so only a user's own records can be their avatar.
*/
const AVATAR_TABLE = { name: "avatars", access_group: "authorized" };
const avatarCache = {}; // user_id -> Promise of { record_id, pixels } or null; .value once known

function knownAvatar(user_id, value) {
    const p = Promise.resolve(value);
    p.value = value;
    avatarCache[user_id] = p;
}

function getAvatar(user_id) {
    if (!avatarCache[user_id]) {
        const request = skapi.getRecords(
            { table: AVATAR_TABLE, index: { name: "$user_id", value: user_id } },
            { limit: 1, ascending: false }
        ).then((res) => {
            const r = res.list.find((x) => x.user_id === user_id && isValid(x.data?.pixels));
            request.value = r ? { record_id: r.record_id, pixels: r.data.pixels } : null;
            return request.value;
        }).catch((err) => {
            console.warn("Avatar not loaded", err);
            if (avatarCache[user_id] === request) delete avatarCache[user_id];
            return null;
        });
        avatarCache[user_id] = request;
    }
    return avatarCache[user_id];
}

// The avatar's picture as far as it is known now: the user's own, or their random critter.
function avatarSrc(user_id) {
    const own = avatarCache[user_id]?.value;
    return own ? toDataURL(own.pixels) : avatarFor(user_id);
}

function avatarImg(user_id, size = "md") {
    const img = document.createElement("img");
    img.className = "avatar " + size;
    img.alt = "";
    img.dataset.avatarOf = user_id;
    img.src = avatarSrc(user_id);
    getAvatar(user_id).then(() => (img.src = avatarSrc(user_id)));
    return img;
}

function refreshAvatars(user_id) {
    for (const img of document.querySelectorAll(`img[data-avatar-of="${CSS.escape(user_id)}"]`)) img.src = avatarSrc(user_id);
}

// pixels: a pixie string, or null for the random critter.
async function setMyAvatar(pixels) {
    const current = await getAvatar(me.user_id);
    if (pixels) {
        if (current?.pixels === pixels) return;
        const rec = current
            ? await skapi.postRecord({ pixels }, { record_id: current.record_id })
            : await skapi.postRecord({ pixels }, { table: AVATAR_TABLE });
        knownAvatar(me.user_id, { record_id: rec.record_id, pixels });
    } else {
        if (!current) return;
        await skapi.deleteRecords({ record_id: current.record_id });
        knownAvatar(me.user_id, null);
    }
    refreshAvatars(me.user_id);
    renderAvatarPicker();
}

function renderAvatarPicker() {
    const box = $("avatarPicker");
    const mine = avatarCache[me.user_id]?.value?.pixels || null;
    const options = [{ id: "random", name: "Random", pixels: null, src: avatarFor(me.user_id) }];
    if (mine && !PRESET_AVATARS.some((a) => a.pixels === mine)) options.push({ id: "own", name: "Yours", pixels: mine });
    options.push(...PRESET_AVATARS);
    box.replaceChildren(...options.map((o) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "avatar-opt";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(o.pixels === mine));
        b.title = o.name;
        const img = document.createElement("img");
        img.alt = "";
        img.src = o.src || toDataURL(o.pixels);
        const span = document.createElement("span");
        span.textContent = o.name;
        b.append(img, span);
        b.onclick = async () => {
            if (o.pixels === mine) return;
            for (const x of box.querySelectorAll("button")) x.disabled = true;
            try {
                await setMyAvatar(o.pixels);
                toast(o.pixels ? "Avatar saved ✨" : "Back to your random critter");
            } catch (err) {
                alert(err.message);
                renderAvatarPicker();
            }
        };
        return b;
    }));
}

/* ================================================================== the studio (pixel editor) */

/*
    The studio draws pixies, and avatars too: "Draw your own" opens it in avatar mode, with your avatar on the
    canvas. The drawing you were making stays aside, with its undo history, until you leave avatar mode.
*/
let studioMode = "post";
let stashed = null;

function openAvatarStudio() {
    setupStudio();
    if (studioMode !== "avatar") {
        stashed = { value: editor.value, undo: editor.undoStack.slice(), redo: editor.redoStack.slice(), remixOf };
        studioMode = "avatar";
    }
    remixOf = null;
    editor.load(avatarCache[me.user_id]?.value?.pixels || encode(emptyPixels()));
    closePanels();
    $("studioSheet").hidden = false;
    lockScroll(true);
    showStudioMode();
    editor.resize();
    studioChanged();
}

function leaveAvatarMode() {
    if (studioMode !== "avatar") return;
    studioMode = "post";
    editor.load(stashed.value);
    editor.undoStack = stashed.undo;
    editor.redoStack = stashed.redo;
    remixOf = stashed.remixOf;
    stashed = null;
    showStudioMode();
    studioChanged();
}

function showStudioMode() {
    const avatar = studioMode === "avatar";
    $("studioTitle").textContent = avatar ? "Avatar" : "Studio";
    $("nextButton").textContent = avatar ? "Save" : "Next";
    $("studioAvatarNote").hidden = !avatar;
    showRemixNote();
}

async function saveAvatarFromStudio() {
    if (editor.isEmpty()) return toast("Draw something first ✏️");
    const button = $("nextButton");
    button.disabled = true;
    try {
        await setMyAvatar(editor.value);
        closeStudio();
        toast("Avatar saved ✨");
    } catch (err) {
        alert(err.message);
    } finally {
        button.disabled = editor.isEmpty();
    }
}

let editor = null;
let remixOf = null; // { record_id, user_id, name } of the pixie being remixed
let draftTimer = 0;

function draftKey() {
    return "pixie:draft:" + me.user_id;
}

/*
    The editor is made the first time the studio opens. The drawing on it is saved in this browser as you go
    (the draft), so closing the studio or the app never loses it.
*/
function setupStudio() {
    if (editor) return;
    editor = new PixelEditor($("pixelCanvas"), {
        onChange: studioChanged,
        onPick: (code) => {
            setColor(code);
            setTool("pen");
        },
    });
    renderPalette();
    let color = BLACK;
    try {
        const saved = Number(localStorage.getItem("pixie:color"));
        if (localStorage.getItem("pixie:color") !== null && (NES[saved] || saved === TRANSPARENT)) color = saved;
    } catch (err) { /* storage blocked */ }
    setColor(color);
    try {
        const draft = JSON.parse(localStorage.getItem(draftKey()) || "null");
        if (draft && isValid(draft.pixels)) {
            editor.load(draft.pixels);
            remixOf = draft.remixOf || null;
        }
    } catch (err) { /* no draft */ }
    studioChanged();
}

function renderPalette() {
    const box = $("palette");
    box.replaceChildren();
    for (const row of PICKER_ROWS) {
        for (const code of row) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "swatch" + (code === TRANSPARENT ? " clear" : "");
            if (code !== TRANSPARENT) b.style.setProperty("--c", NES[code]);
            b.dataset.code = code;
            b.setAttribute("role", "radio");
            b.setAttribute("aria-checked", "false");
            b.setAttribute("aria-label", colorName(code));
            b.title = colorName(code);
            b.onclick = () => {
                setColor(code);
                if (editor.tool === "eraser" || editor.tool === "picker") setTool("pen");
            };
            box.append(b);
        }
    }
}

function setColor(code) {
    editor.color = code;
    for (const b of $("palette").querySelectorAll(".swatch[data-code]")) {
        b.setAttribute("aria-checked", String(Number(b.dataset.code) === code));
    }
    $("currentSwatch").style.background = code === TRANSPARENT ? "" : NES[code];
    $("currentSwatch").classList.toggle("clear", code === TRANSPARENT);
    $("currentName").textContent = colorName(code);
    try { localStorage.setItem("pixie:color", String(code)); } catch (err) { /* storage blocked */ }
}

function setTool(tool) {
    editor.tool = tool;
    for (const b of document.querySelectorAll(".tool[data-tool]")) b.setAttribute("aria-checked", String(b.dataset.tool === tool));
    $("pixelCanvas").dataset.tool = tool;
}

function setPressed(id, on) {
    $(id).setAttribute("aria-pressed", String(on));
}

function studioChanged() {
    if (!editor) return;
    $("undoButton").disabled = !editor.undoStack.length;
    $("redoButton").disabled = !editor.redoStack.length;
    $("nextButton").disabled = editor.isEmpty();
    const value = editor.value;
    $("tinyPreview").src = $("tinyPreview2").src = toDataURL(value);
    if (studioMode === "avatar") return; // the drawing in progress is kept aside, not the avatar
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        try {
            if (editor.isEmpty()) localStorage.removeItem(draftKey());
            else localStorage.setItem(draftKey(), JSON.stringify({ pixels: value, remixOf }));
        } catch (err) { /* storage full or blocked */ }
    }, 250);
}

function showRemixNote() {
    for (const id of ["studioRemixNote", "composeRemixNote"]) {
        const p = $(id);
        p.hidden = !remixOf || studioMode === "avatar";
        if (!remixOf) continue;
        p.replaceChildren(svgIcon("remix"), `Remix of ${remixOf.name || "someone"}'s pixie `);
        if (id === "studioRemixNote") {
            const drop = document.createElement("button");
            drop.type = "button";
            drop.className = "link-btn";
            drop.textContent = "(not a remix)";
            drop.onclick = () => {
                remixOf = null;
                showRemixNote();
                studioChanged();
            };
            p.append(drop);
        }
    }
}

/*
    Open the studio. With `pixels` (a remix, or a picture shared to pixie) the canvas starts from them;
    whatever was on the canvas before stays one undo away.
*/
function openStudio({ pixels = null, remix = null } = {}) {
    setupStudio();
    leaveAvatarMode();
    if (pixels) {
        if (!editor.isEmpty() && editor.value !== pixels) editor.load(pixels, { keepHistory: true });
        else editor.load(pixels);
        remixOf = remix;
    }
    $("studioSheet").hidden = false;
    lockScroll(true);
    showRemixNote();
    editor.resize();
    studioChanged();
}

function closeStudio() {
    leaveAvatarMode();
    $("studioSheet").hidden = true;
    if ($("composeSheet").hidden) lockScroll(false);
}

async function importPicture(file) {
    if (!file) return;
    try {
        const pixels = await pictureToPixels(file);
        if ($("studioSheet").hidden) openStudio();
        editor.setPixels(pixels);
        remixOf = null;
        showRemixNote();
        studioChanged();
        toast("Picture turned into NES pixels. Undo brings back your drawing.");
    } catch (err) {
        console.error(err);
        toast("This picture could not be opened.");
    }
}

function openCompose() {
    if (!editor || editor.isEmpty()) return toast("Draw something first ✏️");
    $("img_preview").src = toDataURL(editor.value);
    showRemixNote();
    $("composeSheet").hidden = false;
    $("postForm").elements.description.focus({ preventScroll: true });
}

function closeCompose() {
    $("composeSheet").hidden = true;
}

/* ================================================================== posting */

/*
    Share a pixie. The art goes in the record's data: a few hundred bytes, no file to upload.
*/
async function postPixie(event) {
    event.preventDefault();
    const pixels = editor?.value;
    if (!isValid(pixels)) return toast("Draw something first ✏️");
    const form = event.target;
    disableForm(form, true);
    postButton.textContent = "Sharing…";

    const isPrivate = $("input_private").checked;
    const description = form.elements.description.value.trim();
    // "tag1, tag2," becomes ["tag1", "tag2"]: an empty tag would make postRecord() refuse the whole post.
    const tags = $("input_tags").value.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
    const data = { pixels, description };
    const remix = remixOf;
    if (remix) {
        data.remix_of = { record_id: remix.record_id, user_id: remix.user_id, name: remix.name || "" };
        // The first pixie of the remix family: every remix carries it, so one query finds the whole family.
        data.remix_root = remix.root || remix.record_id;
    }

    const params = {
        table: {
            name: POSTS_TABLE,
            // A private pixie can only be read by its maker. Other pixies can be read by any logged in user.
            access_group: isPrivate ? "private" : "authorized",
            subscription: {
                is_subscription_record: false, // The pixies stay queryable together with everyone else's.
                upload_to_feed: !isPrivate, // Goes to the "Following" feed of the user's followers.
                notify_subscribers: !isPrivate, // Followers who turned notifications on get a push.
            },
        },
        source: {
            prevent_multiple_referencing: true, // Each user can reference (like) a pixie only once.
        },
        tags: tags.length ? tags.slice(0, 10) : null,
    };
    /*
        A remix points to its family with the custom index "remix_root" (value: the record id of the first pixie).
        Not with a Skapi reference: references are the likes here (prevent_multiple_referencing would refuse a
        remix from someone who liked the pixie, and every remix would count as a like).
    */
    if (remix) params.index = { name: "remix_root", value: data.remix_root };
    /*
        A public remix also references the family's remix hub (see getHub()): the hub's owner, the maker of the
        first pixie, can then remove remixes and set the order of the frames. Never the pixie itself:
        references to a pixie are its likes.
    */
    if (remix && !isPrivate) {
        const root = await getRecordOrNull(data.remix_root);
        const hub = root ? await ensureHub(root).catch((err) => (console.warn(err), null)) : null;
        if (hub) {
            params.reference = hub.record_id;
            data.remix_hub = hub.record_id;
        }
    }
    if (!isPrivate) {
        params.notification = {
            title: `${authorLabel(me)} posted a new pixie 👾`,
            body: description.slice(0, 140) || "Tap to see it",
        };
    }

    try {
        const rec = await skapi.postRecord(data, params);
        // Every public pixie can be remixed: its maker makes its hub right away.
        if (!remix && !isPrivate && rec?.record_id) {
            ensureHub({ ...rec, user_id: me.user_id, table: { name: POSTS_TABLE, access_group: "authorized" } }).catch((err) => console.warn(err));
        }
        if (remix && !isPrivate && rec?.record_id) {
            notifyUser(remix.user_id, { kind: "remix", post: rec.record_id }, `🎨 ${authorLabel(me)} remixed your pixie`);
        }
        // A fresh canvas for the next one.
        editor.load(encode(emptyPixels()));
        remixOf = null;
        try { localStorage.removeItem(draftKey()); } catch (err) { /* storage blocked */ }
        form.reset();
        closeCompose();
        closeStudio();
        toast(isPrivate ? "Saved to your private pixies 🔒" : "Shared! ✨");
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
    if (hash === "feed") return "Nothing here yet. Follow people and their new pixies show up here.";
    if (hash === "myposts" || hash === "myprivate") return "No pixies yet. Tap the brush to paint your first one!";
    return "No pixies yet. Be the first: tap the brush and paint something! 🖌️";
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
        if (!section_posts.querySelector("article")) showEmptyMessage("You're offline 📴 Pixies will load as soon as you're back online.");
        else toast("You're offline. More pixies will load when you're back online.");
        fetchMoreButton.disabled = false;
        fetchMoreButton.onclick = retry;
        return;
    }
    if (fetchMore && section_posts.querySelector("article")) {
        toast(`Unable to load more pixies: ${err.message}`);
        fetchMoreButton.disabled = false;
        fetchMoreButton.onclick = retry;
    } else {
        showEmptyMessage(`Unable to load pixies: ${err.message}`);
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
    // The feed has every record the people you follow posted to it: only pixies are shown.
    const articles = await Promise.all(posts.list.map((p) => createArticleContent(p)));
    if (!showPosts(articles, fetchMore, requestGeneration)) return;
    setMore(posts.endOfList, () => getFeed());
    if (!articles.some(Boolean) && !posts.endOfList) return getFeed(true);
}

/*
    Most commented pixies: skapi.getIndexes() lists the index names under "comment." ordered by their totals.
    The record id of each pixie is taken from the index name.
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
    // A pixie that was deleted keeps its comments' index, so its getRecords() finds nothing (null).
    // Comments on records of other tables are skipped by createArticleContent() (null too).
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

// One pixie, for links from notifications (#post=<record_id>).
async function getOnePost(record_id) {
    fetchMoreButton.disabled = true;
    fetchMoreButton.hidden = true;
    const requestGeneration = ++fetchGeneration;
    try {
        const res = await skapi.getRecords({ record_id });
        const article = res.list[0] ? await createArticleContent(res.list[0]) : null;
        if (!showPosts([article], false, requestGeneration)) return;
        if (!article) showEmptyMessage("This pixie was removed.");
    } catch (err) {
        if (requestGeneration === fetchGeneration) showEmptyMessage(err.code === "NOT_EXISTS" ? "This pixie was removed." : `Unable to load the pixie: ${err.message}`);
    }
}

/* ================================================================== a pixie */

/*
    Build the <article> for a pixie. Text from other users is always set with textContent.
    Records of other tables (the feed and the comment index can lead to them) are skipped: null.
*/
async function createArticleContent(p) {
    if (!me || !p || !p.record_id) return null;
    if (p.table?.name !== POSTS_TABLE || !isValid(p.data?.pixels)) return null;
    const record_id = p.record_id;
    const uploader = await getUserInfo(p.user_id);
    const isMine = p.user_id === me.user_id;
    const isPrivate = p.table?.access_group === "private";
    const pixels = p.data.pixels;

    const article = document.createElement("article");
    article.className = "post";
    article.id = "post-" + record_id;
    article.dataset.owner = p.user_id; // who to notify on a like
    article.innerHTML = `
        <header class="post-head">
            <span class="ring"></span>
            <div class="post-who">
                <button type="button" class="uploader"></button>
                <small><span class="when"></span><span class="remix-line" hidden> · remix of <a></a></span><span class="remix-count" hidden></span></small>
            </div>
            <button type="button" class="btn small primary subscribe" hidden disabled>Follow</button>
            <button type="button" class="icon-btn delete" hidden aria-label="Delete pixie"><svg><use href="#i-trash"/></svg></button>
        </header>
        <div class="art">
            <img alt="" width="16" height="16">
            <div class="heart-burst"><svg><use href="#i-heart"/></svg></div>
        </div>
        <div class="post-body">
            <div class="actions">
                <button type="button" class="icon-btn like social" aria-pressed="false" aria-label="Like" disabled><svg><use href="#i-heart"/></svg></button>
                <button type="button" class="icon-btn comment-jump social" aria-label="Comment"><svg><use href="#i-comment"/></svg></button>
                <span class="spacer"></span>
                <button type="button" class="btn small remix" title="Open a copy in your studio"><svg><use href="#i-remix"/></svg> Remix</button>
                <button type="button" class="icon-btn download" aria-label="Download" title="Download" aria-haspopup="menu" aria-expanded="false"><svg><use href="#i-download"/></svg></button>
            </div>
            <div class="download-menu" role="menu" hidden>
                <button type="button" role="menuitem" data-format="png512">PNG <small>512×512</small></button>
                <button type="button" role="menuitem" data-format="png16">PNG <small>16×16</small></button>
                <button type="button" role="menuitem" data-format="ico">ICO <small>16×16 icon</small></button>
            </div>
            <p class="likes-line social"><span class="like-count">0</span> <span class="like-word">likes</span></p>
            <p class="caption"><strong class="cap-name"></strong><span class="description"></span></p>
            <p class="tags"></p>
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

    article.querySelector(".ring").append(avatarImg(p.user_id, "md"));
    const name = authorLabel(uploader);
    const upBtn = article.querySelector(".uploader");
    upBtn.textContent = name;
    upBtn.onclick = () => (location.hash = "user=" + encodeURIComponent(p.user_id));
    article.querySelector(".cap-name").textContent = name;
    article.querySelector(".when").append(timeEl(p.uploaded || p.updated));

    // The art: a 16 x 16 PNG made from the record's pixels, scaled up with crisp pixels by the CSS.
    const img = article.querySelector(".art img");
    img.src = toDataURL(pixels);
    img.alt = p.data?.description ? `Pixel art: ${p.data.description}` : `Pixel art by ${name}`;
    if (isPrivate) {
        const tag = document.createElement("span");
        tag.className = "private-tag";
        tag.append(svgIcon("lock"), "Private");
        article.querySelector(".art").append(tag);
    }

    // A remix links to the pixie it started from, with its maker's current name.
    const from = p.data?.remix_of;
    if (from?.record_id) {
        const line = article.querySelector(".remix-line");
        const a = line.querySelector("a");
        a.href = "#post=" + encodeURIComponent(from.record_id);
        a.textContent = from.name || "a pixie";
        line.hidden = false;
        if (from.user_id) getUserInfo(from.user_id).then((u) => {
            if (u?.user_id) a.textContent = authorLabel(u);
        });
    }

    article.querySelector(".description").textContent = p.data?.description || "";

    // A pixie with remixes, or a remix, plays its remix family as an animation (loaded when it comes into view).
    const familyRoot = p.data?.remix_root || p.data?.remix_of?.record_id || record_id;
    if (!isPrivate) watchFamily(article, p, familyRoot);
    if (!p.data?.description) article.querySelector(".caption").classList.add("no-text");

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

    // Remix: a copy in your own studio, credited to this pixie.
    article.querySelector(".remix").onclick = () => {
        if (editor && !editor.isEmpty() && editor.value !== pixels && !confirm("Start a remix? Your current drawing stays one undo away.")) return;
        // Remixing your own pixie is how you make the next frame of an animation.
        const root = p.data?.remix_root || p.data?.remix_of?.record_id || record_id;
        openStudio({ pixels, remix: { record_id, user_id: p.user_id, name, root } });
    };
    // Download: a big PNG, a 16 x 16 PNG, or a 16 x 16 .ico icon. Transparent pixels stay transparent.
    const downloadButton = article.querySelector(".download");
    const menu = article.querySelector(".download-menu");
    downloadButton.onclick = (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        closeDownloadMenus();
        menu.hidden = !open;
        downloadButton.setAttribute("aria-expanded", String(open));
    };
    for (const item of menu.querySelectorAll("[data-format]")) {
        item.onclick = async () => {
            closeDownloadMenus();
            const format = item.dataset.format;
            const blob = format === "ico" ? toIco(pixels) : await toBlob(pixels, format === "png16" ? 1 : 32);
            const suffix = format === "ico" ? ".ico" : format === "png16" ? "-16.png" : ".png";
            saveFile(blob, `pixie-${record_id}${suffix}`);
        };
    }

    // Delete, only on the user's own pixies.
    const deleteButton = article.querySelector(".delete");
    if (isMine) {
        deleteButton.hidden = false;
        deleteButton.onclick = () => deletePost(article, record_id);
    }

    // Follow, only on other users' pixies. Its text is set once the subscription status is known.
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
        A private pixie has no likes or comments: a like is a public record and a comment an authorized one,
        so other users could read them, and every user can list the index names (comment.<record_id>).
    */
    if (isPrivate) {
        for (const el of article.querySelectorAll(".social")) el.hidden = true;
        return article;
    }

    article.querySelector(".like-count").textContent = p.referenced_count || 0;
    setLikeWord(article);

    // Like button: enabled once we know whether the user has liked this pixie already.
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

    // Double tap the art to like.
    let lastTap = 0;
    const art = article.querySelector(".art");
    const burst = () => {
        const b = article.querySelector(".heart-burst");
        b.classList.remove("go");
        void b.offsetWidth;
        b.classList.add("go");
    };
    art.addEventListener("dblclick", () => {
        burst();
        if (!likeId[record_id]) like(record_id);
    });
    art.addEventListener("touchend", (e) => {
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

    // The number of comments is the number of records under the pixie's comment index.
    skapi.getIndexes({ table: "comments", index: "comment." + record_id }).then((info) => {
        if (info.list.length) article.querySelector(".comment-count").textContent = info.list[0].number_of_records || 0;
    }).catch((err) => console.error(err));

    return article;
}

/* ================================================================== remix hubs */

/*
    Every public pixie that can start a remix family has a "remix hub": a record in the table "remix_hubs",
    made by the pixie's maker, with data { root, order } and the index root = <the pixie's record id>.
    - Public remixes reference the hub. The hub has can_remove_referencing_records, so its owner can remove
      any remix of the family, and referencing_index_restrictions, so only records of this family (index
      remix_root = root) can reference it.
    - order is the order of the frames, set by the hub's owner in the Frames editor.
    A hub is looked up by its index and must belong to the maker of the first pixie, so nobody else's record
    can act as a family's hub.
    The hub is not deleted with its pixie: deleting it would delete every remix that references it.
*/
const HUB_TABLE = { name: "remix_hubs", access_group: "authorized" };
const hubCache = {}; // root record id -> Promise of the hub record, or null

function getRecordOrNull(record_id) {
    return skapi.getRecords({ record_id }).then((r) => r.list[0] || null).catch(() => null);
}

function getHub(rootId, ownerId) {
    if (!hubCache[rootId]) {
        const request = skapi.getRecords({ table: HUB_TABLE, index: { name: "root", value: rootId } }, { limit: 10 })
            .then((res) => res.list.find((h) => h.user_id === ownerId && h.data?.root === rootId) || null)
            .catch((err) => {
                console.warn("Remix hub not loaded", err);
                if (hubCache[rootId] === request) delete hubCache[rootId];
                return null;
            });
        request.at = Date.now();
        hubCache[rootId] = request;
    }
    return hubCache[rootId];
}

// The hub of a pixie; its maker makes one if there is none yet (pixies shared before hubs existed).
async function ensureHub(root) {
    if (!root?.record_id) return null;
    const found = await getHub(root.record_id, root.user_id);
    if (found || root.user_id !== me.user_id || root.table?.access_group === "private") return found;
    const hub = await skapi.postRecord({ root: root.record_id, order: [] }, {
        table: HUB_TABLE,
        index: { name: "root", value: root.record_id },
        source: {
            can_remove_referencing_records: true,
            referencing_index_restrictions: [{ name: "remix_root", value: root.record_id, condition: "=" }],
        },
    });
    hubCache[root.record_id] = Object.assign(Promise.resolve(hub), { at: Date.now() });
    return hub;
}

/* ================================================================== remix animations */

/*
    A remix family is the first pixie and every remix of it, or of its remixes (all carry the index
    remix_root = the first pixie's record id). Played in the order they were shared, it is a frame by frame
    animation. A family is fetched once its pixie comes near the screen, and plays only while it is on screen.
*/
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FRAME_MS = 550;

const familyObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
        const article = e.target;
        if (e.isIntersecting && !article._familyLoading) {
            article._familyLoading = true;
            loadFamily(article);
        }
        article._visible = e.isIntersecting && e.intersectionRatio >= 0.4;
        const anim = article._anim;
        if (!anim) continue;
        anim.visible = article._visible;
        if (anim.visible && !anim.userPaused && !reducedMotion) playFrames(anim);
        else stopFrames(anim);
    }
}, { rootMargin: "300px 0px", threshold: [0, 0.4] });

function watchFamily(article, p, rootId) {
    article._family = { p, rootId };
    familyObserver.observe(article);
}

async function loadFamily(article) {
    const { p, rootId } = article._family;
    const [root, remixes] = await Promise.all([
        rootId === p.record_id
            ? Promise.resolve(p)
            : skapi.getRecords({ record_id: rootId }).then((r) => r.list[0]).catch(() => null), // may be deleted
        skapi.getRecords(
            { table: { name: POSTS_TABLE, access_group: "authorized" }, index: { name: "remix_root", value: rootId } },
            { limit: 60 }
        ).then((r) => r.list).catch((err) => {
            console.warn("Remixes not loaded", err);
            return [];
        }),
    ]);
    // The remixes that reference the family's hub, and the order its owner set. The hub is read again for
    // every family load (its owner may have changed the order); pixies of one family loading together share it.
    if (Date.now() - (hubCache[rootId]?.at || 0) > 3000) delete hubCache[rootId];
    const hub = root ? await ensureHub(root).catch(() => null) : null;
    const referencing = hub
        ? await skapi.getRecords(
            { table: { name: POSTS_TABLE, access_group: "authorized" }, reference: hub.record_id },
            { limit: 60 }
        ).then((r) => r.list).catch(() => [])
        : [];
    const family = new Map();
    for (const r of [root, ...remixes, ...referencing, p]) {
        if (r?.record_id && r.table?.name === POSTS_TABLE && r.table?.access_group !== "private" && isValid(r.data?.pixels)) {
            family.set(r.record_id, r);
        }
    }
    resetFrames(article);
    if (family.size < 2 || !article.isConnected) return;
    // The owner's order first; frames it doesn't list yet (newer remixes) follow, oldest first.
    const order = Array.isArray(hub?.data?.order) ? hub.data.order : [];
    const place = (r) => (order.includes(r.record_id) ? order.indexOf(r.record_id) : Infinity);
    const time = (r) => r.uploaded || r.updated || 0;
    const frames = [...family.values()].sort((a, b) => (place(a) - place(b)) || (time(a) - time(b)));
    article._familyInfo = { rootId, root, hub, frames };
    setupFrames(article, p.record_id, frames);
    // The maker of the first pixie can arrange its frames.
    if (hub && hub.user_id === me.user_id && p.record_id === rootId) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "btn small frames-edit";
        edit.title = "Arrange or remove the frames of this remix family";
        edit.append(svgIcon("grid"), "Frames");
        edit.onclick = () => openFramesEditor(article);
        article.querySelector(".actions .remix").before(edit);
    }
}

// Remove the animation of a pixie (before it is loaded again).
function resetFrames(article) {
    if (article._anim) {
        clearInterval(article._anim.timer);
        article._anim.badge.remove();
        article._anim = null;
    }
    article.querySelector(".frames-edit")?.remove();
    article.querySelector(".remix-count").hidden = true;
}

function reloadFamily(rootId) {
    for (const a of document.querySelectorAll("article.post")) {
        if (a._family?.rootId === rootId) loadFamily(a);
    }
}

/* ------------------------------------------------------------------ the Frames editor */

let framesEdit = null; // { rootId, hub, list }

function openFramesEditor(article) {
    const info = article._familyInfo;
    framesEdit = { rootId: info.rootId, hub: info.hub, list: info.frames.slice() };
    renderFramesEditor();
    openPanel("framesPanel");
}

function renderFramesEditor() {
    const { list, rootId } = framesEdit;
    $("frameList").replaceChildren(...list.map((f, n) => {
        const li = document.createElement("li");
        li.className = "frame-row";
        const img = document.createElement("img");
        img.src = toDataURL(f.data.pixels);
        img.alt = "";
        const text = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = `Frame ${n + 1}`;
        const by = document.createElement("small");
        by.textContent = f.record_id === rootId ? "your original" : "remix";
        getUserInfo(f.user_id).then((u) => {
            by.textContent = (f.record_id === rootId ? "your original" : "remix") + " · " + authorLabel(u);
        });
        text.append(title, by);
        const tools = document.createElement("span");
        tools.className = "frame-tools";
        const btn = (icon, label, fn, disabled = false, cls = "") => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "btn small icon-only " + cls;
            b.setAttribute("aria-label", label);
            b.title = label;
            const svg = svgIcon(icon === "up" || icon === "down" ? "arrow" : icon);
            if (icon === "up") svg.classList.add("rot-270");
            if (icon === "down") svg.classList.add("rot-90");
            b.append(svg);
            b.disabled = disabled;
            b.onclick = fn;
            return b;
        };
        tools.append(
            btn("up", "Move up", () => moveFrame(n, -1), n === 0),
            btn("down", "Move down", () => moveFrame(n, 1), n === list.length - 1),
        );
        if (f.record_id !== rootId) tools.append(btn("trash", "Remove this remix", () => removeFrame(f), false, "danger"));
        li.append(img, text, tools);
        return li;
    }));
}

function moveFrame(n, d) {
    const list = framesEdit.list;
    [list[n], list[n + d]] = [list[n + d], list[n]];
    renderFramesEditor();
}

// The hub's owner removes someone's remix: it is deleted (can_remove_referencing_records).
async function removeFrame(f) {
    const who = authorLabel(await getUserInfo(f.user_id));
    if (!confirm(`Remove this remix by ${who}? It is deleted for everyone.`)) return;
    try {
        await skapi.deleteRecords({ record_id: f.record_id });
        framesEdit.list = framesEdit.list.filter((x) => x !== f);
        document.getElementById("post-" + f.record_id)?.remove();
        renderFramesEditor();
        toast("Remix removed");
    } catch (err) {
        alert(err.message);
    }
}

async function saveFrameOrder() {
    const { hub, rootId, list } = framesEdit;
    const button = $("saveFramesButton");
    button.disabled = true;
    try {
        const order = list.map((f) => f.record_id);
        const updated = await skapi.postRecord({ ...hub.data, root: rootId, order }, { record_id: hub.record_id });
        hubCache[rootId] = Object.assign(Promise.resolve({ ...hub, ...updated, data: { ...hub.data, root: rootId, order } }), { at: Date.now() });
        closePanels();
        toast("Frame order saved");
        reloadFamily(rootId);
    } catch (err) {
        alert(err.message);
    } finally {
        button.disabled = false;
    }
}

function setupFrames(article, ownId, frames) {
    const img = article.querySelector(".art img");
    const own = Math.max(0, frames.findIndex((f) => f.record_id === ownId));
    const anim = {
        img,
        frames: frames.map((f) => ({ src: toDataURL(f.data.pixels), user_id: f.user_id, name: "" })),
        own,
        i: own,
        timer: 0,
        visible: !!article._visible,
        userPaused: false,
    };
    article._anim = anim;

    // "3 / 7 · Ann": which frame is showing and who drew it. Tap to pause or play.
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "frame-badge";
    badge.title = "Remix animation: tap to pause or play";
    badge.innerHTML = `<svg><use href="#i-play"/></svg><span class="frame-no"></span><span class="frame-by"></span>`;
    anim.badge = badge;
    const stop = (e) => e.stopPropagation();
    badge.addEventListener("dblclick", stop);
    badge.addEventListener("touchend", stop);
    badge.onclick = (e) => {
        e.stopPropagation();
        anim.userPaused = !!anim.timer;
        if (anim.timer) stopFrames(anim);
        else playFrames(anim);
    };
    article.querySelector(".art").append(badge);

    frames.forEach((f, n) => getUserInfo(f.user_id).then((u) => {
        anim.frames[n].name = authorLabel(u);
        if (anim.i === n) showFrame(anim, n);
    }));
    const count = article.querySelector(".remix-count");
    const remixes = frames.length - 1;
    count.textContent = ` · ${frames.length} frames`;
    count.title = `${remixes} remix${remixes === 1 ? "" : "es"} in this family`;
    count.hidden = false;
    showFrame(anim, own);
    if (anim.visible && !reducedMotion) playFrames(anim);
}

function showFrame(anim, n) {
    anim.i = n;
    anim.img.src = anim.frames[n].src;
    anim.badge.querySelector(".frame-no").textContent = `${n + 1}/${anim.frames.length}`;
    const by = anim.frames[n].name;
    anim.badge.querySelector(".frame-by").textContent = by ? "· " + by : "";
    anim.badge.classList.toggle("own", n === anim.own);
}

function playFrames(anim) {
    if (anim.timer) return;
    anim.badge.querySelector("use").setAttribute("href", "#i-pause");
    anim.timer = setInterval(() => showFrame(anim, (anim.i + 1) % anim.frames.length), FRAME_MS);
}

// Stopped, a pixie shows its own frame.
function stopFrames(anim) {
    clearInterval(anim.timer);
    anim.timer = 0;
    anim.badge.querySelector("use").setAttribute("href", "#i-play");
    showFrame(anim, anim.own);
}

function closeDownloadMenus() {
    for (const m of document.querySelectorAll(".download-menu:not([hidden])")) {
        m.hidden = true;
        m.closest("article")?.querySelector(".download")?.setAttribute("aria-expanded", "false");
    }
}

function saveFile(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

document.addEventListener("click", (e) => {
    if (!e.target.closest(".download-menu")) closeDownloadMenus();
});

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
    if (!confirm("Delete this pixie?")) return;
    try {
        await skapi.deleteRecords({ record_id });
        article.remove();
        if (!section_posts.querySelector("article")) showEmptyMessage(emptyTextForView());
        toast("Pixie deleted");
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
        items.push(createCommentElement(c.user_id, commenter, c.updated, c.data?.comment));
    }
    return { items, endOfList: comments.endOfList };
}

function createCommentElement(user_id, commenter, updated, text) {
    const li = document.createElement("li");
    li.append(avatarImg(user_id, "xs"));
    const body = document.createElement("div");
    const p = document.createElement("p");
    const author = document.createElement("strong");
    author.textContent = authorLabel(commenter);
    author.dataset.author = user_id; // renamed in place if you change your name
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
        const comment = await skapi.postRecord(
            { comment: text },
            { table: { name: "comments", access_group: "authorized" }, index: { name: "comment." + record_id, value: true } }
        );
        const article = form.closest("article");
        const counter = article.querySelector(".comment-count");
        counter.textContent = Number(counter.textContent) + 1;
        article.querySelector(".comments").prepend(createCommentElement(me.user_id, me, comment.updated, comment.data?.comment));
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
            if (ownerId) notifyUser(ownerId, { kind: "like", post: record_id }, `❤️ ${authorLabel(me)} liked your pixie`);
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
            toast("Following! Their new pixies show up in Following.");
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
    const headings = { "": "Recent", mostliked: "Most liked", mostcomment: "Most commented", myposts: "My pixies", myprivate: "My private pixies", feed: "Following" };
    if (headings[hash] !== undefined) return headings[hash];
    if (hash.startsWith("tag=")) return "#" + safeDecode(hash.slice(4));
    if (hash.startsWith("post=")) return "Pixie";
    if (hash.startsWith("user=")) return "Pixies";
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
    The URL hash decides which pixies are shown. initialFetch() runs when the page loads and whenever the hash changes.
*/
async function initialFetch() {
    if (!me) return;
    // App shortcuts and notifications open these; they are actions, not views.
    const action = location.hash.slice(1);
    if (["paint", "camera", "activity", "profile", "shared"].includes(action)) {
        history.replaceState(null, "", location.pathname + location.search);
        runAction(action);
    }
    const hash = location.hash.slice(1);
    $("postsHeading").textContent = viewTitle(hash);
    $("viewExtra").replaceChildren();
    markCurrentTab(hash);
    fetchMoreButton.hidden = false;
    showEmptyMessage("Loading pixies…");
    window.scrollTo({ top: 0 });

    switch (hash) {
        case "mostliked":
            // Ordered by the reserved index $referenced_count: the number of likes.
            fetchQuery = { table: { name: POSTS_TABLE, access_group: "authorized" }, index: { name: "$referenced_count", value: 0, condition: ">" } };
            return getPosts(false);
        case "mostcomment":
            return getMostCommentedPost(false);
        case "myposts":
            fetchQuery = { table: { name: POSTS_TABLE, access_group: "authorized" }, index: { name: "$user_id", value: me.user_id } };
            return getPosts(false);
        case "myprivate":
            fetchQuery = { table: { name: POSTS_TABLE, access_group: "private" }, index: { name: "$user_id", value: me.user_id } };
            return getPosts(false);
        case "feed":
            return getFeed(false);
    }
    if (hash.startsWith("post=")) return getOnePost(safeDecode(hash.slice(5)));
    if (hash.startsWith("user=")) {
        const user_id = safeDecode(hash.slice(5));
        fetchQuery = { table: { name: POSTS_TABLE, access_group: "authorized" }, index: { name: "$user_id", value: user_id } };
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
    // All pixies, newest first. With "#tag=<tag>" only the posts with that tag.
    fetchQuery = { table: { name: POSTS_TABLE, access_group: "authorized" } };
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
        if (rt.type === "private" && rt.message?.app === "pixie" && rt.sender && rt.sender !== me?.user_id) {
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
        await skapi.postRealtime(
            { app: "pixie", ...payload, from_name: authorLabel(me) },
            user_id,
            { title: "pixie", body: text }
        );
    } catch (err) {
        console.warn("Could not notify", err);
    }
}

function activityKey() {
    return "pixie:activity:" + me.user_id;
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
    if (a.kind === "like") return `${who} liked your pixie`;
    if (a.kind === "remix") return `${who} remixed your pixie`;
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
            img: avatarSrc(item.from),
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
        b.append(avatarImg(a.from, "md"));
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
        status.textContent = "On iPhone and iPad, notifications work in the installed app: tap Share, then \u201cAdd to Home Screen\u201d, and open pixie from your Home Screen.";
        return;
    }
    if (!pushSupported()) {
        btn.hidden = true;
        status.textContent = window.isSecureContext
            ? "This browser does not support push notifications. You still get live notifications while pixie is open."
            : "Push notifications need the app on HTTPS. You still get live notifications while pixie is open.";
        return;
    }
    btn.hidden = false;
    const sub = await currentPushSubscription().catch(() => null);
    if (sub) {
        status.textContent = "Notifications are on for this device. 🔔";
        btn.textContent = "Turn off";
        btn.className = "btn ghost";
    } else {
        status.textContent = "Get a notification on this device when someone likes, comments, remixes or follows you, and when people you follow post.";
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
    try { localStorage.setItem("pixie:push-user", me.user_id); } catch (err) { /* blocked */ }
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
        try { owner = localStorage.getItem("pixie:push-user"); } catch (err) { /* blocked */ }
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
        try { localStorage.setItem("pixie:push-user", me.user_id); } catch (err) { /* blocked */ }
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
    toast("pixie is installed 🎉 Find it on your home screen.");
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
        alert("To install pixie: tap the Share button (the square with an arrow), then \u201cAdd to Home Screen\u201d.");
    }
}

function updateInstallUi() {
    const btn = $("installButton"), status = $("installStatus");
    if (isStandalone()) {
        btn.hidden = true;
        status.textContent = "You're using the pixie app. 🎉";
    } else if (canInstall()) {
        btn.hidden = false;
        status.textContent = isIOS
            ? "Add pixie to your Home Screen: it opens full screen, and on iPhone that is what turns on notifications."
            : "Install pixie: it opens full screen like an app and keeps notifications coming.";
    } else {
        btn.hidden = true;
        status.textContent = "You can install pixie from your browser's menu (\u201cInstall app\u201d or \u201cAdd to Home Screen\u201d).";
    }
}

/*
    One gentle banner above the feed: install the app, or (once installed or where it is not needed)
    turn notifications on. "Not now" hides it for a week.
*/
function bannerDismissed(kind) {
    try {
        return Date.now() - Number(localStorage.getItem("pixie:banner:" + kind) || 0) < 7 * 864e5;
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
        install: "Get the pixie app: a full screen studio, and notifications for likes, comments, remixes and new followers.",
        ios: "Install pixie: tap Share, then \u201cAdd to Home Screen\u201d. On iPhone that's what turns on notifications.",
        notify: "Turn on notifications to hear about likes, comments, remixes, new followers and new pixies from people you follow.",
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
    try { localStorage.setItem("pixie:banner:" + kind, String(Date.now())); } catch (err) { /* blocked */ }
    updatePwaBanner();
}

// A new version of the app is ready: offer it, never reload by itself (it could be mid-drawing).
function watchForUpdates(reg) {
    if (!reg) return;
    const offer = (worker) => toast("A new version of pixie is ready. Tap to update ✨", {
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
        if (["paint", "camera", "activity", "profile", "shared"].includes(msg.open)) runAction(msg.open);
        else location.hash = msg.open;
    } else if (msg.type === "PUSH" && msg.data?.type === "record") {
        toast(msg.data.title || "New pixie from someone you follow", { onClick: () => (location.hash = "post=" + msg.data.record_id) });
    } else if (msg.type === "RESUBSCRIBE") {
        syncPushSubscription(true);
    }
});

function runAction(action) {
    // "camera" is the shortcut of the app pixie grew out of: it opens the studio too.
    if (action === "paint" || action === "camera") openStudio();
    else if (action === "activity") openActivity();
    else if (action === "profile") openProfile();
    else if (action === "shared") openSharedPicture();
}

// A picture shared to pixie from another app (see the share target in sw.js and the manifest) becomes NES pixels.
async function openSharedPicture() {
    try {
        const cache = await caches.open("pixie-share");
        const key = new URL("shared-picture", location.href).href;
        const res = await cache.match(key);
        if (!res) return openStudio();
        const blob = await res.blob();
        await cache.delete(key);
        await importPicture(blob);
    } catch (err) {
        console.error(err);
        openStudio();
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
    if ($("studioSheet").hidden && $("composeSheet").hidden) lockScroll(false);
}

async function openProfile() {
    openPanel("profilePanel");
    updateInstallUi();
    showName();
    renderAvatarPicker();
    getAvatar(me.user_id).then(renderAvatarPicker);
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

$("openStudioButton").onclick = () => openStudio();
$("closeStudioButton").onclick = closeStudio;
$("nextButton").onclick = () => (studioMode === "avatar" ? saveAvatarFromStudio() : openCompose());
$("drawAvatarButton").onclick = openAvatarStudio;
$("saveFramesButton").onclick = saveFrameOrder;
for (const b of document.querySelectorAll(".tool[data-tool]")) b.onclick = () => setTool(b.dataset.tool);
$("mirrorToggle").onclick = () => {
    editor.mirror = !editor.mirror;
    setPressed("mirrorToggle", editor.mirror);
    editor.render();
};
$("gridToggle").onclick = () => {
    editor.grid = !editor.grid;
    setPressed("gridToggle", editor.grid);
    editor.render();
};
$("undoButton").onclick = () => editor.undo();
$("redoButton").onclick = () => editor.redo();
$("flipButton").onclick = () => editor.flip();
for (const b of document.querySelectorAll("[data-shift]")) {
    b.onclick = () => {
        const [dx, dy] = b.dataset.shift.split(",").map(Number);
        editor.shift(dx, dy);
    };
}
$("importInput").onchange = (e) => {
    importPicture(e.target.files[0]);
    e.target.value = "";
};
$("clearButton").onclick = () => {
    if (!editor || editor.isEmpty()) return;
    editor.clear();
    remixOf = null;
    showRemixNote();
    studioChanged();
    toast("Cleared. Undo brings it back.");
};
$("composeBackButton").onclick = closeCompose;
$("postForm").onsubmit = postPixie;
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

// Keyboard: Escape closes; in the studio, the usual pixel editor shortcuts.
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (document.querySelector(".download-menu:not([hidden])")) closeDownloadMenus();
        else if (!$("composeSheet").hidden) closeCompose();
        else if (!$("studioSheet").hidden) closeStudio();
        else closePanels();
        return;
    }
    if ($("studioSheet").hidden || !$("composeSheet").hidden || !editor) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        editor.redo();
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tools = { b: "pen", p: "pen", e: "eraser", f: "fill", i: "picker" };
    if (tools[key]) setTool(tools[key]);
    else if (key === "m") $("mirrorToggle").click();
    else if (key === "g") $("gridToggle").click();
    else if (e.shiftKey && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        editor.shift(...d);
    }
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
    for (const img of document.querySelectorAll("img[data-me-avatar]")) img.dataset.avatarOf = me.user_id;
    refreshAvatars(me.user_id);
    getAvatar(me.user_id).then(() => refreshAvatars(me.user_id));
    initialFetch();
    renderActivity();
    connectRealtime();
    // Installable app: banners, notifications for this account on this device, updates.
    updatePwaBanner();
    syncPushSubscription();
    swReady.then(watchForUpdates);
})();
