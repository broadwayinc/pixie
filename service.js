/*
    service.js is loaded by every page of pixie.
    It creates the `skapi` object the pages use and takes care of two things every page needs:
    the project id, and sending visitors to the login page when a page needs a logged in user.
    (Same structure as service.js of the Skapi HTML template.)
*/

/*
    Project ID

    pixie runs on the Skapi project below. Opening a page with ?pid=<Project ID> uses another project
    instead; the id is then kept in sessionStorage so the other pages use it too.
*/
const DEFAULT_PROJECT_ID = "5g3TffXBwAE3eFEcbG-7Zd6TgdLUaFxseKMT1qveY";
const PROJECT_ID_FROM_URL = new URLSearchParams(location.search).get("pid");
if (PROJECT_ID_FROM_URL) {
    sessionStorage.setItem("skapi:project_id", PROJECT_ID_FROM_URL);
}
const PROJECT_ID = PROJECT_ID_FROM_URL || sessionStorage.getItem("skapi:project_id") || DEFAULT_PROJECT_ID;

/*
    pageUrl(page) returns the full address of another page of the app.
    When another project than the default is used, it is added to the address as ?pid=,
    so a page opened in a new tab still knows its project.
*/
function pageUrl(page) {
    let url = new URL(page, location.href);
    if (PROJECT_ID !== DEFAULT_PROJECT_ID) {
        url.searchParams.set("pid", PROJECT_ID);
    }
    return url.href;
}

function isAppPage(href) {
    return /^[a-z-]+\.html([?#].*)?$/.test(href || "");
}

/*
    Enter pressed while a phone keyboard is still composing a word (an IME, for Korean or Japanese for example)
    confirms the word; it must not submit the form with half of it.
*/
document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229) && event.target.matches("input, textarea")) {
        event.preventDefault();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    for (let a of document.querySelectorAll("a[href]")) {
        if (isAppPage(a.getAttribute("href"))) {
            a.href = pageUrl(a.getAttribute("href"));
        }
    }
    for (let form of document.querySelectorAll("form[action]")) {
        if (isAppPage(form.getAttribute("action"))) {
            form.action = pageUrl(form.getAttribute("action"));
        }
    }
});

/*
    The on-screen keyboard must never cover the field you are typing in.
    - Android Chrome: the viewport tag's interactive-widget=resizes-content makes the page itself shrink
      above the keyboard.
    - Everywhere (iPhone Safari included): when a text field is focused, the keyboard's height is measured
      from the visual viewport, and the field's scroll area (the page, the New pixie sheet, a panel) is
      scrolled just enough to show the field above the keyboard. While typing, <html> gets the class
      "keyboard-open" (the floating bottom bar hides) and the CSS variable --kb holds the keyboard height,
      so sheets can add room at the bottom to scroll the field up.
*/
(function keepFieldAboveKeyboard() {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]';
    const isField = (el) => !!(el && el.matches && el.matches(FIELD));
    let fullHeight = window.innerHeight; // the window's height with no keyboard
    window.addEventListener("orientationchange", () => setTimeout(() => (fullHeight = window.innerHeight), 400));

    function keyboardHeight() {
        // Keyboard over the page (iOS): the visual viewport is shorter than the layout viewport.
        const over = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
        // Page resized by the keyboard (Android with resizes-content): the window got shorter.
        const resized = Math.max(0, fullHeight - window.innerHeight);
        return Math.max(over, resized);
    }

    function scrollArea(el) {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const oy = getComputedStyle(p).overflowY;
            if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
        }
        return document.scrollingElement || document.documentElement;
    }

    function reveal() {
        const el = document.activeElement;
        if (!isField(el)) return;
        const kb = keyboardHeight();
        const open = kb > 80;
        root.style.setProperty("--kb", (open ? kb : 0) + "px");
        root.classList.toggle("keyboard-open", open);
        const r = el.getBoundingClientRect();
        const top = vv ? vv.offsetTop : 0;
        const visibleBottom = top + (vv ? vv.height : window.innerHeight) - 16; // 16px of breathing room
        const topbar = document.querySelector(".topbar");
        const visibleTop = top + (topbar && getComputedStyle(topbar).position === "sticky" && !el.closest(".sheet, .panel") ? topbar.offsetHeight + 8 : 8);
        let delta = 0;
        if (r.bottom > visibleBottom) delta = r.bottom - visibleBottom;
        else if (r.top < visibleTop) delta = r.top - visibleTop;
        if (Math.abs(delta) > 1) scrollArea(el).scrollBy({ top: delta, behavior: "smooth" });
    }

    let timers = [];
    function revealSoon() {
        timers.forEach(clearTimeout);
        // The keyboard slides in over a few hundred milliseconds; check as it arrives and once it is up.
        timers = [60, 250, 500].map((ms) => setTimeout(reveal, ms));
    }

    document.addEventListener("focusin", (e) => {
        if (isField(e.target)) revealSoon();
    });
    document.addEventListener("focusout", () => {
        setTimeout(() => {
            if (!isField(document.activeElement)) {
                root.classList.remove("keyboard-open");
                root.style.setProperty("--kb", "0px");
            }
        }, 150);
    });
    vv?.addEventListener("resize", () => {
        if (isField(document.activeElement)) revealSoon();
    });
    window.addEventListener("resize", () => {
        if (isField(document.activeElement)) revealSoon();
        else fullHeight = Math.max(fullHeight, window.innerHeight);
    });
})();

/*
    pixie is an installable app (a PWA): the service worker (sw.js) caches it for a fast, offline-able
    start and shows push notifications. It is registered from every page.
*/
const swReady = "serviceWorker" in navigator
    ? navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("Service worker not registered", err);
        return null;
    })
    : Promise.resolve(null);

/*
    Pages that need a logged in user. A visitor who opens one of them while logged out is sent to
    login.html, and login.html brings them back after they log in.
*/
const LOGIN_REQUIRED = ["index.html"];

function currentPage() {
    return location.pathname.split("/").pop() || "index.html";
}

function goToLogin() {
    let to = currentPage() + location.hash;
    location.replace(pageUrl("login.html?to=" + encodeURIComponent(to)));
}

// A page that logs the user out on purpose sets this first, so the user is not bounced while it finishes.
let leavingOnPurpose = false;

/*
    - autoLogin: a user who logged in before is logged in again automatically.
    - eventListener.onLogin: called on load with the restored profile or null, then on every login and logout.
*/
let options = {
    autoLogin: true,
    eventListener: {
        onLogin: (user) => {
            if (!user && !leavingOnPurpose && LOGIN_REQUIRED.includes(currentPage())) {
                goToLogin();
            }
        },
    },
};

let skapi;
try {
    skapi = new Skapi(PROJECT_ID, options);
} catch (err) {
    // A project id that is not valid (a typo in ?pid=) makes the constructor throw. Forget it.
    sessionStorage.removeItem("skapi:project_id");
    alert("The project id is not valid: " + err.message);
    throw err;
}

/*
    userReady resolves once the automatic login has been tried:
    to the user's profile, or to null when nobody is logged in.
*/
const userReady = skapi.getProfile().then((user) => {
    if (!user && LOGIN_REQUIRED.includes(currentPage())) {
        goToLogin();
    }
    return user;
}).catch((err) => {
    console.error(err);
    return null;
});
