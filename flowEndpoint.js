// flowEndpoint.js
// ★ NEW — WhatsApp Flow ka data-exchange endpoint. Meta hamesha encrypted
// request bhejta hai (AES key jo RSA se encrypt hoti hai), humein decrypt
// karke response dena hota hai, wapas encrypt karke.
//
// EK BAAR KA SETUP (isse pehle chalao):
// 1) RSA key pair banao:
//    openssl genrsa -out private.pem 2048
//    openssl rsa -in private.pem -pubout -out public.pem
// 2) Private key .env mein PRIVATE_KEY="-----BEGIN..." (newlines \n se) daalo
// 3) Public key Meta ko register karo (ek baar):
//    POST https://graph.facebook.com/v21.0/{phone_number_id}/whatsapp_business_encryption
//    body: { business_public_key: "<public.pem ka content>" }
// 4) Flow banate waqt (Graph API /{waba_id}/flows) endpoint_uri isi route
//    (/webhook/whatsapp-flow) ko point karo

const crypto = require("crypto");

function decryptRequest(body, privatePem) {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

  const aesKey = crypto.privateDecrypt(
    {
      key: privatePem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(encrypted_aes_key, "base64")
  );

  const flowDataBuffer = Buffer.from(encrypted_flow_data, "base64");
  const ivBuffer = Buffer.from(initial_vector, "base64");
  const TAG_LENGTH = 16;
  const encryptedBody = flowDataBuffer.subarray(0, -TAG_LENGTH);
  const authTag = flowDataBuffer.subarray(-TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, ivBuffer);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedBody), decipher.final()]);

  return { decryptedBody: JSON.parse(decrypted.toString("utf-8")), aesKey, ivBuffer };
}

function encryptResponse(responseObj, aesKey, ivBuffer) {
  // response encrypt karte waqt IV ko flip (invert) karna Meta ka requirement hai
  const flippedIv = Buffer.from(ivBuffer.map((b) => ~b & 0xff));
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseObj), "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([encrypted, authTag]).toString("base64");
}

module.exports = { decryptRequest, encryptResponse };