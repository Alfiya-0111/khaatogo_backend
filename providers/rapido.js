// providers/rapido.js
// ⚠️ SKELETON — pehle ye confirm karna hai ki Rapido ka business delivery API hai ya nahi.
// Jab tak IMPLEMENTED = false hai, ye provider kabhi use nahi hoga.
//
// Rapido team se ye poochna hai:
//   - Kya on-demand delivery ka API hai? (quote, create order, cancel, webhook)
//   - Credentials kaise milenge, COD support hai ya nahi, kin cities mein chalta hai

const IMPLEMENTED = false; // ← API confirm hone ke baad true karo

const NAME = "rapido";

class NotReadyError extends Error {
  constructor(msg) {
    super(msg);
    this.code = "NOT_READY";
  }
}

// TODO: Rapido ke events → common status (assigned, picked_up, delivered, cancelled, reopened)
const STATUS_MAP = {};

function isReady() {
  return IMPLEMENTED && Boolean(process.env.RAPIDO_API_KEY);
}

async function getQuote() {
  throw new NotReadyError("Rapido getQuote implement nahi hua");
}

async function createOrder() {
  throw new NotReadyError("Rapido createOrder implement nahi hua");
}

async function cancelOrder() {
  throw new NotReadyError("Rapido cancelOrder implement nahi hua");
}

function parseWebhook() {
  throw new NotReadyError("Rapido webhook parsing implement nahi hua");
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