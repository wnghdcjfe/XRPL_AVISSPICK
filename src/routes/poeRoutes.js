const express = require("express")
const router = express.Router()
const { collections } = require("../db/mongodb")
const { ObjectId } = require("mongodb")
const { canonicalString, sha256Hex, buildCredentialCanon } = require("../utils/poe")
const { submitMemoPayment, createEscrow, finishEscrow } = require("../services/xrplPoe")
const xrpl = require("xrpl")
const XRPL_POE_ENABLED = (process.env.XRPL_POE_ENABLED || "false").toLowerCase() === "true"
const XRPL_NETWORK = process.env.XRPL_NETWORK || "testnet"
const XRPL_ACCOUNT = process.env.XRPL_ACCOUNT || ""
const XRPL_SEED = process.env.XRPL_SEED || ""
const XRPL_DEST_ACCOUNT = process.env.XRPL_DEST_ACCOUNT || ""

const normalizeHex = s =>
    String(s || "")
        .toLowerCase()
        .replace(/^0x/, "")

function buildExplorerUrl(network, txHash) {
    return network === "mainnet" ? `https://livenet.xrpl.org/transactions/${txHash}` : `https://testnet.xrpl.org/transactions/${txHash}`
}

function buildCanonTarget(doc, type) {
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
    }
}

async function fetchTxByKnownHashOrSearch({ network, account, txHash, ledgerIndex, memoHex }) {
    const ENDPOINT = network === "mainnet" ? "wss://xrplcluster.com" : "wss://s.altnet.rippletest.net:51233"
    const client = new xrpl.Client(ENDPOINT)
    await client.connect()
    try {
        if (txHash) {
            const tx = await client.request({ command: "tx", transaction: txHash })
            return { tx: tx.result, foundHash: txHash }
        }
        if (account && ledgerIndex && memoHex) {
            const min = Math.max(0, ledgerIndex - 2000)
            const max = ledgerIndex + 2000
            let marker = undefined
            const targetHex = normalizeHex(memoHex)
            do {
                const resp = await client.request({
                    command: "account_tx",
                    account,
                    ledger_index_min: min,
                    ledger_index_max: max,
                    limit: 200,
                    marker,
                })
                for (const t of resp.result.transactions || []) {
                    const memos = (t?.tx?.Memos || [])
                        .map(m => m?.Memo?.MemoData)
                        .filter(Boolean)
                        .map(normalizeHex)
                    if (memos.includes(targetHex)) {
                        return { tx: t.tx, foundHash: t?.tx?.hash }
                    }
                }
                marker = resp.result.marker
            } while (marker)
        }
        return { tx: null, foundHash: null }
    } finally {
        await client.disconnect()
    }
}

router.get("/signals/verify", async (req, res) => {
    try {
        console.log(req.query)
        const { type = "coin", ticker, dateAdded, compare, close } = req.query
        if (!ticker) {
            return res.status(400).json({ ok: false, code: "missing_params", msg: "ticker is required" })
        }
        const s = String(dateAdded || "")
        if (!s) {
            return res.status(400).json({ ok: false, code: "missing_params", msg: "dateAdded is required" })
        } 
        const raw = String(s || "")
        if (!raw) {
            return res.status(400).json({ ok: false, code: "missing_params", msg: "dateAdded is required" })
        }

        const hasTz = /Z|[+-]\d{2}:?\d{2}$/.test(raw) 
        const base = hasTz ? new Date(raw) : new Date(new Date(raw).getTime() - 9 * 60 * 60 * 1000)
        if (isNaN(base)) {
            return res.status(400).json({ ok: false, code: "invalid_date", msg: "dateAdded is invalid" })
        }
 
        const start = new Date(base.getTime() - 60 * 1000)
        start.setUTCSeconds(0, 0)
        const end = new Date(start.getTime() + 2 * 60 * 1000)  

        const collection = type === "stock" ? collections.stock_strategy() : collections.coin_strategy()

        const filter = {
            ticker: String(ticker),
            dateAdded: { $gte: start, $lt: end },  
        }
 
        const closeNum = Number(close)
        if (Number.isFinite(closeNum)) {
            const tol = Math.max(1e-4, Math.abs(closeNum) * 5e-4)
            filter.close = { $gte: closeNum - tol, $lte: closeNum + tol } 
        }

        console.log(filter)

        const doc = await collection.findOne(filter)
        if (!doc) {
            return res.status(404).json({ ok: false, code: "not_found", msg: "문서를 찾을 수 없음" })
        }

        const poe = doc.poe || {}
        const savedHash = normalizeHex(poe.hash)
        if (!savedHash) {
            return res.status(404).json({ ok: false, code: "no_saved_hash", msg: "저장된 해시 없음" })
        }

        let localHash
        if (poe.canon) {
            localHash = sha256Hex(poe.canon)
        } else {
            const target = buildCanonTarget(doc, type)
            const canon = canonicalString(target)
            localHash = sha256Hex(canon)
        }
        const localMatch = normalizeHex(localHash) === savedHash

        // live 비교 옵션
        const doCompareLive = String(compare || "") === "live"
        let liveHash = null,
            liveMatch = null
        if (doCompareLive) {
            const canonNow = canonicalString(buildCanonTarget(doc, type))
            liveHash = sha256Hex(canonNow)
            liveMatch = normalizeHex(liveHash) === savedHash
        }

        // 온체인 검증
        let foundTx = null
        let foundHash = null
        let memoMatch = null
        let onLedger = false

        if (poe.status === "on-ledger") {
            const memoHex = normalizeHex(poe.memoHex || savedHash)
            const { tx, foundHash: fh } = await fetchTxByKnownHashOrSearch({
                network: poe.network || "testnet",
                account: poe.account,
                txHash: poe.txHash,
                ledgerIndex: poe.ledgerIndex,
                memoHex,
            })
            foundTx = tx
            foundHash = fh
            if (foundTx) {
                const expectedHex = normalizeHex(poe.memoHex || savedHash)
                const memosRoot = Array.isArray(foundTx.Memos) ? foundTx.Memos : Array.isArray(foundTx.tx_json?.Memos) ? foundTx.tx_json.Memos : []
                const normalizedHexes = memosRoot
                    .map(m => m?.Memo?.MemoData)
                    .filter(Boolean)
                    .map(normalizeHex)
                memoMatch = normalizedHexes.includes(expectedHex)
                onLedger = true
            }
        }

        // 판정
        let code
        if (poe.status === "on-ledger" && foundTx && memoMatch === false) code = "memo_mismatch"
        else if (doCompareLive && liveMatch === false) code = "tampered"
        else if (poe.tampered) code = "tampered"
        else if (!localMatch) code = "tampered"
        else if (poe.status === "pending") code = "pending"
        else if (poe.status === "failed") code = "failed"
        else if (poe.status === "on-ledger" && !foundTx) code = "tx_not_found"
        else if (poe.status === "on-ledger" && memoMatch) code = "ok_on_chain"
        else if (poe.status === "on-ledger") code = "ok_but_unchecked_memo"
        else code = "ok_local_only"

        const txHash = poe.txHash || foundHash || null
        const explorerUrl = poe.explorerUrl || (txHash ? buildExplorerUrl(poe.network || "testnet", txHash) : null)

        // 발견한 txHash를 DB에 보강
        if (!poe.txHash && foundHash) {
            await collection.updateOne({ _id: doc._id }, { $set: { "poe.txHash": foundHash, "poe.explorerUrl": explorerUrl } })
        }

        const payload = {
            ok: String(code).startsWith("ok"),
            code,
            localMatch,
            onLedger,
            memoMatch,
            txHash,
            explorerUrl,
            tampered: !!poe.tampered,
            ...(doCompareLive ? { liveHash: normalizeHex(liveHash), liveMatch } : {}),
        } 

        return res.json(payload)
    } catch (e) {
        console.error("[signals/verify] error:", e)
        return res.status(500).json({ ok: false, code: "server_error", msg: String(e) })
    }
})

router.post("/credentials/issue", async (req, res) => {
    try {
        const { credential, anchor = XRPL_POE_ENABLED } = req.body || {}
        if (!credential) return res.status(400).json({ ok: false, code: "missing_credential" })
        const canon = canonicalString(buildCredentialCanon(credential))
        const hash = sha256Hex(canon)
        let onchain = null
        if (anchor && XRPL_ACCOUNT && XRPL_SEED) {
            onchain = await submitMemoPayment({
                network: XRPL_NETWORK,
                seed: XRPL_SEED,
                account: XRPL_ACCOUNT,
                memoType: "CRED",
                memoHex: hash,
                destinationAccount: XRPL_DEST_ACCOUNT,
                drops: "1",
            })
        }
        return res.json({
            ok: true,
            hash,
            canon,
            onchain: onchain
                ? {
                      validated: onchain.validated,
                      txHash: onchain.txHash,
                      ledgerIndex: onchain.ledgerIndex,
                      explorerUrl: onchain.txHash
                          ? XRPL_NETWORK === "mainnet"
                              ? `https://livenet.xrpl.org/transactions/${onchain.txHash}`
                              : `https://testnet.xrpl.org/transactions/${onchain.txHash}`
                          : null,
                  }
                : null,
        })
    } catch (e) {
        console.error("[credentials/issue] error:", e)
        return res.status(500).json({ ok: false, code: "server_error", msg: String(e) })
    }
})

router.post("/credentials/verify", async (req, res) => {
    try {
        const { credential, hashHex, account = XRPL_ACCOUNT, ledgerIndex, txHash } = req.body || {}
        const memoHex = normalizeHex(hashHex || (credential ? sha256Hex(canonicalString(buildCredentialCanon(credential))) : ""))
        if (!memoHex) return res.status(400).json({ ok: false, code: "missing_hash" })

        const { tx, foundHash } = await (async () => {
            return await fetchTxByKnownHashOrSearch({ network: XRPL_NETWORK, account, txHash, ledgerIndex, memoHex })
        })()

        let memoMatch = false,
            explorerUrl = null
        if (tx) {
            const memosRoot = Array.isArray(tx.Memos) ? tx.Memos : Array.isArray(tx.tx_json?.Memos) ? tx.tx_json.Memos : []
            const normalizedHexes = memosRoot
                .map(m => m?.Memo?.MemoData)
                .filter(Boolean)
                .map(normalizeHex)
            memoMatch = normalizedHexes.includes(memoHex)
            explorerUrl =
                XRPL_NETWORK === "mainnet"
                    ? `https://livenet.xrpl.org/transactions/${foundHash}`
                    : `https://testnet.xrpl.org/transactions/${foundHash}`
        }
        return res.json({ ok: memoMatch, txHash: foundHash, memoMatch, explorerUrl })
    } catch (e) {
        console.error("[credentials/verify] error:", e)
        return res.status(500).json({ ok: false, code: "server_error", msg: String(e) })
    }
})

router.post("/escrow/create", async (req, res) => {
    try {
        const { destination, amountDrops = "1000000", cancelAfterSec, finishAfterSec, conditionHex, memoHex } = req.body || {}
        if (!(XRPL_ACCOUNT && XRPL_SEED)) return res.status(400).json({ ok: false, code: "missing_keys" })
        if (!destination) return res.status(400).json({ ok: false, code: "missing_destination" })

        const r = await createEscrow({
            network: XRPL_NETWORK,
            seed: XRPL_SEED,
            account: XRPL_ACCOUNT,
            destination,
            amountDrops,
            cancelAfterSec,
            finishAfterSec,
            conditionHex,
            memoHex,
            memoType: "ESCROW",
        })
        const explorerUrl = r.txHash
            ? XRPL_NETWORK === "mainnet"
                ? `https://livenet.xrpl.org/transactions/${r.txHash}`
                : `https://testnet.xrpl.org/transactions/${r.txHash}`
            : null
        return res.json({ ok: true, ...r, explorerUrl })
    } catch (e) {
        console.error("[escrow/create] error:", e)
        return res.status(500).json({ ok: false, code: "server_error", msg: String(e) })
    }
})

router.post("/escrow/finish", async (req, res) => {
    try {
        const { owner = XRPL_ACCOUNT, offerSequence, fulfillmentHex, memoHex } = req.body || {}
        if (!(XRPL_ACCOUNT && XRPL_SEED)) return res.status(400).json({ ok: false, code: "missing_keys" })
        if (!owner || offerSequence == null) return res.status(400).json({ ok: false, code: "missing_params" })

        const r = await finishEscrow({
            network: XRPL_NETWORK,
            seed: XRPL_SEED,
            account: XRPL_ACCOUNT,
            owner,
            offerSequence,
            fulfillmentHex,
            memoHex,
            memoType: "ESCROW_FINISH",
        })
        const explorerUrl = r.txHash
            ? XRPL_NETWORK === "mainnet"
                ? `https://livenet.xrpl.org/transactions/${r.txHash}`
                : `https://testnet.xrpl.org/transactions/${r.txHash}`
            : null
        return res.json({ ok: true, ...r, explorerUrl })
    } catch (e) {
        console.error("[escrow/finish] error:", e)
        return res.status(500).json({ ok: false, code: "server_error", msg: String(e) })
    }
})

module.exports = router
