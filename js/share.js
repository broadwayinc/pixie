/*
    share.js: turning a pixie into something to post on Instagram, Threads, TikTok, X...

    - A square 1080 x 1080 picture (what Instagram and Threads like best): the pixie drawn big with crisp pixels
      on pixie's graph paper, with a small "pixie.skapi.com" credit.
    - An animated pixie becomes a video of those pictures (MP4 where the browser can record it, which is what
      Instagram, Threads and TikTok take; WebM otherwise), looping for at least 6 seconds. Browsers record video
      in real time, so making one takes as long as the video plays.
    - Links to post the pixie's address on the sites that have a "share" page.
*/
import { SIZE, NES, TRANSPARENT, decode } from "./nes.js";

export const SHARE_SIZE = 1080;
const ART = 864; // 16 x 54 pixels
const ART_X = (SHARE_SIZE - ART) / 2;
const ART_Y = 84;

let fontReady = null;
function loadFont() {
    if (!fontReady) {
        fontReady = document.fonts?.load?.('26px "Press Start 2P"').catch(() => { }) || Promise.resolve();
    }
    return fontReady;
}

// Draw one frame of the share picture.
export function drawShareFrame(ctx, str) {
    const S = SHARE_SIZE;
    ctx.imageSmoothingEnabled = false;
    // Graph paper
    ctx.fillStyle = "#fce0a8";
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = "rgba(28, 16, 48, 0.07)";
    for (let k = 0; k <= S; k += 36) {
        ctx.fillRect(k, 0, 3, S);
        ctx.fillRect(0, k, S, 3);
    }
    // The frame: offset shadow, outline, paper
    ctx.fillStyle = "#1c1030";
    ctx.fillRect(ART_X - 10 + 16, ART_Y - 10 + 16, ART + 20, ART + 20);
    ctx.fillRect(ART_X - 10, ART_Y - 10, ART + 20, ART + 20);
    ctx.fillStyle = "#fcfcfc";
    ctx.fillRect(ART_X, ART_Y, ART, ART);
    // The pixels
    const px = decode(str);
    const cell = ART / SIZE;
    for (let i = 0; i < px.length; i++) {
        const c = px[i];
        if (c === TRANSPARENT) continue;
        ctx.fillStyle = NES[c];
        ctx.fillRect(ART_X + (i % SIZE) * cell, ART_Y + Math.floor(i / SIZE) * cell, cell, cell);
    }
    // Credit
    ctx.fillStyle = "#1c1030";
    ctx.font = '26px "Press Start 2P", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("pixie.skapi.com", S / 2, S - 44);
}

function shareCanvas() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SHARE_SIZE;
    return canvas;
}

// A still share picture (PNG).
export async function makeShareImage(str) {
    await loadFont();
    const canvas = shareCanvas();
    drawShareFrame(canvas.getContext("2d"), str);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function videoSupport() {
    if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
    const types = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

/*
    A video of the frames, each shown frameMs, looped to at least minMs. Resolves to { blob, ext, type }.
    onProgress(0..1) is called as it records.
*/
export async function makeShareVideo(frames, frameMs, { minMs = 6000, onProgress = () => { } } = {}) {
    const mimeType = videoSupport();
    if (!mimeType) throw new Error("This browser can't make videos. Save the GIF instead.");
    await loadFont();
    const canvas = shareCanvas();
    const ctx = canvas.getContext("2d");
    const loops = Math.max(1, Math.ceil(minMs / (frames.length * frameMs)));
    const total = loops * frames.length;
    let current = frames[0];
    drawShareFrame(ctx, current);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start(500);
    // Keep painting at 30 fps, so every encoder gets a steady stream of frames.
    const painter = setInterval(() => drawShareFrame(ctx, current), 1000 / 30);
    try {
        for (let i = 0; i < total; i++) {
            current = frames[i % frames.length];
            drawShareFrame(ctx, current);
            onProgress(i / total);
            await new Promise((r) => setTimeout(r, frameMs));
        }
    } finally {
        clearInterval(painter);
        recorder.stop();
        await stopped;
        stream.getTracks().forEach((t) => t.stop());
    }
    onProgress(1);
    const type = mimeType.split(";")[0];
    return { blob: new Blob(chunks, { type }), ext: type === "video/mp4" ? "mp4" : "webm", type };
}

/*
    Sites with a "share" page that takes a link. (Instagram and TikTok have none: they only take the video or
    picture itself, through the phone's share sheet or by posting a saved file from their app.)
*/
export function shareLinks(url, text) {
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(text);
    const both = encodeURIComponent(text + " " + url);
    return [
        { name: "Threads", href: `https://www.threads.net/intent/post?text=${both}` },
        { name: "X", href: `https://x.com/intent/post?text=${t}&url=${u}` },
        { name: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
        { name: "Bluesky", href: `https://bsky.app/intent/compose?text=${both}` },
        { name: "Reddit", href: `https://www.reddit.com/submit?url=${u}&title=${t}` },
        { name: "WhatsApp", href: `https://wa.me/?text=${both}` },
        { name: "Telegram", href: `https://t.me/share/url?url=${u}&text=${t}` },
        { name: "LINE", href: `https://social-plugins.line.me/lineit/share?url=${u}` },
    ];
}
