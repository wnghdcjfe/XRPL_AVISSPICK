require("dotenv").config();

const { collections } = require("./db/mongodb");
const { canonicalString, sha256Hex } = require("./utils/poe");
const { submitHashToXRPL } = require("./services/xrplPoe");
const xrpl = require("xrpl");

const XRPL_POE_ENABLED = (process.env.XRPL_POE_ENABLED || "false").toLowerCase() === "true";
const XRPL_NETWORK = process.env.XRPL_NETWORK || "testnet";
const XRPL_ACCOUNT = process.env.XRPL_ACCOUNT || "";
const XRPL_SEED = process.env.XRPL_SEED || "";
const XRPL_DEST_ACCOUNT = process.env.XRPL_DEST_ACCOUNT || "";

const RESUME_TOKENS = { coin: null, stock: null };
const POLL_INTERVAL_MS = Number(process.env.POE_POLL_INTERVAL_MS || 15000);
const POLL_LOOKBACK_MS = Number(process.env.POE_POLL_LOOKBACK_MS || 24 * 60 * 60 * 1000);
const POLL_LIMIT = Number(process.env.POE_POLL_LIMIT || 500);
const POLLER_STARTED = { coin: false, stock: false };

const normalizeHex = s => String(s || "").toLowerCase().replace(/^0x/, "");

function buildCanonTarget(doc, type = "coin") {
  return {
    type: doc.strategy,
    symbol: doc.ticker,
    ts: new Date(doc.dateAdded).toISOString(),
    payload: {
      close: typeof doc.close === "number" ? Number(doc.close.toFixed(4)) : doc.close,
      rsi:
        type === "stock"
          ? typeof doc.RSI_240 === "number"
            ? Number(doc.RSI_240.toFixed(2))
            : doc.RSI_240
          : typeof doc.RSI_5 === "number"
            ? Number(doc.RSI_5.toFixed(2))
            : doc.RSI_5,
      mn: typeof doc.mn === "number" ? Number(doc.mn.toFixed(4)) : doc.mn,
    },
  };
}

async function createBaseline({ doc, col, label = "poe-watcher", type = "coin" }) {
  const target = buildCanonTarget(doc, type);
  const canon = canonicalString(target);
  const hash = sha256Hex(canon);

  let tx = {
    status: "pending",
    txHash: null,
    ledgerIndex: null,
    memoHex: hash.replace(/^0x/, ""),
    explorerUrl: null,
    validatedAt: null,
  };

  if (XRPL_POE_ENABLED && XRPL_ACCOUNT && XRPL_SEED) {
    try {
      const r = await submitHashToXRPL({
        network: XRPL_NETWORK,
        seed: XRPL_SEED,
        account: XRPL_ACCOUNT,
        hashHex: hash,
        destinationAccount: XRPL_DEST_ACCOUNT,
      });
      tx.status = r.validated ? "on-ledger" : "pending";
      tx.txHash = r.txHash;
      tx.ledgerIndex = r.ledgerIndex;
      tx.memoHex = r.memoHex;
      tx.explorerUrl = r.txHash
        ? (XRPL_NETWORK === "mainnet"
            ? `https://livenet.xrpl.org/transactions/${r.txHash}`
            : `https://testnet.xrpl.org/transactions/${r.txHash}`)
        : null;
      tx.validatedAt = r.validated ? new Date() : null;
    } catch (e) {
      tx.status = "failed";
      tx.error = String(e);
      console.warn(`[${label}] submitHashToXRPL failed`, { id: String(doc._id), err: tx.error });
    }
  }

  const setFields = {
    "poe.status": tx.status,
    "poe.txHash": tx.txHash,
    "poe.ledgerIndex": tx.ledgerIndex,
    "poe.memoHex": tx.memoHex,
    "poe.explorerUrl": tx.explorerUrl,
    "poe.validatedAt": tx.validatedAt,
    "poe.version": 1,
    "poe.hash": hash,
    "poe.canon": canon,
    "poe.network": XRPL_NETWORK,
    "poe.account": XRPL_ACCOUNT || null,
    "poe.signalId": String(doc._id),
    "poe.createdAt": new Date(),
    "poe.note": "baseline created",
    "poe.tampered": false,
    "poe.history": [],
  };
  if (tx.error !== undefined) setFields["poe.error"] = String(tx.error);

  await col.updateOne({ _id: doc._id }, { $set: setFields });
  console.info(`[${label}] baseline created`, { _id: String(doc._id), status: tx.status, txHash: tx.txHash });
}

async function markTampered({ col, doc, label = "poe-watcher", reason = "any field changed", details = {}, type = "coin" }) {
  const prev = doc.poe || {};

  const targetNow = buildCanonTarget(doc, type);
  const canonNow = canonicalString(targetNow);
  const hashNow = sha256Hex(canonNow);

  try {
    if (prev?.hash && normalizeHex(prev.hash) === normalizeHex(hashNow)) {
      console.info(`[${label}] change detected but baseline hash unchanged; skip tampered`, { _id: String(doc._id) });
      return;
    }
  } catch (e) {}

  let onchainMemoMatch = null, onchainTxHash = null, onchainChecked = false;
  try {
    if (xrpl && prev.status === "on-ledger") {
      const endpoint = prev.network === "mainnet" ? "wss://xrplcluster.com" : "wss://s.altnet.rippletest.net:51233";
      const client = new xrpl.Client(endpoint);
      await client.connect();
      try {
        if (prev.txHash) {
          const tx = await client.request({ command: "tx", transaction: prev.txHash });
          const memos = (tx?.result?.Memos || []).map(m => m?.Memo?.MemoData).filter(Boolean).map(s => normalizeHex(s));
          const expected = normalizeHex(prev.memoHex || prev.hash || "");
          onchainMemoMatch = memos.includes(expected);
          onchainTxHash = prev.txHash;
          onchainChecked = true;
        } else if (prev.account && prev.ledgerIndex && (prev.memoHex || prev.hash)) {
          const min = Math.max(0, prev.ledgerIndex - 2000);
          const max = prev.ledgerIndex + 2000;
          let marker;
          const expected = normalizeHex(prev.memoHex || prev.hash || "");
          do {
            const resp = await client.request({
              command: "account_tx",
              account: prev.account,
              ledger_index_min: min,
              ledger_index_max: max,
              limit: 200,
              marker,
            });
            for (const t of (resp.result.transactions || [])) {
              const memos = (t?.tx?.Memos || []).map(m => m?.Memo?.MemoData).filter(Boolean).map(normalizeHex);
              if (memos.includes(expected)) { onchainMemoMatch = true; onchainTxHash = t?.tx?.hash; break; }
            }
            marker = resp.result.marker;
          } while (marker && onchainMemoMatch !== true);
          if (onchainMemoMatch !== true) onchainMemoMatch = false;
          onchainChecked = true;
        }
      } finally {
        await client.disconnect();
      }
    }
  } catch (e) {
    console.warn(`[${label}] onchain verify failed`, { _id: String(doc._id), err: String(e) });
  }

  let tx = {
    status: prev.status || "pending",
    txHash: null,
    ledgerIndex: null,
    memoHex: hashNow.replace(/^0x/, ""),
    explorerUrl: prev.explorerUrl || null,
    validatedAt: null,
  };
  if (XRPL_POE_ENABLED && XRPL_ACCOUNT && XRPL_SEED) {
    try {
      const r = await submitHashToXRPL({
        network: XRPL_NETWORK,
        seed: XRPL_SEED,
        account: XRPL_ACCOUNT,
        hashHex: hashNow,
        destinationAccount: XRPL_DEST_ACCOUNT,
      });
      tx.status = r.validated ? "on-ledger" : "pending";
      tx.txHash = r.txHash;
      tx.ledgerIndex = r.ledgerIndex;
      tx.memoHex = r.memoHex;
      tx.explorerUrl = r.txHash
        ? (XRPL_NETWORK === "mainnet"
            ? `https://livenet.xrpl.org/transactions/${r.txHash}`
            : `https://testnet.xrpl.org/transactions/${r.txHash}`)
        : null;
      tx.validatedAt = r.validated ? new Date() : null;
    } catch (e) {
      tx.status = "failed";
      tx.error = String(e);
      console.warn(`[${label}] submitHashToXRPL failed when marking tampered`, { id: String(doc._id), err: tx.error });
    }
  }

  const hist = {
    at: new Date(),
    note: `tampered: ${reason}`,
    prevHash: prev.hash ?? null,
    newHash: hashNow,
    prevCanon: prev.canon ?? null,
    newCanon: canonNow,
    details,
  };

  const setFields = {
    "poe.tampered": true,
    "poe.status": tx.status,
    "poe.txHash": tx.txHash,
    "poe.ledgerIndex": tx.ledgerIndex,
    "poe.memoHex": tx.memoHex,
    "poe.explorerUrl": tx.explorerUrl,
    "poe.validatedAt": tx.validatedAt,
    "poe.lastCheckedAt": new Date(),
    "poe.lastRehash": hashNow,
    "poe.lastCanon": canonNow,
    "poe.prevTxHash": prev.txHash || null,
    "poe.network": XRPL_NETWORK,
    "poe.account": XRPL_ACCOUNT || null,
    "poe.onchainChecked": onchainChecked,
    "poe.onchainMemoMatch": onchainMemoMatch,
    "poe.onchainPrevTxHash": onchainTxHash,
  };
  if (tx.error !== undefined) setFields["poe.error"] = String(tx.error);
  const upd = { $set: setFields, $push: { "poe.history": hist } };
  await col.updateOne({ _id: doc._id }, upd);
  console.warn(`[${label}] tampered (baseline preserved)`, { _id: String(doc._id) });
}

function loadResumeToken(key) {
  return RESUME_TOKENS[key] || null;
}
function saveResumeToken(key, token) {
  RESUME_TOKENS[key] = token;
}

function createWatcher({ col, resumeKey, label, type = "coin" }) {
  const pipeline = [{ $match: { operationType: { $in: ["update", "replace"] } } }];
  const resume = loadResumeToken(resumeKey);
  const watchOptions = { fullDocument: "updateLookup", ...(resume ? { resumeAfter: resume } : {}) };
  const changeStream = col.watch(pipeline, watchOptions);

  changeStream.on("change", async (change) => {
    try {
      if (change._id) saveResumeToken(resumeKey, change._id);

      const doc = change.fullDocument;
      const hasBaseline = !!doc?.poe?.hash;

      if (hasBaseline) {
        await markTampered({
          col,
          doc,
          label,
          reason: change.operationType === "replace" ? "document replaced" : "update detected",
          details: change.updateDescription?.updatedFields || {},
          type,
        });
        return;
      }

      await createBaseline({ doc, col, label, type });
    } catch (e) {
      console.error(`[${label}] error handling change:`, e);
    }
  });

  changeStream.on("error", (e) => {
    console.error(`[${label}] change stream error:`, e);
    const notReplica = e?.code === 40573 || /only supported on replica sets/i.test(String(e?.message || ""));
    if (notReplica) startPolling({ col, label, key: resumeKey, type });
  });

  console.log(`[${label}] watcher started. XRPL:`, XRPL_POE_ENABLED ? "on" : "off");
  return changeStream;
}

async function pollingTick({ col, label, type = "coin" }) {
  const since = new Date(Date.now() - POLL_LOOKBACK_MS);
  const cursor = col.find({ dateAdded: { $gte: since } }).sort({ dateAdded: -1 }).limit(POLL_LIMIT);
  const docs = await cursor.toArray();
  for (const doc of docs) {
    try {
      const hasBaseline = !!doc?.poe?.hash;
      if (!hasBaseline) {
        await createBaseline({ doc, col, label, type });
        continue;
      }
      const nowCanon = canonicalString(buildCanonTarget(doc, type));
      const nowHash = sha256Hex(nowCanon);
      if (normalizeHex(nowHash) !== normalizeHex(doc.poe.hash)) {
        await markTampered({ col, doc, label, reason: "polling detected change", type });
      }
    } catch (e) {
      console.error(`[${label}] polling check error:`, e);
    }
  }
}
function startPolling({ col, label, key, type = "coin" }) {
  if (POLLER_STARTED[key]) return;
  POLLER_STARTED[key] = true;
  console.warn(`[${label}] fallback to polling every ${POLL_INTERVAL_MS}ms (lookback ${Math.round(POLL_LOOKBACK_MS/1000)}s, limit ${POLL_LIMIT})`);
  pollingTick({ col, label, type }).catch(() => {});
  setInterval(() => pollingTick({ col, label, type }).catch(() => {}), POLL_INTERVAL_MS);
}

async function main() {
  const coinCol = collections.coin_strategy();
  const stockCol = collections.stock_strategy();
  createWatcher({ col: coinCol, resumeKey: "coin", label: "coin-poe-watcher", type: "coin" });
  createWatcher({ col: stockCol, resumeKey: "stock", label: "stock-poe-watcher", type: "stock" });
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error("[poe-watcher] fatal:", e);
  process.exit(1);
});
