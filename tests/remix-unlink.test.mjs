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

const FUNCTIONS = [
    "isUnlinked", "familyRootOf", "inFamily", "ensureHub", "makeHub", "removeFrame", "unlinkRemix", "loadFamily", "hiddenInFeed",
    "fetchAll", "remixOriginalData", "promotionConfig", "toPromote", "promoteRemix", "promoteUnlinkedRemixes",
];
const PIXELS = "d".repeat(256);

// Objects made inside the sandbox have its own prototypes: copied out, they compare with deepEqual.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function sandbox({ confirms = [], postRecord, deleteRecords, getRecords, getHub, hub = null, family = [], referencing = [], hash = "" } = {}) {
    const calls = { post: [], del: [], toast: [], confirm: [], reload: [], warn: [], get: [], fetch: 0 };
    const ctx = {
        console: { warn: (...a) => calls.warn.push(a), log() {}, error() {} },
        me: { user_id: "owner" },
        HUB_TABLE: { name: "remix_hubs", access_group: "authorized" },
        MAX_FAMILY: 1000,
        PIXIE_TABLES: ["pixies", "remixes"],
        hubCache: {},
        hubMaking: {},
        UNLINKED_INDEX: "remix_unlinked",
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
            getRecords: async (q, opts) => {
                calls.get.push({ q: plain(q), opts: plain(opts) });
                return getRecords ? getRecords(q, opts, calls.get.length) : { list: [], endOfList: true };
            },
        },
        POSTS_TABLE: "pixies",
        REMIX_TABLE: "remixes",
        queryCache: { "family:x": 1 },
        promotedFor: null,
        location: { hash: "#" + hash },
        encodeURIComponent,
        initialFetch: () => calls.fetch++,
        getHub: getHub || (async () => hub),
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

test("ensureHub posts one hub when several calls for a pixie overlap", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const t = sandbox({ postRecord: async (data, config) => (await gate, { record_id: "hubA", data, source: config.source }) });
    const root = { record_id: "root1", user_id: "owner", table: { name: "pixies", access_group: "authorized" } };
    const first = t.ensureHub(root);
    await new Promise((r) => setTimeout(r, 0)); // the first call is now posting
    const second = t.ensureHub(root);
    release();
    assert.equal((await first).record_id, "hubA");
    assert.equal((await second).record_id, "hubA");
    assert.equal(t.calls.post.length, 1);
    assert.deepEqual(plain(Object.keys(t.ctx.hubMaking)), []);
});

test("removeFrame unlinks someone else's remix: reference dropped, marked with its maker's index, family fields moved, nothing deleted", async () => {
    const t = sandbox();
    const f = theirRemix();
    t.ctx.framesEdit = { rootId: "root1", hub: hubOn, list: [{ record_id: "root1" }, f] };
    await t.removeFrame(f);
    assert.equal(t.calls.del.length, 0);
    assert.equal(t.calls.post.length, 1);
    const { data, config } = t.calls.post[0];
    assert.deepEqual(config, { record_id: "rx1", reference: null, index: { name: "remix_unlinked", value: "ann" } });
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
    // The hub's owner is told it becomes a regular pixie only when its maker opens pixie again.
    assert.match(t.calls.confirm[0], /next time they open pixie/);
    assert.match(t.calls.toast[0], /next time they open pixie/);
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

/* ---------------------------------------------------------------- unlinked remixes become regular pixies */

const unlinkedRemix = (id = "rx1", extra = {}) => ({
    record_id: id,
    user_id: "owner",
    table: { name: "remixes", access_group: "authorized" },
    index: { name: "remix_unlinked", value: "owner" },
    tags: ["cat"],
    referenced_count: 3,
    updated_by: "hubowner",
    data: { pixels: PIXELS, description: "hi", remix_of: { record_id: "root1", user_id: "hubowner", name: "h" }, remix_unlinked: { root: "root1", hub: "hub1" } },
    ...extra,
});

test("remixOriginalData drops the family fields and the credit, and keeps the art and the unlinked mark", () => {
    const t = sandbox();
    const data = { pixels: PIXELS, description: "hi", extra: 1, remix_of: { record_id: "a" }, remix_root: "a", remix_hub: "h", remix_unlinked: { root: "a" } };
    assert.deepEqual(plain(t.remixOriginalData(data)), { pixels: PIXELS, description: "hi", extra: 1, remix_unlinked: { root: "a" } });
    assert.equal(data.remix_of.record_id, "a"); // the record on screen is not changed in place
    assert.deepEqual(plain(t.remixOriginalData(undefined)), {});
});

test("promotionConfig moves the record in place into pixies with an original's settings, and keeps the index", () => {
    const t = sandbox();
    assert.deepEqual(plain(t.promotionConfig(unlinkedRemix())), {
        record_id: "rx1",
        table: { name: "pixies", access_group: "authorized", subscription: { is_subscription_record: false, upload_to_feed: true, notify_subscribers: true } },
        source: { prevent_multiple_referencing: true },
        reference: null,
    });
});

test("promotionConfig mirrors what postPixie gives an original", () => {
    // The literal settings in postPixie() for a public original (asRemix and isPrivate false).
    const src = cut("postPixie");
    assert.match(src, /access_group: isPrivate \? "private" : "authorized"/);
    assert.match(src, /is_subscription_record: false/);
    assert.match(src, /upload_to_feed: !isPrivate && !asRemix/);
    assert.match(src, /notify_subscribers: !isPrivate && !asRemix/);
    assert.match(src, /source: \{\s*prevent_multiple_referencing: true,/);
});

test("toPromote picks only your own public unlinked remixes that still carry the mark", () => {
    const t = sandbox();
    const list = [
        unlinkedRemix("a"),
        unlinkedRemix("b", { user_id: "ann" }), // someone else's
        unlinkedRemix("c", { table: { name: "pixies", access_group: "authorized" } }), // moved, mark not dropped yet (or an older remix in "pixies")
        unlinkedRemix("c2", { table: { name: "pixies", access_group: "authorized" }, index: undefined }), // done
        { ...unlinkedRemix("d"), data: { pixels: PIXELS, remix_root: "root1" } }, // still in its family
        unlinkedRemix("e", { table: { name: "remixes", access_group: "private" } }),
        null,
    ];
    assert.deepEqual(plain(t.toPromote(list, "owner").map((r) => r.record_id)), ["a", "c"]);
});

test("hiddenInFeed: an unlinked remix is a regular pixie in every view, a linked one stays hidden in the feeds", () => {
    for (const hash of ["", "feed", "tag=cat", "user=ann"]) {
        const t = sandbox({ hash });
        assert.equal(t.hiddenInFeed(unlinkedRemix()), false, hash);
        assert.equal(t.hiddenInFeed(unlinkedRemix("x", { table: { name: "pixies", access_group: "authorized" } })), false, hash);
        assert.equal(t.hiddenInFeed({ ...theirRemix() }), true, hash);
        // An old remix in "pixies" still in its family stays hidden; one moved there as an original doesn't.
        assert.equal(t.hiddenInFeed({ ...theirRemix(), table: { name: "pixies", access_group: "authorized" } }), true, hash);
        const promoted = { record_id: "rx1", user_id: "owner", table: { name: "pixies", access_group: "authorized" }, data: t.remixOriginalData(unlinkedRemix().data) };
        assert.equal(t.hiddenInFeed(promoted), false, hash);
        assert.equal(t.familyRootOf(promoted), "rx1");
    }
    assert.equal(sandbox({ hash: "myremixes" }).hiddenInFeed(theirRemix()), false);
});

// A fake postRecord that answers like Skapi: the record with the table it was given (or the one it had).
const echo = (tables = {}) => (data, config) => {
    if (config.table?.name) tables[config.record_id] = config.table;
    return { record_id: config.record_id || "hub-" + data?.root, data, source: config.source, table: tables[config.record_id] || config.table };
};
const marked = (byTable) => (q, opts) => {
    if (q.table?.name === "remix_hubs") return { list: [], endOfList: true };
    const pages = byTable[q.table?.name] || [[]];
    const n = opts.fetchMore ? 1 : 0;
    return { list: pages[n] || [], endOfList: n >= pages.length - 1 };
};

test("promoteUnlinkedRemixes reads only your marked records, and moves each in place, then drops the mark", async () => {
    const t = sandbox({
        getRecords: marked({ remixes: [[unlinkedRemix("rx1"), { ...theirRemix(), user_id: "owner", record_id: "rx2" }], [unlinkedRemix("rx3")]] }),
        postRecord: echo(),
    });
    const moved = await t.promoteUnlinkedRemixes();
    assert.equal(moved, 2);
    const reads = t.calls.get.filter((g) => g.q.table?.name !== "remix_hubs");
    for (const name of ["remixes", "pixies"]) {
        assert.ok(reads.some((g) => JSON.stringify(g.q) === JSON.stringify({ table: { name, access_group: "authorized" }, index: { name: "remix_unlinked", value: "owner" } })), name);
    }
    assert.ok(reads.every((g) => g.q.index?.name === "remix_unlinked")); // never the whole of your remixes
    const writes = t.calls.post.filter((c) => c.config.record_id);
    assert.deepEqual(writes.map((c) => c.config.record_id), ["rx1", "rx1", "rx3", "rx3"]);
    for (const [move, unmark] of [[writes[0], writes[1]], [writes[2], writes[3]]]) {
        assert.equal(move.config.table.name, "pixies");
        assert.equal("index" in move.config, false); // the mark stays until the move is confirmed
        assert.deepEqual(move.data, { pixels: PIXELS, description: "hi", remix_unlinked: { root: "root1", hub: "hub1" } });
        assert.equal("tags" in move.config, false); // the tags stay as they are
        assert.equal(unmark.data, undefined); // the data is not touched again
        assert.deepEqual(unmark.config, { record_id: move.config.record_id, index: null });
    }
    assert.equal(t.calls.del.length, 0); // never deleted and posted again
    // Each one becomes an original with its own remix hub, made before the view is read again.
    const hubs = t.calls.post.filter((c) => c.config.table?.name === "remix_hubs");
    assert.deepEqual(hubs.map((c) => c.data.root).sort(), ["rx1", "rx3"]);
    assert.equal(t.calls.fetch, 1);
    assert.deepEqual(plain(t.ctx.queryCache), {});
    assert.deepEqual(plain(Object.keys(t.ctx.hubCache).sort()), ["rx1", "rx3"]); // the new hubs are kept
    // Once per session.
    assert.equal(await t.promoteUnlinkedRemixes(), 0);
    assert.equal(t.calls.get.filter((g) => g.q.table?.name !== "remix_hubs").length, reads.length);
});

test("promoteUnlinkedRemixes: a pixie on screen asking for the new hub meanwhile gets the same one", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let hubPosts = 0;
    const t = sandbox({
        getRecords: marked({ remixes: [[unlinkedRemix("rx1")]] }),
        getHub: async () => null, // the hub isn't found until it is made
        postRecord: async (data, config) => {
            if (config.table?.name === "remix_hubs") {
                hubPosts++;
                await gate;
            }
            return echo()(data, config);
        },
    });
    const running = t.promoteUnlinkedRemixes();
    await new Promise((r) => setTimeout(r, 0));
    const fromScreen = t.ensureHub({ record_id: "rx1", user_id: "owner", table: { name: "pixies", access_group: "authorized" } });
    release();
    assert.equal(await running, 1);
    assert.equal((await fromScreen).record_id, "hub-rx1");
    assert.equal(hubPosts, 1);
});

test("promoteUnlinkedRemixes: a move that doesn't take effect keeps the record marked, to be tried again", async () => {
    const t = sandbox({
        getRecords: marked({ remixes: [[unlinkedRemix("rx1")]] }),
        // The backend saves but leaves the table as it was.
        postRecord: (data, config) => ({ record_id: config.record_id, data, table: { name: "remixes", access_group: "authorized" } }),
    });
    assert.equal(await t.promoteUnlinkedRemixes(), 0);
    assert.equal(t.calls.post.length, 1); // the mark is not dropped
    assert.equal("index" in t.calls.post[0].config, false);
    assert.ok(t.calls.warn.some((w) => String(w[0]).includes("next time")));
    assert.equal(t.calls.fetch, 0);
    // What the record is now: still unlinked, still marked, so toPromote picks it next session.
    const now = { ...unlinkedRemix("rx1"), data: t.calls.post[0].data };
    assert.deepEqual(plain(t.toPromote([now], "owner").map((r) => r.record_id)), ["rx1"]);
});

test("promoteUnlinkedRemixes: when dropping the mark fails, the record is in pixies and is finished next session", async () => {
    const t = sandbox({
        getRecords: marked({ remixes: [[unlinkedRemix("rx1")]] }),
        postRecord: (data, config) => {
            if (config.index === null) throw new Error("offline");
            return echo()(data, config);
        },
    });
    assert.equal(await t.promoteUnlinkedRemixes(), 0);
    const now = { ...unlinkedRemix("rx1"), table: { name: "pixies", access_group: "authorized" }, data: t.calls.post[0].data };
    assert.deepEqual(plain(t.toPromote([now], "owner").map((r) => r.record_id)), ["rx1"]);
    const u = sandbox({ getRecords: marked({ pixies: [[now]] }), postRecord: echo() });
    assert.equal(await u.promoteUnlinkedRemixes(), 1);
    assert.deepEqual(u.calls.post.filter((c) => c.config.record_id).map((c) => plain(c.config.index)), [undefined, null]);
});

test("promoteUnlinkedRemixes: an older remix in pixies loses its credit and gets an original's settings", async () => {
    const old = unlinkedRemix("old1", { table: { name: "pixies", access_group: "authorized" } });
    const t = sandbox({ getRecords: marked({ pixies: [[old]] }), postRecord: echo() });
    assert.equal(await t.promoteUnlinkedRemixes(), 1);
    const move = t.calls.post.find((c) => c.config.record_id === "old1");
    assert.equal("remix_of" in move.data, false);
    assert.equal(move.config.table.subscription.upload_to_feed, true);
});

test("promoteUnlinkedRemixes tolerates failures: logs, goes on with the rest, and refreshes nothing when nothing moved", async () => {
    const t = sandbox({
        getRecords: marked({ remixes: [[unlinkedRemix("rx1"), unlinkedRemix("rx2")]] }),
        postRecord: (data, config) => {
            if (config.record_id === "rx1") throw new Error("refused");
            return echo()(data, config);
        },
    });
    assert.equal(await t.promoteUnlinkedRemixes(), 1);
    assert.ok(t.calls.warn.some((w) => String(w[0]).includes("next time")));
    const u = sandbox({ getRecords: () => { throw new Error("offline"); } });
    assert.equal(await u.promoteUnlinkedRemixes(), 0);
    assert.equal(u.calls.fetch, 0);
    assert.equal(u.calls.post.length, 0);
    assert.ok(u.calls.warn.some((w) => String(w[0]).includes("next time")));
    const v = sandbox({ getRecords: marked({ remixes: [[theirRemix()]] }) });
    assert.equal(await v.promoteUnlinkedRemixes(), 0);
    assert.equal(v.calls.fetch, 0);
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
