// providers/porter.js
// ⚠️ SKELETON — Porter ke OFFICIAL API docs milne ke baad hi bharna hai.
// Jab tak IMPLEMENTED = false hai, ye provider "ready" nahi maana jayega
// aur koi galat/guess kiya hua API call kabhi nahi jayega.
//
// Docs se ye cheezein confirm karni hain:
//   1. Base URL + auth header (env: PORTER_API_KEY, PORTER_BASE_URL)
//   2. Get Quote  — request/response fields
//   3. Create Order — request fields (pickup/drop address, lat/lng, contact, request_id)
//   4. Cancel Order endpoint
//   5. Webhook — signature/verification ka tarika + payload ka format
//
// Porter ki known limits (porter.in/api-integrations se):
//   - Sirf prepaid orders (COD nahi)
//   - API se sirf 2-wheeler
//   - Pickup aur drop dono ke lat/lng zaroori
//   - Webhook events: Accepted, Live, Ended, Reopened, Cancelled

const IMPLEMENTED = false; // ← docs ke baad true karo

const NAME = "porter";

class NotReadyError extends Error {
  constructor(msg) {
    super(msg);
    this.code = "NOT_READY";
  }
}

// Porter ke event → Khaatogo ke common status.
// TODO: docs se exact event names/meaning verify karo (khaaskar "Live" ka matlab).
const STATUS_MAP = {
  accepted: "assigned",
  live: "picked_up",
  ended: "delivered",
  reopened: "reopened",
  cancelled: "cancelled",
};

function isReady() {
  return IMPLEMENTED && Boolean(process.env.PORTER_API_KEY);
}

// pickup/drop: { lat, lng, address, name, phone }
// return: { fare: number (INR), serviceable: boolean }
async function getQuote(/* { pickup, drop } */) {
  throw new NotReadyError("Porter getQuote abhi implement nahi hua (docs chahiye)");
}

// input: { requestId, pickup, drop, order }
// return: { providerOrderId: string, trackingUrl?: string, fare?: number }
async function createOrder(/* { requestId, pickup, drop, order } */) {
  throw new NotReadyError("Porter createOrder abhi implement nahi hua (docs chahiye)");
}

async function cancelOrder(/* providerOrderId */) {
  throw new NotReadyError("Porter cancelOrder abhi implement nahi hua (docs chahiye)");
}

// input: { rawBody: Buffer, headers }
// return: { providerOrderId, status (common status), extra?: {} }
// Invalid signature par: err.code = "BAD_SIGNATURE" throw karo
function parseWebhook(/* { rawBody, headers } */) {
  throw new NotReadyError("Porter webhook parsing abhi implement nahi hua (docs chahiye)");
}

module.exports = {
  name: NAME,
  STATUS_MAP,
  isReady,
  getQuote,
  createOrder,
  cancelOrder,
  parseWebhook,
};