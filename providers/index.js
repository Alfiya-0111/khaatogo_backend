// providers/index.js
// Saare delivery providers ek jagah. Naya provider add karna ho to bas yahan register karo.
//
// Provider order Railway env se control hota hai:
//   DELIVERY_PROVIDER_ORDER=porter,rapido
// Pehla ready provider try hoga, fail hone par agla.

const porter = require("./porter");
const rapido = require("./rapido");

const ALL = { porter, rapido };

function order() {
  return (process.env.DELIVERY_PROVIDER_ORDER || "porter,rapido")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Sirf wo providers jo implemented hain AUR jinki credentials env mein set hain
function ready() {
  return order()
    .map((name) => ALL[name])
    .filter((p) => p && p.isReady());
}

function get(name) {
  return ALL[String(name || "").toLowerCase()] || null;
}

module.exports = { ready, get, order, ALL };