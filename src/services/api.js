import { getServerUrl, getSession, setSession, clearSession } from '../storage/authStorage';
import { getDevice } from '../storage/deviceStorage';
import { isOffline, markOnline, markOffline } from './connectivity';

// Thin client for SACHIKO2's operator JSON API
// (routes/api/operatorApi.js, mounted at /sachiko/api/operator). Every call
// here maps 1:1 to one endpoint there -- see that file for the exact
// response shapes, which are reused verbatim as this app's own data model
// rather than re-described here. Modeled directly on FairtechOperatorApp's
// own src/services/api.js, extended with the material-pool / instant-produce
// endpoints Sachiko's job-card flow needs that Fairtech's simpler single-roll
// model never had.
class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// One wording for "the server isn't there", wherever it surfaces -- screens
// print err.message straight into their own error rows, so the raw
// "Network request failed" from fetch must never be what an operator reads.
const OFFLINE_MESSAGE = 'No connection to the server.';

// status 0 + offline:true is how callers tell a dead network apart from a real
// HTTP failure. Both the fail-fast path and a genuine fetch error raise this
// same error, so a screen only has to recognise one shape.
function offlineError() {
  return new ApiError(OFFLINE_MESSAGE, 0, { offline: true });
}

// RN's fetch never times out on its own: against a server that accepts the
// connection and then goes quiet it hangs indefinitely, which is exactly the
// wait this whole change exists to remove.
const REQUEST_TIMEOUT = 12000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // It answered -- that is the whole test for reachability, whatever the
    // status code says about the request itself.
    markOnline();
    return response;
  } catch (err) {
    markOffline();
    throw offlineError();
  } finally {
    clearTimeout(timer);
  }
}

// Parse a JSON response body, but fail *clearly* when the server hands back
// something that isn't JSON. The usual cause: the server 302-redirected our
// request to its HTML login page because the endpoint doesn't exist on it --
// e.g. a SACHIKO2 box that predates the operator API. That has to read as
// "this server doesn't have the feature", NOT be mistaken for a 401 that
// logs the operator out (the redirect lands on a 200 HTML page, so status
// alone wouldn't catch it). `nonJson` on the body lets callers tell the two
// apart.
function parseJsonBody(text, status) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new ApiError(
      'The server returned an unexpected response — it may be running an older build that does not have this feature yet. Ask your admin to update the SACHIKO2 server.',
      status,
      { nonJson: true },
    );
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const baseUrl = await getServerUrl();
  if (!baseUrl) {
    throw new ApiError('Server address not set. Open Settings and enter your SACHIKO2 server address.', 0);
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Identifies this install to the job-running claim (PendingProduction
  // .runningOn on the server). Sent on every call, not just the claim ones, so
  // /queue and /jobcard can each say whether the job is running on some OTHER
  // device without the client having to ask separately.
  const device = await getDevice();
  headers['X-Device-Id'] = device.id;
  headers['X-Device-Label'] = device.label;
  if (auth) {
    const session = await getSession();
    if (!session?.token) {
      throw new ApiError('Not logged in', 401);
    }
    headers.Authorization = `Bearer ${session.token}`;
  }

  // Already known to be offline: answer now rather than spending another
  // REQUEST_TIMEOUT proving it again. connectivity.js is probing in the
  // background, so this clears itself the moment the server is back.
  if (isOffline()) {
    throw offlineError();
  }

  const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, '')}/sachiko/api/operator${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = parseJsonBody(text, response.status);

  if (!response.ok) {
    throw new ApiError(data.error || data.message || `Request failed (${response.status})`, response.status, data);
  }
  return data;
}

// Multipart variant of request() for the one endpoint that takes a file upload
// (maintenance photo/video). Deliberately does NOT set Content-Type: React
// Native's fetch fills in the multipart/form-data boundary itself from the
// FormData body, and setting it by hand drops the boundary and breaks parsing.
async function requestMultipart(path, formData) {
  const baseUrl = await getServerUrl();
  if (!baseUrl) {
    throw new ApiError('Server address not set. Open Settings and enter your SACHIKO2 server address.', 0);
  }
  const session = await getSession();
  if (!session?.token) {
    throw new ApiError('Not logged in', 401);
  }
  if (isOffline()) {
    throw offlineError();
  }

  const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, '')}/sachiko/api/operator${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
    body: formData,
  });

  const text = await response.text();
  const data = parseJsonBody(text, response.status);
  if (!response.ok) {
    throw new ApiError(data.error || data.message || `Request failed (${response.status})`, response.status, data);
  }
  return data;
}

// `geo` is the device's own position at sign-in (services/geolocation.js) --
// either { latitude, longitude, accuracy } or { error } when it couldn't be
// read. It rides along purely so the server can stamp it onto the LOGIN audit
// entry; nothing in the response depends on it, and a login with no geo at all
// is still a perfectly valid login.
export async function login({ operatorNick, location, password, geo }) {
  const data = await request('/login', {
    method: 'POST',
    auth: false,
    body: { operatorNick, location, password, geo },
  });
  await setSession(data);
  return data;
}

export async function logout() {
  await clearSession();
}

export function getLocations() {
  return request('/locations', { auth: false });
}

// Take the running claim on a job for this device -- called at the first Job
// Setting Start punch. Throws ApiError with status 409 when another device
// already holds it (body carries runningOnLabel).
export function claimJob(pendingId) {
  return request('/jobcard/claim', { method: 'POST', body: { pendingId } });
}

// Keep this device's claim fresh while the job card is open. 409 means the
// claim was lost (it went stale and another device took it).
export function heartbeatJob(pendingId) {
  return request('/jobcard/heartbeat', { method: 'POST', body: { pendingId } });
}

export function getQueue() {
  return request('/queue');
}

export function getJobCard(pendingId) {
  return request(`/jobcard/${encodeURIComponent(pendingId)}`);
}

// ── Material pools (Facestock / Adhesive / Release Liner) ──────────────────
// The scan-once-and-mount model Sachiko's lamination process needs, in place
// of Fairtech's per-row roll scan. See routes/api/operatorApi.js's own
// endpoints of the same name for the exact business logic reused.

// Validate a scanned reel against this order's recipe before it's mounted --
// returns { ok:false, code: "unknown"|"mismatch"|"wip" } on a reel that can't
// be used, or { ok:true, reel, variant } on one that can.
export function checkMaterial({ pendingId, pool, rollId, mounted }) {
  return request('/jobcard/material/check', { method: 'POST', body: { pendingId, pool, rollId, mounted } });
}

// Flags a mounted reel as actually being drawn on right now -- fired the
// moment a row's Start is punched for whichever pool ids are already filled
// in, not at scan time (see the server route's own comment on this timing).
export function markInUse({ pendingId, pool, rollId }) {
  return request('/jobcard/mark-in-use', { method: 'POST', body: { pendingId, pool, rollId } });
}

// Fired the moment a Production Log row's Stop is punched (with Meters
// already filled in) -- instantly laminates a traceable Deckle rather than
// waiting for the whole card to be saved. `rowToken` (see utils/rowToken.js)
// makes this safe to retry: a lost response and the final save both match
// the same Deckle back by token instead of making a duplicate.
export function logProduce(payload) {
  return request('/jobcard/log/produce', { method: 'POST', body: payload });
}

// Takes a mounted reel off the job mid-run (it ran out, or the wrong one was
// scanned) -- the operator reports how much is physically left, and a
// mandatory reason for the swap.
export function setRemaining({ pendingId, pool, stockId, remainingKg, reason }) {
  return request('/jobcard/material/set-remaining', {
    method: 'POST',
    body: { pendingId, pool, stockId, remainingKg, reason },
  });
}

export function postJobCard(payload) {
  return request('/jobcard', { method: 'POST', body: payload });
}

// ── Slitting ─────────────────────────────────────────────────────────────────
// The step after lamination: an allocated Deckle web is cut into the finished
// roll widths a client order asked for. One card per Deckle, planned on the
// server's Slitting Allocation page (/sachiko/slitting/allocate/:pendingId)
// and worked here off the same Work Queue the lamination jobs come from --
// getQueue()'s `slittingRows` carries them, so there is no separate queue
// call. Every endpoint below maps 1:1 to routes/api/operatorApi.js's own
// /slitting/* routes, which are thin adapters over the very logic the web
// card punches (routes/system/slitting.js).

// One open card: the Deckle(s) allocated to it, their A..L knife layout,
// planned metres, live reel metres and curing state, plus any Job Setting
// rows already punched.
export function getSlittingCard(cardId) {
  return request(`/slitting/jobcard/${encodeURIComponent(cardId)}`);
}

// The setup-wastage rows, saved in one shot when Start Production is tapped.
// Nothing here moves stock, so unlike a Deckle row's Start/Stop there is no
// per-punch round trip; re-saving simply overwrites.
export function saveSlittingSetting({ cardId, rows }) {
  return request('/slitting/jobcard/setting', { method: 'POST', body: { cardId, rows } });
}

// Confirm the reel actually on the machine. A scan does NOT have to be the
// exact Deckle the planner allocated -- any free web of the same Product Code
// and raw size can be run in its place, and this re-points the row at it
// server-side (which is also what frees the old reel and locks the new one to
// this card). Resolves to { success, unchanged?, row? }; a refusal arrives as
// an ApiError whose body carries `code` -- "unknown" | "mismatch" | "empty" |
// "short" | "no-location" | "curing" | "in-use" -- so the scan strip can say
// why rather than just that it failed.
export function swapSlittingDeckle({ cardId, index, rollId }) {
  return request('/slitting/jobcard/row/swap-deckle', { method: 'POST', body: { cardId, index, rollId } });
}

// Stamps the clock on one Deckle row. Deliberately separate from produce: a
// run that is started and then abandoned leaves a start time and no stock
// movement, which is exactly what happened on the floor.
export function startSlittingRow({ cardId, index, startTime, startMtrs }) {
  return request('/slitting/jobcard/row/start', {
    method: 'POST',
    body: { cardId, index, startTime, startMtrs },
  });
}

// Stop -- the only call in the slitting flow that moves stock: this row's
// finished rolls into Finished Goods (one per knife position), and the metres
// that ran off the Deckle. Safe to retry: a row already done replays its own
// roll ids rather than inwarding a second set (`replayed: true`).
export function produceSlittingRow(payload) {
  return request('/slitting/jobcard/row/produce', { method: 'POST', body: payload });
}

// Corrects the Joint note on an already-run row -- the one part of a finished
// row's record that isn't tied to a stock movement.
export function editSlittingJoint({ cardId, index, joint, jointMtr }) {
  return request('/slitting/jobcard/row/edit', { method: 'POST', body: { cardId, index, joint, jointMtr } });
}

// TSPL for one raw-material reel's label. `pool` is "facestock" | "adhesive" |
// "release".
export function getRollPrn(pool, stockId) {
  return request(`/${pool}/${encodeURIComponent(stockId)}/prn`);
}

// TSPL for a produced Deckle's label.
export function getDecklePrn(stockId) {
  return request(`/deckle/${encodeURIComponent(stockId)}/prn`);
}

// ── Logs ─────────────────────────────────────────────────────────────────────

// One day of this operator's own production -- every Deckle they punched out,
// newest first, plus the day's totals. `date` is YYYY-MM-DD; the device's own
// UTC offset rides along so "today" means the operator's day, not the
// server's (see the /logs route for how the window is built).
export function getLogs(date) {
  const tzOffset = new Date().getTimezoneOffset();
  return request(`/logs?date=${encodeURIComponent(date)}&tzOffset=${tzOffset}`);
}

// ── Maintenance ──────────────────────────────────────────────────────────────
// The shopfloor maintenance tickets (routes/api/operatorApi.js's /maintenance),
// the JSON mirror of SACHIKO2's operator maintenance page.

// The operator's own tickets + the machine picker for the report form. Same
// payload shape the web page renders from -- see toMaintenanceRow on the server.
export function getMaintenance() {
  return request('/maintenance');
}

// Raise a ticket. `photo` and `video` (both optional) are captured files as
// { uri, name, type }; a ticket can carry a photo and/or a video, matching the
// web form and the server's multipart fields (photo/video). A description alone
// is still a valid ticket, so both may be omitted.
export function postMaintenance({ description, machineId, photo, video }) {
  const form = new FormData();
  form.append('description', description);
  if (machineId) {
    form.append('machineId', machineId);
  }
  if (photo?.uri) {
    form.append('photo', {
      uri: photo.uri,
      name: photo.name || 'photo.jpg',
      type: photo.type || 'image/jpeg',
    });
  }
  if (video?.uri) {
    form.append('video', {
      uri: video.uri,
      name: video.name || 'video.mp4',
      type: video.type || 'video/mp4',
    });
  }
  return requestMultipart('/maintenance', form);
}

// Attachments are token-authed. React Native's <Image> can't reliably attach an
// Authorization header on Android (facebook/react-native#30017, worse on the
// New Architecture), so the token rides in a ?token= query param instead -- the
// server's media routes accept it there (requireOperatorApiMediaAuth). Load this
// once (server address + token) and build the per-attachment source with
// maintenanceMediaSource below.
export async function getMediaAuth() {
  const [baseUrl, session] = await Promise.all([getServerUrl(), getSession()]);
  return { baseUrl: (baseUrl || '').replace(/\/+$/, ''), token: session?.token || null };
}

// A ready-to-use <Image>/media source for one ticket attachment, addressed by
// ticket id + attachment index (never by filename). `thumb` fetches the small
// list thumbnail; omit it for the full asset.
export function maintenanceMediaSource(mediaAuth, ticketId, index, { thumb = false } = {}) {
  const suffix = thumb ? '/thumb' : '';
  const query = mediaAuth.token ? `?token=${encodeURIComponent(mediaAuth.token)}` : '';
  return {
    uri: `${mediaAuth.baseUrl}/sachiko/api/operator/maintenance/media/${encodeURIComponent(ticketId)}/${index}${suffix}${query}`,
  };
}

export { ApiError, OFFLINE_MESSAGE };

// True when this error means "the server isn't reachable" rather than "the
// server said no" -- screens use it to stay quiet and let the app-wide offline
// banner do the talking.
export function isOfflineError(err) {
  return err instanceof ApiError && err.status === 0 && !!err.body?.offline;
}
