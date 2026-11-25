/*
    Tests of the Share panel in js/app.js and the share picture in js/share.js:
    - what "Save and post it yourself" offers (order, labels, file names, which frames and sizes);
    - the video is made only when a button asks for it, once, with its progress on the button and in the status
      line (which screen readers announce), and a second tap while it is being made does nothing; the busy button
      keeps focus (aria-disabled, not disabled); the share button makes it on the first tap and shares on the next;
      after Video downloads it, the button reads "Save video" for one more tap; closing the panel or opening it
      for another pixie stops it;
    - the credit line of the share picture ("by <name>", cut to fit);
    - posts have no download button or menu any more, and Frames sits right before Remix.

    js/app.js is a browser module that touches the page as soon as it loads, so the functions under test are cut
    out of its source as they are and run in a sandbox with a fake page. Nothing reaches a server.

    Run: node tests/share.test.mjs   (or npm test)
*/
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fitText, shareCredit, makeShareVideo } from "../js/share.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../js/app.js");
const html = read("../index.html");
const css = read("../app.css");

// The text of a top-level function declaration (async or not), up to its matching closing brace.
function cut(name) {
    const m = new RegExp(`^(async )?function ${name}\\(`, "m").exec(source);
    if (!m) throw new Error("not found in js/app.js: " + name);
    let i = source.indexOf("{", m.index);
    let depth = 0;
    for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) return source.slice(m.index, i + 1);
    }
    throw new Error("unbalanced: " + name);
}

// A top-level `const NAME = ...;` line.
function cutConst(name) {
    const m = new RegExp(`^const ${name} = .*;$`, "m").exec(source);
    if (!m) throw new Error("not found in js/app.js: const " + name);
    return m[0];
}

const FUNCTIONS = ["saveChoices", "setButtonText", "showVideoProgress", "endVideoProgress", "setWorking", "isWorking", "openShare", "canShareFile", "stopSharePreview"];
const PIX = (c) => c.repeat(256);
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake element: enough of a button for openShare().
function fakeElement(id, { label = false } = {}) {
    const classes = new Set();
    const props = {};
    const attrs = {};
    const labelEl = label ? { textContent: "" } : null;
    return {
        id,
        hidden: false,
        disabled: false,
        onclick: null,
        textContent: "",
        src: "",
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        style: { setProperty: (k, v) => (props[k] = v), removeProperty: (k) => delete props[k], props },
        querySelector: (sel) => (sel === ".label" ? labelEl : null),
        setAttribute: (k, v) => (attrs[k] = String(v)),
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
        removeAttribute: (k) => delete attrs[k],
        attrs,
        // At work: its clicks do nothing, but it is not disabled, so it keeps focus.
        get working() {
            return attrs["aria-disabled"] === "true";
        },
        replaceChildren() {},
        get text() {
            return labelEl ? labelEl.textContent : this.textContent;
        },
        // A tap: a disabled button gets no click (an aria-disabled one does: its handler ignores it).
        tap() {
            if (this.disabled || this.hidden || !this.onclick) return undefined;
            return this.onclick();
        },
    };
}

const SAVE_IDS = ["saveVideoButton", "saveImageButton", "saveGifButton", "saveGifSmallButton", "savePngButton", "saveIcoButton"];

function sandbox({ video = "video/mp4;codecs=avc1", canShare = true } = {}) {
    const calls = { videos: [], saved: [], shared: [], images: [], gifs: [], pngs: [], icos: [], errors: [] };
    const els = {};
    for (const id of SAVE_IDS) els[id] = fakeElement(id, { label: true });
    for (const id of ["shareFileButton", "shareStatus", "sharePreview", "shareLinkBox", "sharePrivateNote", "shareLinks", "copyLinkButton"]) els[id] = fakeElement(id);
    const ctx = {
        console: { warn() {}, log() {}, error: (e) => calls.errors.push(e) },
        me: { user_id: "me1" },
        FRAME_MS: 550,
        $: (id) => els[id],
        document: { createElement: () => fakeElement("a") },
        navigator: {
            canShare: () => canShare,
            share: async (data) => calls.shared.push(data),
            clipboard: { writeText: async () => {} },
        },
        File: class {
            constructor(parts, name, opts) {
                this.parts = parts;
                this.name = name;
                this.type = opts?.type;
            }
        },
        setInterval: () => 1,
        clearInterval: () => {},
        encodeURIComponent,
        pageUrl: (p) => "https://pixie.skapi.com/" + p,
        toDataURL: (s) => "data:" + s.slice(0, 1),
        shareLinks: () => [],
        shareCardUrl: async () => null,
        toast() {},
        prompt() {},
        familyFrames: async (article) => article.frames || null,
        videoSupport: () => video,
        makeShareVideo: (frames, ms, opts) => {
            let resolve, reject;
            const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
            calls.videos.push({ frames, ms, opts, resolve, reject });
            return promise;
        },
        makeShareImage: async (str, opts) => (calls.images.push({ str, opts: plain(opts) }), { blob: "image", str }),
        toGif: (frames, ms, scale) => (calls.gifs.push({ frames, ms, scale }), { blob: "gif", scale }),
        toBlob: async (str, scale) => (calls.pngs.push({ str, scale }), { blob: "png", scale }),
        toIco: (str) => (calls.icos.push(str), { blob: "ico" }),
        saveFile: (blob, name) => calls.saved.push({ blob, name }),
        Promise,
        Set,
        Math,
        DOMException,
    };
    vm.createContext(ctx);
    vm.runInContext([
        "let shareJob = 0;",
        "let sharePreviewTimer = 0;",
        cutConst("SAVE_BUTTONS"),
        ...FUNCTIONS.map(cut),
        // What the real openPanel() / closePanels() do to the Share panel's job.
        "function openPanel() { closePanels(); }",
        "function closePanels() { shareJob++; }",
        "this.fns = { " + FUNCTIONS.join(", ") + ", closePanels, SAVE_BUTTONS };",
    ].join("\n\n"), ctx);
    return { ...ctx.fns, calls, els, ctx };
}

const animatedPixie = () => ({
    article: { _hasFamily: true, _familyInfo: {}, _anim: { own: 1 }, frames: [PIX("a"), PIX("b"), PIX("c")] },
    p: { record_id: "r1", user_id: "ann", table: { name: "pixies", access_group: "authorized" }, data: { pixels: PIX("b"), description: "cat" } },
});
const stillPixie = () => ({
    article: { _hasFamily: false },
    p: { record_id: "s1", user_id: "ann", table: { name: "pixies", access_group: "authorized" }, data: { pixels: PIX("z") } },
});
const shownSaves = (t) => SAVE_IDS.filter((id) => !t.els[id].hidden).map((id) => t.els[id].text);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------------------------------------------------------------- what is offered */

test("saveChoices: an animated pixie with video support, in the owner's order", () => {
    const t = sandbox();
    const frames = [PIX("a"), PIX("b")];
    const list = t.saveChoices({ base: "pixie-r1", frames, own: PIX("b"), name: "Ann", video: "video/mp4" });
    assert.deepEqual(plain(list.map((c) => [c.id, c.label, c.name ?? null])), [
        ["saveVideoButton", "Video", null],
        ["saveImageButton", "Image", "pixie-r1-1080.png"],
        ["saveGifButton", "GIF animation", "pixie-r1-animation.gif"],
        ["saveGifSmallButton", "GIF animation 16×16", "pixie-r1-animation-16x16.gif"],
        ["savePngButton", "PNG 512×512", "pixie-r1-512.png"],
        ["saveIcoButton", "ICO 16×16", "pixie-r1.ico"],
    ]);
    assert.equal(list[0].video, true);
    assert.equal(list[0].make, undefined); // made by openShare() on a tap, never here
    assert.equal(t.calls.videos.length, 0);
});

test("saveChoices: each file is made from the right frames, at the right size, only when asked", async () => {
    const t = sandbox();
    const frames = [PIX("a"), PIX("b"), PIX("c")];
    const own = PIX("b");
    const list = t.saveChoices({ base: "pixie-r1", frames, own, name: "Ann", video: null });
    assert.equal(t.calls.gifs.length + t.calls.images.length + t.calls.pngs.length + t.calls.icos.length, 0);
    const by = Object.fromEntries(list.map((c) => [c.id, c]));
    await by.saveImageButton.make();
    assert.deepEqual(t.calls.images, [{ str: own, opts: { by: "Ann" } }]);
    by.saveGifButton.make();
    by.saveGifSmallButton.make();
    assert.deepEqual(t.calls.gifs.map((g) => [g.frames, g.ms, g.scale]), [[frames, 550, 20], [frames, 550, 1]]);
    await by.savePngButton.make();
    assert.deepEqual(t.calls.pngs, [{ str: own, scale: 32 }]);
    by.saveIcoButton.make();
    assert.deepEqual(t.calls.icos, [own]);
});

test("saveChoices: no Video without video support, nor for a still pixie; a still pixie's GIFs are plain GIFs", () => {
    const t = sandbox();
    const anim = t.saveChoices({ base: "b", frames: [PIX("a"), PIX("b")], own: PIX("a"), name: "A", video: null });
    assert.equal(anim.some((c) => c.video), false);
    assert.equal(anim.length, 5);
    const still = t.saveChoices({ base: "b", frames: [PIX("a")], own: PIX("a"), name: "A", video: "video/mp4" });
    assert.deepEqual(plain(still.map((c) => [c.label, c.name])), [
        ["Image", "b-1080.png"],
        ["GIF", "b.gif"],
        ["GIF 16×16", "b-16x16.gif"],
        ["PNG 512×512", "b-512.png"],
        ["ICO 16×16", "b.ico"],
    ]);
});

test("the Share panel's buttons are in the same order as saveChoices(), under \"Save and post it yourself\"", () => {
    const t = sandbox();
    assert.deepEqual(plain(t.SAVE_BUTTONS), SAVE_IDS);
    const saves = html.slice(html.indexOf("Save and post it yourself"));
    const ids = [...saves.matchAll(/id="(save\w+Button)"/g)].map((m) => m[1]).slice(0, SAVE_IDS.length);
    assert.deepEqual(ids, SAVE_IDS);
    for (const id of SAVE_IDS) assert.match(html, new RegExp(`id="${id}"[^>]*>.*<span class="label">`));
});

/* ---------------------------------------------------------------- the panel */

test("opening the panel for an animated pixie makes no video", async () => {
    const t = sandbox();
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    await tick();
    assert.equal(t.calls.videos.length, 0);
    assert.deepEqual(shownSaves(t), ["Video", "Image", "GIF animation", "GIF animation 16×16", "PNG 512×512", "ICO 16×16"]);
    assert.ok(SAVE_IDS.every((id) => !t.els[id].disabled));
    const share = t.els.shareFileButton;
    assert.equal(share.hidden, false);
    assert.equal(share.disabled, false);
    assert.equal(share.text, "Make video to share");
    assert.equal(t.calls.gifs.length + t.calls.images.length, 0); // and no other file either
});

test("Video: the first tap makes it with its progress on the button, a second tap does nothing, then it downloads", async () => {
    const t = sandbox();
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    const button = t.els.saveVideoButton;
    const done = button.tap();
    assert.equal(t.calls.videos.length, 1);
    const v = t.calls.videos[0];
    assert.deepEqual(v.frames, article.frames); // the family's frames, in play order
    assert.equal(v.ms, 550);
    assert.equal(button.disabled, false); // keeps focus...
    assert.equal(button.working, true); // ...but is busy
    assert.equal(button.attrs["aria-busy"], "true");
    assert.equal(button.text, "Making video… 0%");
    assert.equal(t.els.shareStatus.textContent, "Making your video… 0%"); // announced
    assert.ok(button.classList.contains("busy"));
    v.opts.onProgress(0.42);
    assert.equal(button.text, "Making video… 42%");
    assert.equal(button.style.props["--progress"], "42%");
    assert.equal(t.els.shareStatus.textContent, "Making your video… 42%");
    await button.tap(); // busy: a second tap makes nothing new
    assert.equal(t.calls.videos.length, 1);
    assert.equal(t.calls.saved.length, 0);
    v.opts.onProgress(1);
    v.resolve({ blob: "VIDEO", ext: "mp4", type: "video/mp4" });
    await done;
    assert.deepEqual(t.calls.saved.map((s) => s.name), ["pixie-r1.mp4"]);
    assert.equal(t.calls.saved[0].blob.parts[0], "VIDEO");
    assert.equal(button.working, false);
    assert.equal(button.attrs["aria-busy"], undefined);
    // One more tap saves it, in case the automatic download (long after the tap) was refused.
    assert.equal(button.text, "Save video");
    assert.match(t.els.shareStatus.textContent, /^Your video is ready and downloading\. If it doesn't, tap Save video\.$/);
    assert.equal(button.classList.contains("busy"), false);
    // Made by Video, the share button can share it at once.
    assert.equal(t.els.shareFileButton.text, "Share video…");
    // Another tap downloads the same video again at once, without making it again.
    await button.tap();
    assert.equal(t.calls.videos.length, 1);
    assert.deepEqual(t.calls.saved.map((s) => s.name), ["pixie-r1.mp4", "pixie-r1.mp4"]);
    assert.equal(button.text, "Save video");
});

test("Share: the first tap makes the video (button busy), the button becomes \"Share video…\", the next tap shares", async () => {
    const t = sandbox();
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    const share = t.els.shareFileButton;
    const first = share.tap();
    assert.equal(t.calls.videos.length, 1);
    assert.equal(share.disabled, false);
    assert.equal(share.working, true);
    assert.equal(share.text, "Making video… 0%");
    t.calls.videos[0].opts.onProgress(0.5);
    assert.equal(share.text, "Making video… 50%");
    assert.equal(t.els.shareStatus.textContent, "Making your video… 50%");
    await share.tap(); // busy: nothing
    assert.equal(t.calls.videos.length, 1);
    assert.equal(t.calls.shared.length, 0);
    // The Video button, tapped meanwhile, waits for the same video.
    const save = t.els.saveVideoButton.tap();
    assert.equal(t.calls.videos.length, 1);
    t.calls.videos[0].opts.onProgress(0.6);
    assert.equal(t.els.saveVideoButton.text, "Making video… 60%");
    t.calls.videos[0].resolve({ blob: "V", ext: "webm", type: "video/webm" });
    await first;
    await save;
    assert.equal(t.calls.shared.length, 0); // the share sheet needs a fresh tap
    assert.equal(share.working, false);
    assert.equal(share.text, "Share video…");
    assert.deepEqual(t.calls.saved.map((s) => s.name), ["pixie-r1.webm"]);
    await share.tap();
    assert.equal(t.calls.shared.length, 1);
    assert.equal(t.calls.shared[0].files[0].name, "pixie-r1.webm");
    assert.equal(t.calls.videos.length, 1);
});

test("a video that fails can be tried again, and says why", async () => {
    const t = sandbox();
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    const button = t.els.saveVideoButton;
    const first = button.tap();
    t.calls.videos[0].reject(new Error("no encoder"));
    await first;
    assert.equal(t.els.shareStatus.textContent, "no encoder");
    assert.equal(button.working, false);
    assert.equal(button.text, "Video");
    const again = button.tap();
    assert.equal(t.calls.videos.length, 2);
    t.calls.videos[1].resolve({ blob: "V", ext: "mp4", type: "video/mp4" });
    await again;
    assert.equal(t.calls.saved.length, 1);
});

test("closing the panel stops the video being made, and its result is dropped", async () => {
    const t = sandbox();
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    const making = t.els.saveVideoButton.tap();
    const v = t.calls.videos[0];
    assert.equal(v.opts.isCancelled(), false);
    t.closePanels();
    assert.equal(v.opts.isCancelled(), true);
    v.reject(new DOMException("The video was cancelled", "AbortError"));
    await making;
    assert.equal(t.calls.saved.length, 0);
    assert.doesNotMatch(t.els.shareStatus.textContent, /cancelled/); // a cancel is not an error to show
});

test("opening the panel for another pixie stops the first one's video, and nothing of it is saved or shown", async () => {
    const t = sandbox();
    const a = animatedPixie();
    await t.openShare(a.article, a.p, "Ann");
    const making = t.els.saveVideoButton.tap();
    const v = t.calls.videos[0];
    const s = stillPixie();
    await t.openShare(s.article, s.p, "Bo");
    assert.equal(v.opts.isCancelled(), true);
    v.opts.onProgress(0.9); // a late progress report
    assert.equal(t.els.saveVideoButton.hidden, true);
    v.resolve({ blob: "V", ext: "mp4", type: "video/mp4" }); // even when it finishes anyway
    await making;
    assert.equal(t.calls.saved.length, 0);
    assert.equal(t.els.shareFileButton.text, "Share image…");
    assert.equal(t.els.saveGifButton.text, "GIF");
});

test("a still pixie: its picture is ready to share at once (credited by its maker), and saves as Image, GIF, GIF 16×16, PNG, ICO", async () => {
    const t = sandbox();
    const { article, p } = stillPixie();
    await t.openShare(article, p, "Bo");
    assert.deepEqual(shownSaves(t), ["Image", "GIF", "GIF 16×16", "PNG 512×512", "ICO 16×16"]);
    assert.equal(t.calls.videos.length, 0);
    assert.deepEqual(t.calls.images, [{ str: p.data.pixels, opts: { by: "Bo" } }]);
    const share = t.els.shareFileButton;
    assert.equal(share.text, "Share image…");
    assert.equal(share.disabled, false);
    await share.tap();
    assert.equal(t.calls.shared[0].files[0].name, "pixie-s1-1080.png");
    for (const id of SAVE_IDS.slice(1)) await t.els[id].tap();
    assert.deepEqual(t.calls.saved.map((s) => s.name), ["pixie-s1-1080.png", "pixie-s1.gif", "pixie-s1-16x16.gif", "pixie-s1-512.png", "pixie-s1.ico"]);
    assert.deepEqual(t.calls.gifs.map((g) => [g.frames.length, g.scale]), [[1, 20], [1, 1]]);
});

test("an animated pixie without video support: no Video, and the GIF is ready to share at once", async () => {
    const t = sandbox({ video: null });
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    assert.equal(t.els.saveVideoButton.hidden, true);
    assert.equal(t.els.shareFileButton.text, "Share GIF…");
    assert.equal(t.els.shareFileButton.disabled, false);
    assert.deepEqual(t.calls.gifs.map((g) => g.scale), [20]);
    await t.els.shareFileButton.tap();
    assert.equal(t.calls.shared[0].files[0].name, "pixie-r1-animation.gif");
    assert.equal(t.calls.videos.length, 0);
});

test("without a share sheet the share button is hidden, and Video still makes and downloads the video", async () => {
    const t = sandbox({ canShare: false });
    const { article, p } = animatedPixie();
    await t.openShare(article, p, "Ann");
    assert.equal(t.els.shareFileButton.hidden, true);
    assert.equal(t.calls.videos.length, 0);
    const making = t.els.saveVideoButton.tap();
    t.calls.videos[0].resolve({ blob: "V", ext: "mp4", type: "video/mp4" });
    await making;
    assert.deepEqual(t.calls.saved.map((s) => s.name), ["pixie-r1.mp4"]);
});

test("openShare never makes a video except through makeVideo (a tap)", () => {
    const src = cut("openShare");
    assert.equal(src.match(/makeShareVideo\(/g).length, 1);
    assert.match(src, /const makeVideo = \(\) => \(videoMaking \|\|= makeShareVideo\(/);
});

test("makeShareVideo stops recording within a repaint of a cancel, not at the end of the frame", async () => {
    const log = { recorders: 0, stopped: 0, tracks: 0 };
    const ctx2d = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === "measureText" ? () => ({ width: 1 }) : () => {}), set: (o, k, v) => ((o[k] = v), true) });
    const saved = { document: globalThis.document, MediaRecorder: globalThis.MediaRecorder, HTMLCanvasElement: globalThis.HTMLCanvasElement };
    globalThis.HTMLCanvasElement = { prototype: { captureStream() {} } };
    globalThis.MediaRecorder = class {
        static isTypeSupported(t) {
            return t === "video/webm";
        }
        constructor() {
            log.recorders++;
        }
        start() {}
        stop() {
            log.stopped++;
            setTimeout(() => this.onstop?.(), 0);
        }
    };
    globalThis.document = {
        createElement: () => ({ getContext: () => ctx2d, captureStream: () => ({ getTracks: () => [{ stop: () => log.tracks++ }] }) }),
    };
    try {
        let cancel = false;
        const started = Date.now();
        const making = makeShareVideo([PIX("0"), PIX("1")], 5000, { isCancelled: () => cancel });
        setTimeout(() => (cancel = true), 20);
        await assert.rejects(making, (err) => err.name === "AbortError");
        assert.ok(Date.now() - started < 1000, "stopped long after the cancel: " + (Date.now() - started) + " ms");
        assert.deepEqual(log, { recorders: 1, stopped: 1, tracks: 1 });
    } finally {
        Object.assign(globalThis, saved);
    }
});

/* ---------------------------------------------------------------- the share picture's credit */

test("shareCredit: \"by <name>\", or the app's address with no name", () => {
    assert.equal(shareCredit("Ann"), "by Ann");
    assert.equal(shareCredit("  Ann   Lee "), "by Ann Lee");
    assert.equal(shareCredit(""), "pixie.skapi.com");
    assert.equal(shareCredit(undefined), "pixie.skapi.com");
});

test("fitText keeps a line that fits, and cuts a long one with … to fit", () => {
    const measure = (t) => Array.from(t).length * 26; // Press Start 2P: every character 1em wide
    assert.equal(fitText("by Ann", 960, measure), "by Ann");
    const long = "by " + "VeryLongName".repeat(10);
    const cutText = fitText(long, 960, measure);
    assert.ok(cutText.endsWith("…"));
    assert.ok(measure(cutText) <= 960);
    assert.equal(Array.from(cutText).length, 36); // as many as fit
    assert.ok(long.startsWith(cutText.slice(0, -1)));
    // Whole characters only: an emoji is never split.
    const emoji = fitText("by " + "😀".repeat(50), 260, measure);
    assert.equal(emoji, "by " + "😀".repeat(6) + "…");
    assert.equal(fitText("anything", 10, measure), "");
});

test("the share picture draws its credit cut to fit, from makeShareImage's by", () => {
    const src = read("../js/share.js");
    assert.match(src, /export function drawShareFrame\(ctx, str, credit = "pixie\.skapi\.com"\)/);
    assert.match(src, /ctx\.fillText\(fitText\(credit, CREDIT_WIDTH, \(t\) => ctx\.measureText\(t\)\.width\), S \/ 2, S - 44\)/);
    assert.match(src, /export async function makeShareImage\(str, \{ by = "" \} = \{\}\)/);
    assert.match(src, /drawShareFrame\(canvas\.getContext\("2d"\), str, shareCredit\(by\)\)/);
});

/* ---------------------------------------------------------------- the post card */

test("posts have no download button or menu, and nothing refers to them", () => {
    for (const gone of ["download-menu", "closeDownloadMenus", "data-format", 'class="icon-btn download"', "family-row"]) {
        assert.equal(source.includes(gone), false, "js/app.js still has " + gone);
        assert.equal(css.includes(gone), false, "app.css still has " + gone);
    }
});

test("Frames is in the actions row, right before Remix, hidden until it applies", () => {
    const markup = /article\.innerHTML = `([\s\S]*?)`;/.exec(source)[1];
    const actions = /<div class="actions">([\s\S]*?)<\/div>/.exec(markup)[1];
    const buttons = [...actions.matchAll(/class="(?:btn small|icon-btn) ([\w-]+)[^"]*"([^>]*)>/g)].map((m) => [m[1], m[2].includes(" hidden")]);
    assert.deepEqual(buttons.map((b) => b[0]), ["like", "comment-jump", "frames-edit", "remix", "share"]);
    assert.deepEqual(buttons.find((b) => b[0] === "frames-edit"), ["frames-edit", true]);
    const probe = cut("probeFamily");
    assert.match(probe, /edit\.hidden = false/);
    assert.match(probe, /classList\.add\("with-frames"\)/);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log("ok   " + name);
    } catch (err) {
        failed++;
        console.log("FAIL " + name + "\n     " + (err.stack || err).toString().split("\n").slice(0, 4).join("\n     "));
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
