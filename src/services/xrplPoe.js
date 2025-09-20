
async function submitHashToXRPL({ network = "testnet", seed, account, hashHex, destinationAccount }) {
    let xrpl
    try {
        xrpl = require("xrpl")
    } catch (e) {
        return {
            validated: false,
            txHash: null,
            ledgerIndex: null,
            memoHex: (hashHex || "").replace(/^0x/, ""),
            raw: { error: "xrpl_not_installed" },
        }
    }
    const ENDPOINT = {
        testnet: "wss://s.altnet.rippletest.net:51233",
        mainnet: "wss://xrplcluster.com",
    }
    const client = new xrpl.Client(ENDPOINT[network] || ENDPOINT.testnet)
    await client.connect()

    const wallet = xrpl.Wallet.fromSeed(seed)
    if (wallet.address !== account) {
        await client.disconnect()
        throw new Error("Seed/account mismatch")
    }

    const memoHex = (hashHex || "").replace(/^0x/, "")

    const tx = {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: destinationAccount || wallet.address,
        Amount: "1",  
        Memos: [
            {
                Memo: {
                    MemoType: Buffer.from("POE").toString("hex"),
                    MemoData: memoHex,
                },
            },
        ],
    }

    const prepared = await client.autofill(tx)
    const signed = wallet.sign(prepared)
    const res = await client.submitAndWait(signed.tx_blob)

    const validated = !!res?.result?.validated
    const txHash = res?.result?.tx_json?.hash || signed?.hash || null
    const ledgerIndex = res?.result?.validated_ledger_index ?? res?.result?.ledger_index ?? null
 
    try {
        console.info("[XRPL][PoE] submit", {
            network,
            account: wallet.address,
            memoHex,
            txHash,
            validated,
            ledgerIndex,
        })
    } catch {}

    await client.disconnect()

    return { validated, txHash, ledgerIndex, memoHex, raw: res?.result }
}

async function submitMemoPayment({ network = "testnet", seed, account, memoType = "POE", memoHex, destinationAccount, drops = "1" }) {
    let xrpl
    try {
        xrpl = require("xrpl")
    } catch (e) {
        return {
            validated: false,
            txHash: null,
            ledgerIndex: null,
            memoHex: String(memoHex || "").replace(/^0x/, ""),
            raw: { error: "xrpl_not_installed" },
        }
    }
    const ENDPOINT = {
        testnet: "wss://s.altnet.rippletest.net:51233",
        mainnet: "wss://xrplcluster.com",
    }
    const client = new xrpl.Client(ENDPOINT[network] || ENDPOINT.testnet)
    await client.connect()

    const wallet = xrpl.Wallet.fromSeed(seed)
    if (wallet.address !== account) {
        await client.disconnect()
        throw new Error("Seed/account mismatch")
    }

    const memoData = String(memoHex || "").replace(/^0x/, "")
    const tx = {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: destinationAccount || wallet.address,
        Amount: String(drops),
        Memos: [
            {
                Memo: {
                    MemoType: Buffer.from(String(memoType || "POE")).toString("hex"),
                    MemoData: memoData,
                },
            },
        ],
    }

    const prepared = await client.autofill(tx)
    const signed = wallet.sign(prepared)
    const res = await client.submitAndWait(signed.tx_blob)

    const validated = !!res?.result?.validated
    const txHash = res?.result?.tx_json?.hash || signed?.hash || null
    const ledgerIndex = res?.result?.validated_ledger_index ?? res?.result?.ledger_index ?? null

    try {
        console.info("[XRPL][MemoPayment] submit", {
            network,
            account: wallet.address,
            memoType,
            memoData,
            txHash,
            validated,
            ledgerIndex,
        })
    } catch {}

    await client.disconnect()

    return { validated, txHash, ledgerIndex, memoHex: memoData, raw: res?.result }
}

function toRippleTime(unixSeconds) {
    return Math.floor(unixSeconds) - 946684800
}

async function createEscrow({ network = "testnet", seed, account, destination, amountDrops, cancelAfterSec, finishAfterSec, conditionHex, memoHex, memoType = "ESCROW" }) {
    let xrpl
    try {
        xrpl = require("xrpl")
    } catch (e) {
        return { validated: false, txHash: null, ledgerIndex: null, offerSequence: null, raw: { error: "xrpl_not_installed" } }
    }

    const ENDPOINT = { testnet: "wss://s.altnet.rippletest.net:51233", mainnet: "wss://xrplcluster.com" }
    const client = new xrpl.Client(ENDPOINT[network] || ENDPOINT.testnet)
    await client.connect()

    const wallet = xrpl.Wallet.fromSeed(seed)
    if (wallet.address !== account) {
        await client.disconnect()
        throw new Error("Seed/account mismatch")
    }

    const nowUnix = Date.now() / 1000
    const tx = {
        TransactionType: "EscrowCreate",
        Account: wallet.address,
        Destination: destination,
        Amount: String(amountDrops),
        ...(cancelAfterSec ? { CancelAfter: toRippleTime(nowUnix + Number(cancelAfterSec)) } : {}),
        ...(finishAfterSec ? { FinishAfter: toRippleTime(nowUnix + Number(finishAfterSec)) } : {}),
        ...(conditionHex ? { Condition: String(conditionHex).replace(/^0x/, "") } : {}),
        ...(memoHex
            ? {
                  Memos: [
                      {
                          Memo: {
                              MemoType: Buffer.from(memoType).toString("hex"),
                              MemoData: String(memoHex).replace(/^0x/, ""),
                          },
                      },
                  ],
              }
            : {}),
    }

    const prepared = await client.autofill(tx)
    const signed = wallet.sign(prepared)
    const res = await client.submitAndWait(signed.tx_blob)

    const validated = !!res?.result?.validated
    const txHash = res?.result?.tx_json?.hash || signed?.hash || null
    const ledgerIndex = res?.result?.validated_ledger_index ?? res?.result?.ledger_index ?? null
    const offerSequence = res?.result?.tx_json?.Sequence ?? prepared?.Sequence ?? null

    try {
        console.info("[XRPL][EscrowCreate] submit", { network, account: wallet.address, txHash, validated, ledgerIndex, offerSequence })
    } catch {}

    await client.disconnect()

    return { validated, txHash, ledgerIndex, offerSequence, raw: res?.result }
}

async function finishEscrow({ network = "testnet", seed, account, owner, offerSequence, fulfillmentHex, memoHex, memoType = "ESCROW_FINISH" }) {
    let xrpl
    try {
        xrpl = require("xrpl")
    } catch (e) {
        return { validated: false, txHash: null, ledgerIndex: null, raw: { error: "xrpl_not_installed" } }
    }

    const ENDPOINT = { testnet: "wss://s.altnet.rippletest.net:51233", mainnet: "wss://xrplcluster.com" }
    const client = new xrpl.Client(ENDPOINT[network] || ENDPOINT.testnet)
    await client.connect()

    const wallet = xrpl.Wallet.fromSeed(seed)
    if (wallet.address !== account) {
        await client.disconnect()
        throw new Error("Seed/account mismatch")
    }

    const tx = {
        TransactionType: "EscrowFinish",
        Account: wallet.address,
        Owner: owner,
        OfferSequence: Number(offerSequence),
        ...(fulfillmentHex ? { Fulfillment: String(fulfillmentHex).replace(/^0x/, "") } : {}),
        ...(memoHex
            ? {
                  Memos: [
                      {
                          Memo: {
                              MemoType: Buffer.from(memoType).toString("hex"),
                              MemoData: String(memoHex).replace(/^0x/, ""),
                          },
                      },
                  ],
              }
            : {}),
    }

    const prepared = await client.autofill(tx)
    const signed = wallet.sign(prepared)
    const res = await client.submitAndWait(signed.tx_blob)

    const validated = !!res?.result?.validated
    const txHash = res?.result?.tx_json?.hash || signed?.hash || null
    const ledgerIndex = res?.result?.validated_ledger_index ?? res?.result?.ledger_index ?? null

    try {
        console.info("[XRPL][EscrowFinish] submit", { network, account: wallet.address, txHash, validated, ledgerIndex })
    } catch {}

    await client.disconnect()

    return { validated, txHash, ledgerIndex, raw: res?.result }
}

module.exports = { submitHashToXRPL, submitMemoPayment, createEscrow, finishEscrow }
