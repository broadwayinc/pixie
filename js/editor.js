/*
    editor.js: the 16 x 16 pixel editor.

    new PixelEditor(canvas, { onChange }) draws on a <canvas> with the mouse, a pen or a finger:
    - tools: "pen", "eraser", "fill" (flood fill) and "picker" (pick a color from the art)
    - mirror: everything drawn on one half is drawn on the other half too
    - undo / redo (100 steps), a grid you can hide, and a highlight on the pixel under the pointer
    The art is an array of 256 NES palette numbers (TRANSPARENT for empty pixels), see nes.js.
*/
import { SIZE, PIXELS, NES, TRANSPARENT, BLACK, emptyPixels, encode, decode } from "./nes.js";

const MAX_UNDO = 100;

export class PixelEditor {
    constructor(canvas, { onChange = () => { }, onPick = () => { } } = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.onChange = onChange;
        this.onPick = onPick;
        this.pixels = emptyPixels();
        this.color = BLACK;
        this.tool = "pen";
        this.mirror = false;
        this.grid = true;
        this.undoStack = [];
        this.redoStack = [];
        this.hover = -1;
        this.drawing = false;
        this.last = -1;
        this.pointerId = null;

        canvas.addEventListener("pointerdown", (e) => this.down(e));
        canvas.addEventListener("pointermove", (e) => this.move(e));
        canvas.addEventListener("pointerup", (e) => this.up(e));
        canvas.addEventListener("pointercancel", (e) => this.up(e));
        canvas.addEventListener("pointerleave", () => {
            this.hover = -1;
            this.render();
        });
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        new ResizeObserver(() => this.resize()).observe(canvas);
        this.resize();
    }

    /* ---------------------------------------------------------- state */

    get value() {
        return encode(this.pixels);
    }

    set value(str) {
        this.pixels = decode(str);
        this.render();
    }

    load(str, { keepHistory = false } = {}) {
        if (keepHistory) this.snapshot();
        else {
            this.undoStack = [];
            this.redoStack = [];
        }
        this.value = str;
        this.changed();
    }

    setPixels(pixels) {
        this.snapshot();
        this.pixels = pixels.slice(0, PIXELS);
        this.render();
        this.changed();
    }

    isEmpty() {
        return this.pixels.every((c) => c === TRANSPARENT);
    }

    snapshot() {
        this.undoStack.push(encode(this.pixels));
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
        this.redoStack = [];
    }

    undo() {
        if (!this.undoStack.length) return false;
        this.redoStack.push(encode(this.pixels));
        this.pixels = decode(this.undoStack.pop());
        this.render();
        this.changed();
        return true;
    }

    redo() {
        if (!this.redoStack.length) return false;
        this.undoStack.push(encode(this.pixels));
        this.pixels = decode(this.redoStack.pop());
        this.render();
        this.changed();
        return true;
    }

    clear() {
        if (this.isEmpty()) return;
        this.snapshot();
        this.pixels = emptyPixels();
        this.render();
        this.changed();
    }

    // Move the whole picture one pixel; what falls off one side comes back on the other.
    shift(dx, dy) {
        this.snapshot();
        const out = emptyPixels();
        for (let i = 0; i < PIXELS; i++) {
            const x = (i % SIZE + dx + SIZE) % SIZE;
            const y = (Math.floor(i / SIZE) + dy + SIZE) % SIZE;
            out[y * SIZE + x] = this.pixels[i];
        }
        this.pixels = out;
        this.render();
        this.changed();
    }

    flip() {
        this.snapshot();
        const out = emptyPixels();
        for (let i = 0; i < PIXELS; i++) out[Math.floor(i / SIZE) * SIZE + (SIZE - 1 - (i % SIZE))] = this.pixels[i];
        this.pixels = out;
        this.render();
        this.changed();
    }

    changed() {
        this.onChange(this);
    }

    /* ---------------------------------------------------------- pointer */

    cellAt(e) {
        const r = this.canvas.getBoundingClientRect();
        const x = Math.floor(((e.clientX - r.left) / r.width) * SIZE);
        const y = Math.floor(((e.clientY - r.top) / r.height) * SIZE);
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return -1;
        return y * SIZE + x;
    }

    down(e) {
        if (e.button !== undefined && e.button > 0 && e.pointerType === "mouse" && e.button !== 2) return;
        const cell = this.cellAt(e);
        if (cell < 0) return;
        e.preventDefault();
        // Right click erases, like most pixel editors.
        const tool = e.button === 2 ? "eraser" : this.tool;
        if (tool === "picker") {
            this.onPick(this.pixels[cell]); // a transparent pixel picks "transparent"
            return;
        }
        this.snapshot();
        if (tool === "fill") {
            this.fill(cell, this.color);
            if (this.mirror) this.fill(this.mirrorOf(cell), this.color);
            this.render();
            this.changed();
            return;
        }
        this.drawing = tool;
        this.pointerId = e.pointerId;
        this.canvas.setPointerCapture?.(e.pointerId);
        this.last = cell;
        this.paint(cell, tool);
        this.render();
    }

    move(e) {
        const cell = this.cellAt(e);
        if (!this.drawing) {
            if (cell !== this.hover) {
                this.hover = cell;
                this.render();
            }
            return;
        }
        if (e.pointerId !== this.pointerId || cell < 0) return;
        e.preventDefault();
        // Fast strokes skip cells: draw the line between the last cell and this one.
        for (const c of line(this.last, cell)) this.paint(c, this.drawing);
        this.last = cell;
        this.hover = e.pointerType === "mouse" ? cell : -1;
        this.render();
    }

    up(e) {
        if (!this.drawing || (e.pointerId !== undefined && e.pointerId !== this.pointerId)) return;
        this.drawing = false;
        this.pointerId = null;
        if (e.pointerType !== "mouse") this.hover = -1;
        this.render();
        this.changed();
    }

    mirrorOf(cell) {
        return Math.floor(cell / SIZE) * SIZE + (SIZE - 1 - (cell % SIZE));
    }

    paint(cell, tool) {
        const value = tool === "eraser" ? TRANSPARENT : this.color;
        this.pixels[cell] = value;
        if (this.mirror) this.pixels[this.mirrorOf(cell)] = value;
    }

    fill(start, value) {
        const target = this.pixels[start];
        if (target === value) return;
        const stack = [start];
        while (stack.length) {
            const i = stack.pop();
            if (this.pixels[i] !== target) continue;
            this.pixels[i] = value;
            const x = i % SIZE, y = Math.floor(i / SIZE);
            if (x > 0) stack.push(i - 1);
            if (x < SIZE - 1) stack.push(i + 1);
            if (y > 0) stack.push(i - SIZE);
            if (y < SIZE - 1) stack.push(i + SIZE);
        }
    }

    /* ---------------------------------------------------------- drawing */

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width) return;
        const dpr = window.devicePixelRatio || 1;
        this.cell = Math.max(4, Math.ceil((rect.width * dpr) / SIZE));
        const px = this.cell * SIZE;
        if (this.canvas.width !== px) {
            this.canvas.width = this.canvas.height = px;
        }
        this.render();
    }

    render() {
        const { ctx, cell } = this;
        if (!cell) return;
        const full = cell * SIZE;
        // Transparent pixels show a soft checkerboard, as in every paint program.
        for (let i = 0; i < PIXELS; i++) {
            const x = (i % SIZE) * cell, y = Math.floor(i / SIZE) * cell;
            const c = this.pixels[i];
            if (c === TRANSPARENT) {
                const h = cell / 2;
                ctx.fillStyle = "#fcfcfc";
                ctx.fillRect(x, y, cell, cell);
                ctx.fillStyle = "#e8e4f0";
                ctx.fillRect(x, y, h, h);
                ctx.fillRect(x + h, y + h, cell - h, cell - h);
            } else {
                ctx.fillStyle = NES[c];
                ctx.fillRect(x, y, cell, cell);
            }
        }
        if (this.grid) {
            ctx.fillStyle = "rgba(20, 16, 40, 0.16)";
            for (let k = 1; k < SIZE; k++) {
                const w = k % 4 === 0 ? 2 : 1;
                ctx.fillRect(k * cell - Math.floor(w / 2), 0, w, full);
                ctx.fillRect(0, k * cell - Math.floor(w / 2), full, w);
            }
        }
        if (this.mirror) {
            ctx.fillStyle = "rgba(228, 0, 88, 0.55)";
            ctx.fillRect(full / 2 - 1, 0, 2, full);
        }
        if (this.hover >= 0 && !this.drawing) {
            const marks = [this.hover];
            if (this.mirror && this.tool !== "picker") marks.push(this.mirrorOf(this.hover));
            for (const m of marks) {
                const x = (m % SIZE) * cell, y = Math.floor(m / SIZE) * cell;
                const lw = Math.max(2, Math.round(cell / 10));
                ctx.strokeStyle = "#000";
                ctx.lineWidth = lw;
                ctx.strokeRect(x + lw / 2, y + lw / 2, cell - lw, cell - lw);
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = Math.max(1, lw / 2);
                ctx.strokeRect(x + lw * 1.25, y + lw * 1.25, cell - lw * 2.5, cell - lw * 2.5);
            }
        }
    }
}

// The cells on the straight line between two cells (Bresenham).
function line(a, b) {
    let x0 = a % SIZE, y0 = Math.floor(a / SIZE);
    const x1 = b % SIZE, y1 = Math.floor(b / SIZE);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    const out = [];
    for (; ;) {
        out.push(y0 * SIZE + x0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
    return out;
}
