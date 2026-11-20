# memoji

![memoji: every face becomes a cute 3D animal](og-image.png)

**memoji** is an Instagram-like photo app where every face turns into a cute 3D animal. Point the camera at yourself and your friends. The face closest to the camera becomes your **spirit animal** and everyone else gets a random one, live, following each head, blink and smile. Take the photo and share it; people can like it, comment on it, follow you and get notified.

It is plain HTML and JavaScript with no build step and no server of its own. Face tracking runs in the browser (WebAssembly + WebGL), and every backend feature runs on [Skapi](https://www.skapi.com): accounts, the database, file storage, followers, realtime messages and push notifications. It installs like a native app (PWA).

It grew out of the photo gallery page of the Skapi HTML template (`templates-skapi/database.html`), so it is also a full example of building a social app on Skapi.

**Source code:** [github.com/broadwayinc/memoji](https://github.com/broadwayinc/memoji) (`git clone https://github.com/broadwayinc/memoji.git`)

---

## What it does

**The memoji camera**
- Live 3D animal heads on up to 6 faces at once: bunny, bear, hamster, beaver, lion, tiger, koala, monkey, gorilla, alien and a little sheet ghost.
- The closest face wears **your spirit animal**; everyone else gets a random one (🎲 to shuffle).
- The animals copy you:
  - their eyes **follow your gaze** and **blink** when you blink;
  - they **smile** (happy ^ ^ eyes), **laugh**, look **sad**, **angry** or **surprised**;
  - they wink, kiss and puff their cheeks;
  - their ears wobble when you move.
- The animal **replaces your whole head**, hair included, and its eyes sit right where yours are.
- The memoji **match your lighting**: brightness, colour and which side the light comes from.
- **Mirror** view for selfies (toggle), front/back camera, and photos from your gallery. Group photos work too, and small faces in the back are found.
- **Your own 3D models**: upload a `.glb`, `.gltf` or `.vrm` (VRoid avatars included) and wear it instead.

**The social app**
- A feed of posts: **Recent**, **Most liked**, **Most commented**, **Following**, **My posts**, **Private**, and posts by tag or by person.
- **Post** a photo with a caption and tags, publicly or **privately** (only you can see it).
- **Like** (double-tap the photo), **comment**, **follow** people.
- **Activity**: likes, comments and new followers arrive live while the app is open, and as **push notifications** when it isn't. You also get a push when someone you follow posts.
- Accounts: sign up with email confirmation, log in, **change your name**, reset a forgotten password, recover a removed account, or just **try it as a guest**.

**The app**
- Installs on Android, iPhone/iPad (iOS 16.4+) and desktop.
- Starts fast and opens offline.
- Has home-screen shortcuts (*Take a memoji*, *Activity*, *Following*), and can receive photos **shared from other apps**.
- Shows an unread badge on the app icon.

---

## Quick start

You need a static web server. The camera and push notifications need **HTTPS**, or `localhost`.

```sh
npm install
npm run dev          # serves the folder on http://localhost:4000
```

Open `http://localhost:4000/index.html`, tap **Try it as a guest**, then the camera button.

The app runs on the Skapi project set in `service.js` (`DEFAULT_PROJECT_ID`). To use your own project, create one at [skapi.com](https://www.skapi.com), then either change `DEFAULT_PROJECT_ID` or open any page with `?pid=<your project id>`. Nothing has to be set up in the project first: tables, indexes and tags are created by the first records.

To use it on a phone, host the folder on HTTPS, for example with Skapi's website hosting. To receive push notifications on iPhone, add memoji to the Home Screen and open it from there.

---

## How it works

```
 camera / photo ──► MediaPipe Face Landmarker ──► faces: 478 landmarks, 52 blendshapes, 4×4 head pose
                         (WebAssembly + WebGL)                │
                                                              ▼
                     heads-sdf.js ─► heads-worker.js ──► animals.js rigs ──► three.js (WebGL) render
                    (sculpted heads)   (meshing)       (eyes, brows, mouth,     │
                                                        ears, expressions)      ▼
                                                                    composite photo (JPEG)
                                                                                │
                                                                                ▼
 app.js ──────────────── Skapi: accounts · database + files · followers · realtime · push
 sw.js  ──────────────── installable app: offline cache · share target · push notifications
```

### Face tracking

`js/memoji-engine.js` runs [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js) in the browser. It uses the GPU delegate over WebGL, and falls back to WebAssembly on the CPU. For every face it gets landmarks, blendshapes (`eyeBlinkLeft`, `jawOpen`, `mouthSmileLeft`…) and a head pose matrix.

three.js renders an animal under each pose with MediaPipe's own camera projection (vertical field of view 63°), so the head lands exactly on the face. On top of that:

- **Size and place.** The head is sized to your face: its eyes sit at the middle of the head and in front of yours, and its chin ends at your chin. The animal's eyes are a few centimetres closer to the camera than yours, so each frame the head slides along the camera ray until its eyes line up with your irises.
- **Chin rule.** The animal's chin never shows below your chin. Each frame the underside of the head is checked on screen against your chin, along the head's own up direction, and the head is lifted if needed. This holds when you tilt your head or open your mouth.
- **Gaze and blinks.** Gaze is read from where each iris sits between the eye corners. Blinks are read from how open each eye is, against your own open eye. Both are more reliable than the raw blendshapes.
- **Expressions.** `readExpression()` (`js/animals.js`) turns the raw blendshapes into clean smile, sad, angry, surprised and pucker signals. A big smile also lowers the brows, and that is not anger. A slow per-person baseline makes a resting face read as neutral.
- **Closest face.** The biggest face gets the spirit animal. It keeps it until another face is clearly bigger, so it doesn't flicker between two people.
- **Lighting.** The frame's brightness and colour set the ambient light and exposure. The shading on your face (left against right cheek, forehead against chin) sets the direction of the key light. A blurred copy of the frame is what the glossy eyes reflect.
- **Smoothing.** Adaptive smoothing keeps the head steady when still and quick when moving. For still photos, the picture is also searched in tiles so small faces are found.
- **Capture.** The photo is exactly what the viewfinder shows (mirrored for selfies), with the 3D heads drawn over it.

### The animals

The heads are sculpted procedurally in the style of soft vinyl / clay toy icons, with simple pastel colour blocks. The detail comes from the shape, not from textures or millions of polygons.

- `js/heads-sdf.js` describes each head as a few soft shapes blended together like clay (signed distance fields):
  - a bean-shaped head with full cheeks;
  - a muzzle that bulges out;
  - cheek pouches or tufts;
  - a scalloped mane;
  - a brow ridge and crest;
  - the monkey's heart-shaped face mask;
  - cupped ears with their insides modelled.

  The colours (muzzle, inner ears, stripes, blush) follow the sculpt.
- `js/heads-worker.js` turns each head into a smooth mesh (surface nets, about 40k triangles) in a Web Worker, so the camera never stutters.
- `js/animals.js` adds the moving parts:
  - glossy bead eyes with lids, which blink, slant and close into happy arcs;
  - brows that appear only with an expression;
  - a mouth that smiles, frowns and opens, with a tongue and teeth;
  - springy ears.

### Your own 3D models

Upload a `.glb`, `.gltf` (embedded) or `.vrm`, up to 40 MB; Draco, Meshopt and KTX2 compression are supported.

- A **head** model is centred and sized to your head.
- A **full avatar** (anything with neck and head bones, like every VRM / VRoid model) is cut at the neck, so only its head and hair show.
- Faces follow you through any of these:
  - VRM expression presets (happy, angry, sad, surprised, blink, aa…);
  - ARKit-named morph targets (all 52);
  - VRoid names (`Fcl_EYE_Close_L`…);
  - VRChat visemes.
- Eye bones follow your gaze.
- Fit sliders in the camera fine-tune the fit, and it's saved with the model.

Free models to try:

| Where | What |
| --- | --- |
| [VRoid Hub](https://hub.vroid.com/en/models) | Anime avatars as `.vrm` with full expressions. Download only models whose author allows it. |
| [VRoid Studio](https://vroid.com/en/studio) | Free app to make your own VRM avatar. |
| [Sketchfab: ARKit faces](https://sketchfab.com/search?features=downloadable&q=arkit+blendshapes&type=models) | Heads with the 52 ARKit blendshapes (download as glTF / GLB). |
| [Sketchfab: animal heads](https://sketchfab.com/search?features=downloadable&q=animal+head&type=models) | Static heads; they follow your head. |
| [Quaternius](https://quaternius.com) | CC0 low-poly characters and animals (glTF). |
| [facecap.glb](https://github.com/mrdoob/three.js/raw/r170/examples/models/gltf/facecap.glb) · [VRM sample](https://github.com/pixiv/three-vrm/raw/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm) | Quick test files (both tested with memoji). |

Check each model's license before posting with it.

### The installable app (PWA)

- `manifest.webmanifest`: icons (the 3D bunny), standalone display, theme colours, shortcuts, and a **share target** that opens shared photos in the memoji camera.
- `sw.js`, the service worker:
  - caches the app shell, network-first, so online is always the newest version and offline still opens;
  - caches the versioned CDN libraries and the face model on first use, for fast starts;
  - never caches Skapi;
  - holds new versions until you tap *Update*, so the app never reloads mid-photo;
  - shows push notifications that open the right post, and sets the app icon badge.
- `offline.html` covers pages that were never opened before. The app offers to install itself (with the steps for iPhone, where Safari has no install prompt) and asks once for notification permission.

---

## Skapi features it demonstrates

Every backend feature is a Skapi call from the browser. Here is what memoji uses, how, and where to find it.

### Connection and the login gate: `service.js`

| Skapi | How memoji uses it |
| --- | --- |
| `new Skapi(projectId, { autoLogin: true, eventListener: { onLogin } })` | One `skapi` object for every page. `autoLogin` restores the session; `onLogin` sends a logged-out visitor on a protected page to the login page. |
| `skapi.getProfile()` | `userReady` resolves to the logged-in user (or `null`) before a page uses the user. |

### Accounts: `login.html`, `signup.html`, `forgot-password.html`, `reset-password.html`

| Skapi | How memoji uses it |
| --- | --- |
| `skapi.signup(event, { signup_confirmation })` | Sign up from an HTML form. A confirmation email links back to the login page. |
| `skapi.login(event)` | Log in from a form. Skapi redirects to the form's `action`, the page the user came from. |
| `skapi.anonymousLogin()` | **Try it as a guest**: a temporary account, deleted 30 minutes after the visitor leaves. |
| `skapi.resendSignupConfirmation()` | Offered when a login fails with `SIGNUP_CONFIRMATION_NEEDED`. |
| `skapi.recoverAccount(url)` | Offered when a login fails with `USER_IS_DISABLED`. |
| `skapi.forgotPassword()` / `skapi.resetPassword(event)` | A 6-digit code by email, then a new password. |
| `skapi.logout()` | Log out. Before it, the device's push subscription is removed from the account. |

### Profiles and users: `js/app.js`

| Skapi | How memoji uses it |
| --- | --- |
| `skapi.updateProfile({ name })` | **Change your name** from your profile (the pencil next to it). Posts and comments show it from then on, and the ones on screen update at once. Guests can't: Skapi doesn't let a temporary account edit its profile, so they are pointed to sign-up. |
| `skapi.updateProfile({ misc })` | Stores your spirit animal in the profile's private `misc` field, so it follows you to other devices. A guest can't edit a profile, so a guest's choice stays in the browser. |
| `skapi.getUsers({ searchFor: "user_id", value })` | Names of post authors and commenters (cached), and your follower and following counts (`subscribers`, `subscribed`). |

### Database and files: `js/app.js`

memoji keeps everything in four tables:

| Table | Access group | Holds |
| --- | --- | --- |
| `posts` | `authorized` (any logged-in user), or `private` | `data: { description, spirit, animals }`, the photo as file `pic`, tags (yours plus the spirit animal). |
| `likes` | `public` | Empty records that **reference** a post. |
| `comments` | `authorized` | `data: { comment, spirit }` with the index `comment.<post id>`. |
| `spirit_models` | `private` | Your uploaded 3D models: file `model`, `data: { name, fit }`. |

It demonstrates these features:

- **Records with files and an upload progress bar.** The JPEG from the camera is attached as the third argument of `postRecord()`:

  ```js
  await skapi.postRecord(
      { description, spirit, animals },
      {
          table: {
              name: "posts",
              access_group: isPrivate ? "private" : "authorized",
              subscription: { is_subscription_record: false, upload_to_feed: !isPrivate, notify_subscribers: !isPrivate },
          },
          source: { prevent_multiple_referencing: true }, // one like per user
          notification: { title: "Ann posted a new memoji 🐰", body: description },
          tags,
          progress: (p) => { /* p.progress % on the Share button */ },
      },
      [{ name: "pic", file }]
  );
  ```

- **Access groups.**
  - `public` for likes, so their counts are open.
  - `authorized` for posts and comments, so only logged-in users read them.
  - `private` for private posts and custom models: only their owner can read them, and their files come through a signed URL from `file.getFile("endpoint")`. A custom model's bytes are read with `getFile("blob")`.
- **References.** A like is `postRecord(null, { table: { name: "likes", access_group: "public" }, reference: postId })`. Because the post has `prevent_multiple_referencing`, each user can like it once. The post's `referenced_count` is its number of likes.
- **Reserved indexes.**
  - `$user_id` gives *My posts*, *Private*, a person's posts, and "did I like this?" (likes by me referencing a post).
  - `$referenced_count > 0` gives *Most liked*.
- **Custom indexes and `getIndexes()`.** Comments are indexed `comment.<post id>`:
  - `getIndexes({ table: "comments", index: "comment." + id })` gives the comment count;
  - `getIndexes({ table: "comments", index: "comment.", order: { by: "total_bool" } })` lists posts by number of comments, which is *Most commented*.
- **Tags.** Posts get your tags plus the spirit animal, and `getRecords({ table, tag })` gives the `#tag` views.
- **Paging.** `getRecords(query, { ascending: false, limit: 6, fetchMore })` with `endOfList` drives infinite scroll, and the comments' *Show more* button.
- **Updating and deleting.** `postRecord(data, { record_id })` saves a custom model's fit; `deleteRecords({ record_id })` deletes posts, likes (unlike) and models.

### Followers and the feed: `js/app.js`

| Skapi | How memoji uses it |
| --- | --- |
| `skapi.subscribe({ user_id, get_feed: true, get_notified: true })` | **Follow**: their posts appear in *Following*, and each new post sends you a push. |
| `skapi.unsubscribe({ user_id })` | **Unfollow**. |
| `skapi.getSubscriptions({ subscriber, subscription })` | Is this user followed already (the *Follow* / *Following* button)? |
| `skapi.getFeed({ access_group: "authorized" }, …)` | The *Following* view: posts uploaded with `upload_to_feed`. |
| `postRecord(…, { table: { subscription: { notify_subscribers: true } }, notification })` | Followers who turned notifications on get a push with your own title and text when you post. |

### Realtime: `js/app.js`

| Skapi | How memoji uses it |
| --- | --- |
| `skapi.connectRealtime(callback)` | Opens the WebSocket when the app starts. Incoming `private` messages become toasts, the Activity list and the unread badge. |
| `skapi.postRealtime(message, userId, { title, body })` | Likes, comments and follows are sent to the other user at once. If they are not connected, the third argument makes Skapi send it as a **push notification** instead. |

```js
await skapi.postRealtime(
    { app: "memoji", kind: "like", post: postId, from_name, from_spirit },
    ownerUserId,
    { title: "memoji", body: "❤️ Ann liked your memoji" }
);
```

### Push notifications: `js/app.js` and `sw.js`

| Skapi | How memoji uses it |
| --- | --- |
| `skapi.vapidPublicKey()` | The key for `pushManager.subscribe()` in the service worker registration. |
| `skapi.subscribeNotification(endpoint, keys)` | Registers the device for the logged-in user. It is called again on every launch, so a renewed subscription, or a different account on the same device, stays correct. |
| `skapi.unsubscribeNotification(endpoint, keys)` | **Turn off** in Activity, and on logout. |

The service worker shows both kinds of push. From `postRealtime()` it gets `{ title, body }`. From `notify_subscribers` it gets `{ title, body, type: "record", record_id, … }`, which it links to the post.

### Hosting

The app is static files, so it can be served by Skapi's website hosting (HTTPS, which the camera and push need) or any static host.

---

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.css` | The app: feed, camera, compose, activity and profile (light and dark design). |
| `js/app.js` | The social app on Skapi, the camera flow, custom models, notifications, install and update prompts. |
| `js/memoji-engine.js` | Camera, MediaPipe face tracking, lighting, rendering, capture, custom models, thumbnails. |
| `js/animals.js` | The animal rigs: eyes, brows, mouth, ears, expressions. |
| `js/heads-sdf.js`, `js/heads-worker.js` | The sculpted heads (pure math) and the worker that meshes them. |
| `service.js` | Creates `skapi` and the login gate; registers the service worker. |
| `login.html`, `signup.html`, `signup-success.html`, `forgot-password.html`, `reset-password.html` | Account pages. |
| `sw.js`, `manifest.webmanifest`, `icons/`, `offline.html` | The installable app. |

## Libraries

Loaded from a CDN and pinned in `index.html`:

- [skapi-js](https://www.npmjs.com/package/skapi-js) 2.4.2
- [three.js](https://threejs.org) 0.170.0
- [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) 0.10.21, with the `face_landmarker` model

Google Fonts: Fredoka and Nunito.

## Limits

- The live face detector is made for faces within about 2 m of the camera. Farther faces are found in still photos, but not always live.
- Hands or hair in front of a face aren't masked; the head is drawn over them.
- Push notifications need HTTPS. On iPhone and iPad they need iOS 16.4+ and the app added to the Home Screen.
- The Activity list is kept in the browser, per account.
- When you change the app, bump `VERSION` in `sw.js` so installed copies pick up the new files.
