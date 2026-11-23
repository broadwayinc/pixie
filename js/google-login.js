/*
    google-login.js: "Continue with Google" (login.html and signup.html).

    1. googleLogin() sends the visitor to Google's sign-in page.
    2. Google sends them back to login.html with a one-time ?code=. finishGoogleLogin() (called by login.html)
       swaps it for a Google access token with skapi.forwardRequest(): the request goes through Skapi, which
       puts the client secret registered as the Secret Key "googlelogin" in place of $CLIENT_SECRET, so the
       secret never reaches the browser.
    3. skapi.openIdLogin({ id: "googleoid", token }) signs the user in with the project's OpenID logger
       "googleoid" (which reads the Google profile), creating the account the first time.
    pixie keeps only the email address and the name. Without a Google name, the name falls back to the email
    address's part before "@": names are public on pixie, email addresses are not.
    A random state value, kept in sessionStorage, makes sure the answer belongs to a sign-in started here.
*/
const GOOGLE_CLIENT_ID = "419795945836-01eovol4skihm9n5sajeg8iec7f2jbtm.apps.googleusercontent.com";
const GOOGLE_LOGGER_ID = "googleoid";
const GOOGLE_SECRET_NAME = "googlelogin";
// Google sends every sign-in back here. It must be listed under "Authorized redirect URIs" in Google Cloud.
const GOOGLE_REDIRECT_URI = (() => {
    const u = new URL("login.html", location.href);
    return u.origin + u.pathname;
})();

function googleLogin(to = "index.html") {
    const state = crypto.randomUUID();
    try {
        sessionStorage.setItem("pixie:google-state", state);
        sessionStorage.setItem("pixie:google-to", to);
    } catch (err) { /* storage blocked: the state check below will refuse the answer */ }
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("state", state);
    location.href = url.toString();
}

/*
    On login.html: if Google just sent the visitor back, finish the sign-in. Resolves to the page to open next,
    or null when this page load is not a Google answer. Throws an Error with a message for the visitor.
*/
async function finishGoogleLogin() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const error = params.get("error");
    if (!code && !error) return null;
    let expected = null, to = "index.html";
    try {
        expected = sessionStorage.getItem("pixie:google-state");
        to = sessionStorage.getItem("pixie:google-to") || to;
        sessionStorage.removeItem("pixie:google-state");
        sessionStorage.removeItem("pixie:google-to");
    } catch (err) { /* storage blocked */ }
    // The code works once; take it out of the address bar.
    history.replaceState(null, "", location.pathname);
    if (error) throw new Error(error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed: " + error);
    if (!expected || params.get("state") !== expected) throw new Error("This Google sign-in didn't start here. Please try again.");

    const token = await skapi.forwardRequest(
        {
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: "$CLIENT_SECRET",
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: "authorization_code",
        },
        {
            secretName: GOOGLE_SECRET_NAME,
            url: "https://oauth2.googleapis.com/token",
            method: "POST",
            headers: { "Content-Type": "application/json" },
        }
    );
    if (!token?.access_token) {
        console.error("Google token response", token);
        throw new Error("Google sign-in failed. Please try again.");
    }

    let result;
    try {
        result = await skapi.openIdLogin({ id: GOOGLE_LOGGER_ID, token: token.access_token });
    } catch (err) {
        if (err.code === "ACCOUNT_EXISTS" || err.code === "EXISTS") {
            throw new Error("An account with this email address already exists. Log in with your email address and password.");
        }
        throw err;
    }
    // A new account takes its name from Google, or else from its email address (the part before "@").
    const email = result?.openid?.email || result?.userProfile?.email || "";
    const name = (result?.openid?.name || email.split("@")[0] || "").trim().slice(0, 40);
    if (name && !result?.userProfile?.name) await skapi.updateProfile({ name }).catch(() => { });
    return /^[a-z-]+\.html(#.*)?$/.test(to) ? to : "index.html";
}
