// scripts/mock_signal_poe_test.js
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const axios = require("axios");

async function main() {
  const SIGNAL_TOKEN = process.env.SIGNAL_TOKEN;
  const COIN_DB_URI = process.env.COIN_DB_BETA_URI || process.env.COIN_DB_URI;
  const BASE_API = process.env.BASE_API || "http://localhost";

  if (!SIGNAL_TOKEN || !COIN_DB_URI) {
    console.error("환경변수 SIGNAL_TOKEN / COIN_DB_URI 가 필요합니다.");
    process.exit(1);
  } 
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const sample = {
    korean_name: "비트코인",
    RSI_5: 22.51,
    close: 1000, 
    acc_volume_price: 2638574935.12,
    acc_volume_price_mn: 72395108.34,
    vl_mn: 1854.6,
    rise_hl_1h: 1,
    rise_hl_2h: 1.17,
    rise_hl_4h: 0,
    volume_idx: 1,
    mn: -0.6,
    dateAdded: nowIso,
    strategy: "buy/MN2",
    ticker: "BITGET:BTCUSDT.P",
    high: 97282.7,
    low: 97282.7,
    RSI_5_low: 22.51,
    RSI_5_high: 22.51,
    result: "fail",
    result_data: null,
    result_time: 3,
  }; 
  const postRes = await axios.post(COIN_DB_URI, [sample], {
    headers: { "Content-Type": "application/json", authorization: SIGNAL_TOKEN },
    validateStatus: () => true,
  });
  console.log("POST status:", postRes.status, postRes.data); 
  await new Promise((r) => setTimeout(r, 1500)); 
  const verifyUrl = `${BASE_API.replace(/\/$/, "")}/api/poe/signals/verify`;  
  const params = new URLSearchParams({ type: "coin", ticker: sample.ticker, dateAdded: sample.dateAdded, close: String(sample.close), debug: "1" });
  const full = `${verifyUrl}?${params.toString()}`;
  console.log("→", full);

  const vRes = await axios.get(full, { validateStatus: () => true });
  console.log("VERIFY status:", vRes.status, vRes.data);

  if (vRes.data?.localMatch) {
    console.log("✓ 로컬 재해시 일치");
  } else {
    console.log("✗ 로컬 재해시 불일치 또는 미저장");
  }
  if (vRes.data?.explorerUrl) {
    console.log("탐색기:", vRes.data.explorerUrl);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
