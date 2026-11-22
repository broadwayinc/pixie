/*
    nes.js: the NES (1983) palette and everything that turns 16 x 16 pixels into pictures.

    A pixie is 256 pixels, stored in its record as a 256 character string, row by row from the top left.
    Each character is one pixel: "." is transparent, any other character is an NES palette entry
    (its hardware number 0x00 - 0x3F) written with the alphabet below, so "0" is 0x00, "f" is 0x0F,
    "g" is 0x10 and "_" is 0x3F. 0x0D is the canonical black.
*/

export const SIZE = 16;
export const PIXELS = SIZE * SIZE;
export const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
export const TRANSPARENT = -1;
export const BLACK = 0x0d;

// The 2C02 palette as most emulators show it. Rows are brightness, columns hue; the 0x?E/0x?F slots are black.
const HEX = [
    "7c7c7c", "0000fc", "0000bc", "4428bc", "940084", "a80020", "a81000", "881400", "503000", "007800", "006800", "005800", "004058", "000000", "000000", "000000",
    "bcbcbc", "0078f8", "0058f8", "6844fc", "d800cc", "e40058", "f83800", "e45c10", "ac7c00", "00b800", "00a800", "00a844", "008888", "000000", "000000", "000000",
    "f8f8f8", "3cbcfc", "6888fc", "9878f8", "f878f8", "f85898", "f87858", "fca044", "f8b800", "b8f818", "58d854", "58f898", "00e8d8", "787878", "000000", "000000",
    "fcfcfc", "a4e4fc", "b8b8f8", "d8b8f8", "f8b8f8", "f8a4c0", "f0d0b0", "fce0a8", "f8d878", "d8f878", "b8f8b8", "b8f8d8", "00fcfc", "f8d8f8", "000000", "000000",
];
export const NES = HEX.map((h) => "#" + h);
const RGB = HEX.map((h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);

/*
    The colors offered in the editor: 4 rows of 14 like the hardware table, 55 colors. The slot of 0x1D
    (a duplicate black) holds TRANSPARENT instead, so the pen and the fill can paint "nothing" too.
*/
export const PICKER_ROWS = [0, 1, 2, 3].map((row) =>
    Array.from({ length: 14 }, (_, col) => row * 16 + col).map((code) => (code === 0x1d ? TRANSPARENT : code))
);

export function colorName(code) {
    if (code === TRANSPARENT) return "Transparent";
    return "NES $" + code.toString(16).toUpperCase().padStart(2, "0");
}

/* ------------------------------------------------------------------ encoding */

export function emptyPixels() {
    return new Array(PIXELS).fill(TRANSPARENT);
}

export function encode(pixels) {
    let s = "";
    for (let i = 0; i < PIXELS; i++) {
        const c = pixels[i];
        s += c === TRANSPARENT || c == null ? "." : ALPHABET[c];
    }
    return s;
}

export function decode(str) {
    const out = emptyPixels();
    if (typeof str !== "string") return out;
    for (let i = 0; i < Math.min(PIXELS, str.length); i++) {
        const v = ALPHABET.indexOf(str[i]);
        out[i] = v < 0 ? TRANSPARENT : v;
    }
    return out;
}

export function isValid(str) {
    return typeof str === "string" && str.length === PIXELS && /^[0-9a-zA-Z_.-]+$/.test(str) && /[^.]/.test(str);
}

/* ------------------------------------------------------------------ drawing */

/*
    Draw the pixels onto a canvas, `scale` device pixels per art pixel. `background` fills the
    transparent pixels (or leaves them transparent when null).
*/
export function toCanvas(pixels, scale = 1, background = null, size = SIZE) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size * scale;
    const ctx = canvas.getContext("2d");
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (let i = 0; i < size * size; i++) {
        const c = pixels[i];
        if (c === TRANSPARENT || c == null) continue;
        ctx.fillStyle = NES[c];
        ctx.fillRect((i % size) * scale, Math.floor(i / size) * scale, scale, scale);
    }
    return canvas;
}

const urlCache = new Map();

// A small PNG of the art (16 x 16 by default). The page scales it up with image-rendering: pixelated.
export function toDataURL(str, scale = 1, background = null) {
    const key = str + "|" + scale + "|" + background;
    if (!urlCache.has(key)) {
        if (urlCache.size > 400) urlCache.clear();
        urlCache.set(key, toCanvas(decode(str), scale, background).toDataURL("image/png"));
    }
    return urlCache.get(key);
}

export function toBlob(str, scale = 32, background = null) {
    return new Promise((resolve) => toCanvas(decode(str), scale, background).toBlob(resolve, "image/png"));
}

/*
    A 16 x 16 Windows icon (.ico) of the art: one 32 bit image (BGRA, rows bottom-up) with its 1 bit
    transparency mask, the classic format every system and favicon reader understands.
*/
export function toIco(str) {
    const pixels = decode(str);
    const xor = SIZE * SIZE * 4;
    const maskRow = 4; // 16 bits, padded to 32
    const and = maskRow * SIZE;
    const bmp = 40 + xor + and;
    const buf = new ArrayBuffer(6 + 16 + bmp);
    const v = new DataView(buf);
    // ICONDIR
    v.setUint16(0, 0, true);
    v.setUint16(2, 1, true); // 1 = icon
    v.setUint16(4, 1, true); // one image
    // ICONDIRENTRY
    v.setUint8(6, SIZE);
    v.setUint8(7, SIZE);
    v.setUint8(8, 0); // no color table
    v.setUint8(9, 0);
    v.setUint16(10, 1, true); // planes
    v.setUint16(12, 32, true); // bits per pixel
    v.setUint32(14, bmp, true);
    v.setUint32(18, 22, true); // where the image starts
    // BITMAPINFOHEADER (the height counts the image and its mask)
    let o = 22;
    v.setUint32(o, 40, true);
    v.setInt32(o + 4, SIZE, true);
    v.setInt32(o + 8, SIZE * 2, true);
    v.setUint16(o + 12, 1, true);
    v.setUint16(o + 14, 32, true);
    v.setUint32(o + 16, 0, true); // no compression
    v.setUint32(o + 20, xor + and, true);
    o += 40;
    const bytes = new Uint8Array(buf);
    for (let row = SIZE - 1; row >= 0; row--) {
        for (let x = 0; x < SIZE; x++) {
            const c = pixels[row * SIZE + x];
            if (c !== TRANSPARENT) {
                const [r, g, b] = RGB[c];
                bytes[o] = b;
                bytes[o + 1] = g;
                bytes[o + 2] = r;
                bytes[o + 3] = 255;
            }
            o += 4;
        }
    }
    for (let row = SIZE - 1; row >= 0; row--) {
        for (let x = 0; x < SIZE; x++) {
            if (pixels[row * SIZE + x] === TRANSPARENT) bytes[o + (x >> 3)] |= 0x80 >> (x & 7);
        }
        o += maskRow;
    }
    return new Blob([buf], { type: "image/x-icon" });
}

/* ------------------------------------------------------------------ importing pictures */

// The NES color closest to an RGB color ("redmean": a cheap distance that follows the eye well enough).
export function nearest(r, g, b) {
    let best = BLACK, bestD = Infinity;
    for (let code = 0; code < 64; code++) {
        if ((code & 0x0f) >= 0x0e || code === 0x1d) continue;
        const [R, G, B] = RGB[code];
        const rm = (r + R) / 2;
        const dr = r - R, dg = g - G, db = b - B;
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
        if (d < bestD) {
            bestD = d;
            best = code;
        }
    }
    return best;
}

/*
    Turn any picture (a File, Blob or image element) into 16 x 16 NES pixels: the middle square is
    taken, shrunk, and every pixel gets its nearest NES color. Mostly transparent pixels stay transparent.
*/
export async function pictureToPixels(source) {
    const img = source instanceof Blob ? await createImageBitmap(source) : source;
    const w = img.width, h = img.height;
    const side = Math.min(w, h);
    // Shrink in two steps so the 16 x 16 result averages the picture instead of sampling single pixels.
    const mid = document.createElement("canvas");
    mid.width = mid.height = 64;
    const mctx = mid.getContext("2d");
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    mctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 64, 64);
    const small = document.createElement("canvas");
    small.width = small.height = SIZE;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(mid, 0, 0, SIZE, SIZE);
    const data = sctx.getImageData(0, 0, SIZE, SIZE).data;
    const out = emptyPixels();
    for (let i = 0; i < PIXELS; i++) {
        if (data[i * 4 + 3] < 128) continue;
        out[i] = nearest(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    img.close?.();
    return out;
}

/* ------------------------------------------------------------------ avatars */

// A tiny seeded random generator, so a user's avatar is the same everywhere.
function seeded(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const BODY = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x21, 0x24, 0x25, 0x26, 0x27, 0x2a, 0x2c];
const BACK = [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3d, 0x30];
const avatarCache = new Map();

/*
    Every account gets a little 8 x 8 pixel critter made from its user id: a symmetric body in one NES
    color on a light NES background, with two eyes.
*/
export function avatarFor(id) {
    id = String(id || "?");
    if (avatarCache.has(id)) return avatarCache.get(id);
    const rnd = seeded(id);
    const body = BODY[Math.floor(rnd() * BODY.length)];
    let back = BACK[Math.floor(rnd() * BACK.length)];
    const px = new Array(64).fill(back);
    for (let r = 1; r <= 6; r++) {
        for (let c = 0; c < 4; c++) {
            const core = c >= 2 && r >= 2 && r <= 5;
            if (core || rnd() < 0.5) {
                px[r * 8 + c] = body;
                px[r * 8 + 7 - c] = body;
            }
        }
    }
    // Feet
    const foot = 1 + Math.floor(rnd() * 3);
    px[7 * 8 + foot] = body;
    px[7 * 8 + 7 - foot] = body;
    // Eyes, with a wink of white now and then.
    px[3 * 8 + 2] = px[3 * 8 + 5] = BLACK;
    px[4 * 8 + 2] = px[4 * 8 + 5] = rnd() < 0.5 ? BLACK : body;
    if (rnd() < 0.35) px[5 * 8 + 3] = px[5 * 8 + 4] = 0x30;
    const url = toCanvas(px, 1, null, 8).toDataURL("image/png");
    avatarCache.set(id, url);
    return url;
}
