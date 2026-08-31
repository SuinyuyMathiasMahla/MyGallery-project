/* ============================================================
   auth.js — shared Cognito auth helper
   Talks to Cognito's plain JSON API directly via fetch(), so no
   Amplify SDK / build step is needed for a static multi-page site.
   Docs: https://docs.aws.amazon.com/cognito/latest/developerguide/API_UserPoolIdentityProvider.html
   ============================================================ */

const AUTH_CONFIG = {
  REGION: "us-east-1",
  USER_POOL_CLIENT_ID: "79lep4t4cqtur1hg4pkbjih8ok",
};

const COGNITO_ENDPOINT = "https://cognito-idp." + AUTH_CONFIG.REGION + ".amazonaws.com/";

const STORAGE_KEYS = {
  ID_TOKEN: "gallery_id_token",
  ACCESS_TOKEN: "gallery_access_token",
  REFRESH_TOKEN: "gallery_refresh_token",
};

/* ---- low-level Cognito JSON API call ---- */
async function cognitoRequest(action, body) {
  let response;

  try {
    response = await fetch(COGNITO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService." + action,
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    console.error("Network error calling Cognito:", networkError);
    throw new Error("Could not reach the login service (network error).");
  }

  const data = await response.json().catch(function () { return {}; });

  if (!response.ok) {
    // Cognito error bodies look like: { "__type": "UsernameExistsException", "message": "..." }
    throw new Error(data.message || data.__type || "Authentication request failed.");
  }

  return data;
}

/* ---- public auth actions ---- */

async function authSignUp(email, password) {
  return cognitoRequest("SignUp", {
    ClientId: AUTH_CONFIG.USER_POOL_CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: "email", Value: email }],
  });
}

async function authConfirmSignUp(email, code) {
  return cognitoRequest("ConfirmSignUp", {
    ClientId: AUTH_CONFIG.USER_POOL_CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
  });
}

async function authResendCode(email) {
  return cognitoRequest("ResendConfirmationCode", {
    ClientId: AUTH_CONFIG.USER_POOL_CLIENT_ID,
    Username: email,
  });
}

async function authLogin(email, password) {
  const data = await cognitoRequest("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: AUTH_CONFIG.USER_POOL_CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });

  const result = data.AuthenticationResult;
  if (!result) throw new Error("Login did not return tokens.");

  storeTokens(result.IdToken, result.AccessToken, result.RefreshToken);
  return decodeIdToken(result.IdToken);
}

async function authRefresh() {
  const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
  if (!refreshToken) throw new Error("No refresh token stored.");

  const data = await cognitoRequest("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: AUTH_CONFIG.USER_POOL_CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });

  const result = data.AuthenticationResult;
  if (!result) throw new Error("Refresh did not return tokens.");

  // Refresh doesn't return a new refresh token — keep the existing one.
  storeTokens(result.IdToken, result.AccessToken, refreshToken);
  return decodeIdToken(result.IdToken);
}

function authLogout() {
  localStorage.removeItem(STORAGE_KEYS.ID_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
}

/* ---- token storage / decoding ---- */

function storeTokens(idToken, accessToken, refreshToken) {
  localStorage.setItem(STORAGE_KEYS.ID_TOKEN, idToken);
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  if (refreshToken) localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
}

function decodeIdToken(idToken) {
  try {
    const payload = idToken.split(".")[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(decoded)));
  } catch (e) {
    return null;
  }
}

// Returns the decoded claims of a still-valid stored session, or null.
function getCurrentUser() {
  const idToken = localStorage.getItem(STORAGE_KEYS.ID_TOKEN);
  if (!idToken) return null;

  const claims = decodeIdToken(idToken);
  if (!claims || !claims.exp) return null;

  const isExpired = Date.now() >= claims.exp * 1000;
  if (isExpired) return null;

  return claims;
}

function getIdToken() {
  return localStorage.getItem(STORAGE_KEYS.ID_TOKEN);
}

/* ---- guards for use at the top of a page ---- */

// Call at the top of pages that require login (index.html). Redirects
// to login.html if there's no valid session, and tries a silent
// refresh first in case only the ID token (not the refresh token) expired.
async function requireAuth() {
  let user = getCurrentUser();
  if (user) return user;

  try {
    user = await authRefresh();
    return user;
  } catch (e) {
    window.location.href = "login.html";
    return null;
  }
}

/* ============================================================
   authFetch — same network-vs-HTTP-error distinction as the
   rest of this project's apiRequest helper, plus automatic
   Authorization header and a one-shot silent refresh on 401.
   ============================================================ */
async function authFetch(apiUrl, apiKey, path, options) {
  options = options || {};

  async function doFetch() {
    const headers = Object.assign(
      {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      options.headers || {}
    );

    const idToken = getIdToken();
    if (idToken) headers["Authorization"] = idToken; // no "Bearer " prefix

    const requestOptions = {
      method: options.method || "GET",
      headers: headers,
    };
    if (options.body) requestOptions.body = JSON.stringify(options.body);

    let response;
    try {
      response = await fetch(apiUrl + path, requestOptions);
    } catch (networkError) {
      console.error("Network/CORS error calling", path, networkError);
      throw new Error("Could not reach the API (network or CORS error).");
    }
    return response;
  }

  let response = await doFetch();

  // Access denied could mean an expired ID token — try one silent
  // refresh, then retry the call once before giving up.
  if (response.status === 401) {
    try {
      await authRefresh();
      response = await doFetch();
    } catch (e) {
      window.location.href = "login.html";
      throw new Error("Session expired. Please log in again.");
    }
  }

  if (!response.ok) {
    let message = "Request failed with status " + response.status;
    try {
      const errBody = await response.json();
      if (errBody && errBody.message) message = errBody.message;
    } catch (e) { /* not JSON */ }
    throw new Error(message + " (HTTP " + response.status + ")");
  }

  if (response.status === 204) return null;
  return response.json();
}
