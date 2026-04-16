const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const DB_ID = process.env.CF_D1_DB_ID;
const TOKEN = process.env.CF_D1_TOKEN;

const ENDPOINT = () =>
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

async function query(sql, params = []) {
  const res = await fetch(ENDPOINT(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors || json)}`);
  }
  return json.result;
}

async function batch(statements) {
  const res = await fetch(ENDPOINT(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(statements),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`D1 batch failed: ${JSON.stringify(json.errors || json)}`);
  }
  return json.result;
}

module.exports = { query, batch };
