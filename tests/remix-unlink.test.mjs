/*
    A simulation test of the remix hub code in js/app.js: unlinking a remix from its family, the fallback to
    deleting it, hubs posted with can_modify_referencing_records, and how membership of a family is decided.

    js/app.js is a browser module that touches the page as soon as it loads, so it can't be imported here.
    Instead the functions under test are cut out of its source as they are and run in a sandbox where skapi,
    confirm, toast and the rest are fakes that record what they were asked. Nothing reaches a server.

    Run: node tests/remix-unlink.test.mjs   (or npm test)
*/
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

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

const FUNCTIONS = ["isUnlinked", "familyRootOf", "inFamily", "ensureHub", "removeFrame", "unlinkRemix", "loadFamily"];
const PIXELS = "d".repeat(256);

// Objects made inside the sandbox have its own prototypes: copied out, they compare with deepEqual.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function sandbox({ confirms = [], postRecord, deleteRecords, hub = null, family = [], referencing = [] } = {}) {
    const calls = { post: [], del: [], toast: [], confirm: [], reload: [], warn: [] };
    const ctx = {
        console: { warn: (...a) => calls.warn.push(a), log() {}, error() {} },
        me: { user_id: "owner" },
        HUB_TABLE: { name: "remix_hubs", access_group: "authorized" },
        PIXIE_TABLES: ["pixies", "remixes"],
        hubCache: {},
        framesEdit: null,
        isValid: (s) => typeof s === "string" && s.length === 256,
        postTime: (r) => r.uploaded || 0,
        skapi: {
            postRecord: async (data, config) => {
                calls.post.push({ data: plain(data), config: plain(config) });
                return postRecord ? postRecord(data, config, calls.post.length) : { record_id: "new", data, source: config.source };
            },
            deleteRecords: async (q) => {
                calls.del.push(plain(q));
                if (deleteRecords) return deleteRecords(q);
                return "ok";
            },
            getRecords: async () => ({ list: [] }),
        },
        getHub: async () => hub,
        getUserInfo: async (id) => ({ user_id: id, name: id }),
        authorLabel: (u) => u?.name || "someone",
        confirm: (msg) => {
            calls.confirm.push(msg);
            return confirms.length ? confirms.shift() : true;
        },
        toast: (msg) => calls.toast.push(msg),
        alert: (msg) => calls.toast.push("ALERT " + msg),
        renderFramesEditor: () => {},
        reloadFamily: (rootId) => calls.reload.push(rootId),
        document: { getElementById: () => null },
        familyMembers: async () => family,
        hubRemixes: async () => referencing,
        resetFrames: () => {},
        setupFrames: (article, ownId, frames) => (calls.frames = plain(frames.map((f) => f.record_id))),
        Promise,
        Date,
        Object,
        String,
        Array,
        Map,
        Infinity,
    };
    vm.createContext(ctx);
    vm.runInContext(FUNCTIONS.map(cut).join("\n\n") + "\nthis.fns = { " + FUNCTIONS.join(", ") + " };", ctx);
    ctx.fns.calls = calls;
    ctx.fns.ctx = ctx;
    return ctx.fns;
}

const hubOn = { record_id: "hub1", user_id: "owner", data: { root: "root1", order: [] }, source: { can_modify_referencing_records: true, can_remove_referencing_records: true } };
const hubOld = { record_id: "hub1", user_id: "owner", data: { root: "root1", order: [] }, source: { can_remove_referencing_records: true } };
const theirRemix = () => ({
    record_id: "rx1",
    user_id: "ann",
    reference: "hub1",
    index: { name: "remix_root", value: "root1" },
    table: { name: "remixes", access_group: "authorized" },
    data: { pixels: PIXELS, description: "hi", remix_of: { record_id: "root1", user_id: "owner", name: "o" }, remix_root: "root1", remix_hub: "hub1" },
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("ensureHub posts a new hub with can_modify_referencing_records next to the existing settings", async () => {
    const t = sandbox();
    await t.ensureHub({ record_id: "root1", user_id: "owner", table: { name: "pixies", access_group: "authorized" } });
    assert.equal(t.calls.post.length, 1);
    const { config, data } = t.calls.post[0];
    assert.deepEqual(data, { root: "root1", order: [] });
    assert.deepEqual(config.index, { name: "root", value: "root1" });
    assert.equal(config.source.can_modify_referencing_records, true);
    assert.equal(config.source.can_remove_referencing_records, true);
    assert.deepEqual(config.source.referencing_index_restrictions, [{ name: "remix_root", value: "root1", condition: "=" }]);
});

test("ensureHub makes the hub without the setting when it is refused as a parameter", async () => {
    const t = sandbox({
        postRecord: (data, config, n) => {
            if (n === 1) throw Object.assign(new Error("bad source"), { code: "INVALID_PARAMETER" });
            return { record_id: "hubX", source: config.source };
        },
    });
    const hub = await t.ensureHub({ record_id: "root1", user_id: "owner" });
    assert.equal(hub.record_id, "hubX");
    assert.equal(t.calls.post.length, 2);
    assert.equal("can_modify_referencing_records" in t.calls.post[1].config.source, false);
    assert.equal(t.calls.post[1].config.source.can_remove_referencing_records, true);
});

test("ensureHub does not retry other errors, and makes no hub for someone else's or a private pixie", async () => {
    const t = sandbox({ postRecord: () => { throw Object.assign(new Error("offline"), { code: "NETWORK" }); } });
    await assert.rejects(t.ensureHub({ record_id: "root1", user_id: "owner" }), /offline/);
    assert.equal(t.calls.post.length, 1);
    const u = sandbox();
    assert.equal(await u.ensureHub({ record_id: "root1", user_id: "ann" }), null);
    assert.equal(await u.ensureHub({ record_id: "root1", user_id: "owner", table: { access_group: "private" } }), null);
    assert.equal(u.calls.post.length, 0);
});

test("removeFrame unlinks someone else's remix: reference and index dropped, family fields moved, nothing deleted", async () => {
    const t = sandbox();
    const f = theirRemix();
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [{ record_id: "root1" }, f] };
    await t.removeFrame(f);
    assert.equal(t.calls.del.length, 0);
    assert.equal(t.calls.post.length, 1);
    const { data, config } = t.calls.post[0];
    assert.deepEqual(config, { record_id: "rx1", reference: null, index: null });
    assert.equal("remix_root" in data, false);
    assert.equal("remix_hub" in data, false);
    assert.deepEqual(data.remix_unlinked, { root: "root1", hub: "hub1" });
    assert.equal(data.pixels, PIXELS);
    assert.equal(data.description, "hi");
    assert.deepEqual(data.remix_of, f.data.remix_of); // the credit stays
    assert.deepEqual(f.data.remix_root, "root1"); // the record on screen is not changed in place
    assert.deepEqual(plain(t.ctx.framesEdit.list.map((x) => x.record_id)), ["root1"]);
    assert.deepEqual(t.calls.reload, ["root1"]);
    assert.match(t.calls.toast[0], /unlinked/);
});

test("removeFrame falls back to deleting when the backend refuses the unlink (after asking), and says so", async () => {
    const t = sandbox({ postRecord: () => { throw Object.assign(new Error("not allowed"), { code: "INVALID_REQUEST" }); } });
    const f = theirRemix();
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [f] };
    await t.removeFrame(f);
    assert.equal(t.calls.confirm.length, 2);
    assert.match(t.calls.confirm[1], /not allowed/);
    assert.deepEqual(t.calls.del, [{ record_id: "rx1" }]);
    assert.match(t.calls.toast[0], /Couldn't unlink/);
});

test("removeFrame keeps the remix when the fallback delete is declined", async () => {
    const t = sandbox({ confirms: [true, false], postRecord: () => { throw new Error("refused"); } });
    const f = theirRemix();
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [f] };
    await t.removeFrame(f);
    assert.equal(t.calls.del.length, 0);
    assert.equal(t.calls.toast.length, 0);
    assert.equal(t.ctx.framesEdit.list.length, 1);
});

test("removeFrame deletes, as before, for a hub without the setting, and the toast says why", async () => {
    const t = sandbox();
    const f = theirRemix();
    t.ctx.framesEdit = { rootId: "root1", hub: hubOld, list: [f] };
    await t.removeFrame(f);
    assert.equal(t.calls.post.length, 0);
    assert.deepEqual(t.calls.del, [{ record_id: "rx1" }]);
    assert.match(t.calls.confirm[0], /can't unlink/);
    assert.match(t.calls.toast[0], /can't unlink/);
});

test("removeFrame deletes a remix that doesn't reference the hub (made before hubs), as before", async () => {
    const t = sandbox();
    const f = { ...theirRemix(), reference: undefined, table: { name: "pixies", access_group: "authorized" } };
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [f] };
    await t.removeFrame(f);
    assert.equal(t.calls.post.length, 0);
    assert.deepEqual(t.calls.del, [{ record_id: "rx1" }]);
});

test("removeFrame on the owner's own frame deletes it, with today's wording", async () => {
    const t = sandbox();
    const f = { ...theirRemix(), user_id: "owner" };
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [f] };
    await t.removeFrame(f);
    assert.equal(t.calls.post.length, 0);
    assert.deepEqual(t.calls.del, [{ record_id: "rx1" }]);
    assert.equal(t.calls.confirm[0], "Remove this remix by owner? It is deleted for everyone.");
    assert.equal(t.calls.toast[0], "Remix removed");
});

test("removeFrame does nothing when the unlink is not confirmed", async () => {
    const t = sandbox({ confirms: [false] });
    const f = theirRemix();
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [f] };
    await t.removeFrame(f);
    assert.equal(t.calls.post.length + t.calls.del.length + t.calls.toast.length, 0);
});

test("membership: familyRootOf and inFamily", () => {
    const t = sandbox();
    const r = theirRemix();
    const unlinked = { ...r, reference: undefined, index: undefined, data: { pixels: PIXELS, remix_of: r.data.remix_of, remix_unlinked: { root: "root1", hub: "hub1" } } };
    assert.equal(t.familyRootOf(r), "root1");
    assert.equal(t.familyRootOf(unlinked), "rx1"); // starts a family of its own
    assert.equal(t.familyRootOf({ record_id: "p", data: { remix_of: { record_id: "q" } } }), "q");
    assert.equal(t.familyRootOf({ record_id: "p", data: {} }), "p");
    assert.equal(t.inFamily(r, "root1", "hub1"), true);
    assert.equal(t.inFamily({ ...r, reference: undefined }, "root1", "hub1"), true); // by its index (older remixes)
    assert.equal(t.inFamily({ ...r, index: undefined }, "root1", "hub1"), true); // by its reference
    assert.equal(t.inFamily({ ...r, index: undefined, reference: undefined }, "root1", "hub1"), false);
    assert.equal(t.inFamily({ ...r, index: { name: "remix_root", value: "other" }, reference: "hub9" }, "root1", "hub1"), false);
    assert.equal(t.inFamily({ ...r, reference: "hub1", data: { ...r.data, remix_unlinked: {} } }, "root1", "hub1"), false); // stale cache
    assert.equal(t.inFamily({ record_id: "root1" }, "root1", "hub1"), true);
});

test("loadFamily leaves out an unlinked remix, even when a cached query still returns it", async () => {
    const r1 = theirRemix();
    const r2 = { ...theirRemix(), record_id: "rx2", uploaded: 2 };
    const gone = { ...theirRemix(), record_id: "rx3", data: { pixels: PIXELS, remix_unlinked: { root: "root1", hub: "hub1" } } };
    const root = { record_id: "root1", user_id: "owner", table: { name: "pixies", access_group: "authorized" }, data: { pixels: PIXELS } };
    const t = sandbox({ hub: hubOn, family: [r1, gone], referencing: [r2, gone] });
    const article = { _family: { p: root, rootId: "root1" }, isConnected: true, querySelector: () => ({ textContent: "" }) };
    await t.loadFamily(article);
    assert.deepEqual(t.calls.frames.sort(), ["root1", "rx1", "rx2"]);
});

test("loadFamily: an unlinked remix on screen plays only its own family, not the one it left", async () => {
    const gone = { ...theirRemix(), reference: undefined, index: undefined, data: { pixels: PIXELS, remix_of: { record_id: "root1" }, remix_unlinked: { root: "root1", hub: "hub1" } } };
    const t = sandbox({ hub: null, family: [], referencing: [] });
    const rootId = t.familyRootOf(gone);
    const article = { _family: { p: gone, rootId }, isConnected: true, querySelector: () => ({ textContent: "" }) };
    await t.loadFamily(article);
    assert.equal(t.calls.frames, undefined); // a family of one is no animation
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
