const { createBulkOperation, wrapE, getDateFilter } = require("../utils")
const { collections } = require("../db/mongodb")
const { canonicalString, sha256Hex } = require("../utils/poe")
const { submitHashToXRPL } = require("../services/xrplPoe.js")
const XRPL_POE_ENABLED = (process.env.XRPL_POE_ENABLED || "false").toLowerCase() === "true"
const XRPL_NETWORK = process.env.XRPL_NETWORK || "testnet"
const XRPL_ACCOUNT = process.env.XRPL_ACCOUNT || ""
const XRPL_SEED = process.env.XRPL_SEED || ""
const XRPL_DEST_ACCOUNT = process.env.XRPL_DEST_ACCOUNT || "" 

const setStrategyStock = wrapE(async (req, res) => {
    const data = req.body.map(item => ({
        ...item,
        dateAdded: new Date(item.dateAdded),
    }))
    const collection = collections.stock_strategy()
    const bulkOps = await Promise.all(data.map(record => createBulkOperation(record, collection)))
    await collection.bulkWrite(bulkOps)
    for (const record of data) {
        const target = {
            type: record.strategy,
            symbol: record.ticker,
            ts: new Date(record.dateAdded).toISOString(),
            payload: { 
            },
        }
        const canon = canonicalString(target)
        const hash = sha256Hex(canon) 
        const found = await collection.findOne({ korean_name: record.korean_name, dateAdded: record.dateAdded }, { projection: { _id: 1 } })
        if (!found?._id) continue
        await collection.updateOne(
            { _id: found._id },
            {
                $set: {
                    poe: {
                        status: XRPL_POE_ENABLED ? "pending" : "pending",
                        hash,
                        network: XRPL_NETWORK,
                        account: XRPL_ACCOUNT || null,
                        canon,
                        signalId: String(found._id),
                        createdAt: new Date(),
                    },
                },
            }
        )
        if (XRPL_POE_ENABLED && XRPL_ACCOUNT && XRPL_SEED) {
            try {
                const r = await submitHashToXRPL({
                    network: XRPL_NETWORK,
                    seed: XRPL_SEED,
                    account: XRPL_ACCOUNT,
                    hashHex: hash,
                    destinationAccount: XRPL_DEST_ACCOUNT,
                })
                await collection.updateOne(
                    { _id: found._id },
                    {
                        $set: {
                            "poe.status": r.validated ? "on-ledger" : "pending",
                            "poe.txHash": r.txHash,
                            "poe.ledgerIndex": r.ledgerIndex,
                            "poe.memoHex": r.memoHex,
                            "poe.submittedAt": new Date(),
                            "poe.validatedAt": r.validated ? new Date() : null,
                            "poe.explorerUrl": r.txHash
                                ? XRPL_NETWORK === "mainnet"
                                    ? `https://livenet.xrpl.org/transactions/${r.txHash}`
                                    : `https://testnet.xrpl.org/transactions/${r.txHash}`
                                : null,
                        },
                    }
                )
            } catch (e) {
                await collection.updateOne({ _id: found._id }, { $set: { "poe.status": "failed", "poe.error": String(e) } })
            }
            await new Promise(r => setTimeout(r, 400))
        }
    }
    return res.status(200).json({ message: "Data inserted successfully." })
}) 
module.exports = { setStrategyStock }
