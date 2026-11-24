# Turning on unlinking for existing remix hubs

pixie's Frames editor unlinks someone else's remix (it leaves the family and stays on its maker's page) when the
family's remix hub has `source.can_modify_referencing_records`. New hubs are posted with it (`ensureHub()` in
`js/app.js`). Hubs made before that have only `can_remove_referencing_records`, so for them the Frames editor still
deletes the remix, and says so.

Skapi lets a record's uploader set `can_modify_referencing_records` only when the record is created. Turning it on
for a record that already exists is reserved for **masters**: the project owner's account and users in access group
99 (admins 90-98 can't). So the project owner turns it on for the existing hubs, once, by hand. Nothing in this repo
runs it.

## Before you start

1. The Skapi backend with `can_modify_referencing_records` is deployed. On a backend without it the update is
   refused, or the setting is not stored: check step 3 on one hub before doing the rest.
2. skapi-js **2.6.0** is published and `https://cdn.jsdelivr.net/npm/skapi-js@2.6.0/dist/skapi.js` resolves. This
   version of pixie loads it on every page: hosted before that, every page (login too) fails to load `skapi`. Deploy
   in this order: the backend, then skapi-js 2.6.0, then pixie, then this update. Use skapi-js 2.6.0 or later for the
   update as well: 2.5.0 does not know the setting and drops it from `source` without an error, so the update would
   change nothing.
3. Policy: remixers referenced these hubs while the setting was off. Turning it on lets each hub's user change the
   `data`, `tags` and `index` of the remixes in their family, or unlink them (never delete more than
   `can_remove_referencing_records` already allowed, never move or re-point them). pixie only uses it to unlink:
   the app never changes the picture, caption or tags of someone else's remix. Section 5 of the Terms of Service
   (effective 24 November 2026) covers this: the family's maker has a license to change remixes, and removing
   someone else's remix unlinks it (it leaves the family and stays its maker's post), or deletes it in older
   families that can't unlink. If pixie ever starts editing other people's remixes, update section 5 first.

## The update

For every record of the table `remix_hubs` (access group `authorized`) whose `source.can_modify_referencing_records`
is not already `true`, a master updates only that one setting:

```js
// Signed in as the project owner (or an access group 99 user of the pixie project), with skapi-js 2.6.0+.
await skapi.postRecord(undefined, {
    record_id: hub.record_id,
    source: { can_modify_referencing_records: true },
});
```

- `undefined` as the first argument keeps the hub's data (`{ root, order }`) as it is. Never pass `null`: that
  stores a JSON null and the family loses its frame order.
- Send nothing else: the hub's table, index, `can_remove_referencing_records` and `referencing_index_restrictions`
  stay as stored.
- Skapi records the master as the hub's `updated_by`. It goes away the next time the hub's maker saves the frame
  order.

A sketch of the whole pass, to run in the browser console of the app signed in as a master. Use the console for
now, not the Skapi MCP or the dashboard:

- The Skapi MCP's `updateRecords` tool does not accept `can_modify_referencing_records` in `source` yet. A change
  that adds it to the MCP's source schemas is in progress, but it works only after skapi-js 2.6.0 is published and
  the MCP is deployed with it.
- The dashboard's record editor has no control for this setting, and the dashboard still uses skapi-js 2.5.0, which
  drops it.

```js
const DRY_RUN = true; // set to false to write
let fetchMore = false;
const todo = [];
for (;;) {
    const res = await skapi.getRecords(
        { table: { name: "remix_hubs", access_group: "authorized" } },
        { limit: 100, fetchMore },
    );
    for (const hub of res.list) {
        if (hub.source?.can_modify_referencing_records) continue;
        // Any signed-in user can post to remix_hubs, and the setting would let that record's user edit or unlink
        // every record referencing it. Turn it on only for a hub getHub() would accept: indexed by its own root,
        // and posted by the maker of that pixie.
        const root = hub.data?.root;
        if (!root || hub.index?.name !== "root" || hub.index.value !== root) {
            console.warn("skipped, not a hub:", hub.record_id, hub.user_id);
            continue;
        }
        const pixie = await skapi.getRecords({ record_id: root }).then((r) => r.list[0]).catch(() => null);
        if (!pixie || !["pixies", "remixes"].includes(pixie.table?.name) || pixie.user_id !== hub.user_id) {
            console.warn("skipped, not its pixie's maker's hub:", hub.record_id, hub.user_id, root);
            continue;
        }
        todo.push(hub);
    }
    if (res.endOfList || !res.list.length) break;
    fetchMore = true;
}
console.log(todo.length, "hubs without the setting");
if (!DRY_RUN) {
    for (const hub of todo) {
        await skapi.postRecord(undefined, { record_id: hub.record_id, source: { can_modify_referencing_records: true } })
            .then(() => console.log("on:", hub.record_id))
            .catch((err) => console.warn("refused:", hub.record_id, err.message));
    }
}
```

## Check

1. Read one updated hub again: `source.can_modify_referencing_records` is `true`, and `data.order`, `index`
   (`root = <pixie id>`), `can_remove_referencing_records` and `referencing_index_restrictions` are unchanged.
2. As that pixie's maker (not a master), open **Frames** and remove someone else's remix: the toast says
   "Remix unlinked", the remix no longer plays in the family, and it still opens on its own (`#post=<id>`) and on its
   maker's page.
3. The app caches hubs for a few seconds only; reloading the page is enough to see the change.

## Turning it off

The hub's maker (or a master) can turn it off at any time with
`source: { can_modify_referencing_records: false }`; only a master can turn it on again. With it off, the Frames
editor deletes remixes as before.
