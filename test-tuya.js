const crypto = require("crypto");

const ACCESS_ID = "q9qqr47wgqknjvmx9kdv";
const ACCESS_SECRET = "82b363a4b3d74d7abae50cb69325de48";
const BASE_URL = "https://openapi.tuyaus.com"; // US data center

async function getToken() {
  const t = Date.now().toString();
  const method = "GET";
  const path = "/v1.0/token?grant_type=1";
  const contentHash = crypto.createHash("sha256").update("").digest("hex");
  const stringToSign = [method, contentHash, "", path].join("\n");
  const signStr = ACCESS_ID + t + stringToSign;
  const sign = crypto.createHmac("sha256", ACCESS_SECRET).update(signStr).digest("hex").toUpperCase();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      client_id: ACCESS_ID,
      sign,
      t,
      sign_method: "HMAC-SHA256",
    },
  });
  const data = await res.json();
  console.log("Token response:", JSON.stringify(data, null, 2));
  return data.result?.access_token;
}

async function getDeviceStatus(token, deviceId) {
  const t = Date.now().toString();
  const method = "GET";
  const path = `/v1.0/iot-03/devices/${deviceId}/status`;
  const contentHash = crypto.createHash("sha256").update("").digest("hex");
  const stringToSign = [method, contentHash, "", path].join("\n");
  const signStr = ACCESS_ID + token + t + stringToSign;
  const sign = crypto.createHmac("sha256", ACCESS_SECRET).update(signStr).digest("hex").toUpperCase();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      client_id: ACCESS_ID,
      access_token: token,
      sign,
      t,
      sign_method: "HMAC-SHA256",
    },
  });
  return res.json();
}

async function getDeviceInfo(token, deviceId) {
  const t = Date.now().toString();
  const method = "GET";
  const path = `/v1.0/devices/${deviceId}`;
  const contentHash = crypto.createHash("sha256").update("").digest("hex");
  const stringToSign = [method, contentHash, "", path].join("\n");
  const signStr = ACCESS_ID + token + t + stringToSign;
  const sign = crypto.createHmac("sha256", ACCESS_SECRET).update(signStr).digest("hex").toUpperCase();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      client_id: ACCESS_ID,
      access_token: token,
      sign,
      t,
      sign_method: "HMAC-SHA256",
    },
  });
  return res.json();
}

async function main() {
  const token = await getToken();
  if (!token) return;

  // Water sensor
  console.log("\n=== Water Sensor (eb4b975ccbbe3fb9dc98n2) ===");
  const waterInfo = await getDeviceInfo(token, "eb4b975ccbbe3fb9dc98n2");
  console.log("Info:", JSON.stringify(waterInfo, null, 2));
  const waterStatus = await getDeviceStatus(token, "eb4b975ccbbe3fb9dc98n2");
  console.log("Status:", JSON.stringify(waterStatus, null, 2));

  // Garage door
  console.log("\n=== Garage Door (02133168d8f15b852ef8) ===");
  const garageInfo = await getDeviceInfo(token, "02133168d8f15b852ef8");
  console.log("Info:", JSON.stringify(garageInfo, null, 2));
  const garageStatus = await getDeviceStatus(token, "02133168d8f15b852ef8");
  console.log("Status:", JSON.stringify(garageStatus, null, 2));
}

main().catch(console.error);
