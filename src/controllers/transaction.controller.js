const transactionModel = require("../models/transaction.model")
const ledgerModel = require("../models/ledger.model")
const accountModel = require("../models/account.model")
const emailService = require("../services/email.service")
const mongoose = require("mongoose")

class InsufficientBalanceError extends Error {}
class AccountUnavailableError extends Error {}
class DuplicateRequestError extends Error {}

function sameRequest(transaction, { fromAccount, toAccount, amount }) {
    return String(transaction.fromAccount) === String(fromAccount)
        && String(transaction.toAccount) === String(toAccount)
        && Number(transaction.amount) === Number(amount)
}

async function returnExistingTransaction(idempotencyKey, request, res) {
    const existing = await transactionModel.findOne({ idempotencyKey })
    if (!existing) return false

    if (!sameRequest(existing, request)) {
        res.status(409).json({ message: "Idempotency key was already used for a different transaction" })
        return true
    }

    if (existing.status === "COMPLETED") {
        res.status(200).json({ message: "Transaction already processed", transaction: existing })
    } else {
        res.status(409).json({ message: "Transaction with this idempotency key is not complete; retry with the same key" })
    }
    return true
}

async function completeLedgerTransaction({ fromAccount, toAccount, amount, idempotencyKey, senderUserId }) {
    const session = await mongoose.startSession()
    let transaction

    try {
        await session.withTransaction(async () => {
            // Every debit writes the sender account in this transaction. Concurrent
            // debits therefore conflict and retry against the newly committed ledger.
            const senderFilter = { _id: fromAccount, status: "ACTIVE" }
            if (senderUserId) senderFilter.user = senderUserId
            const lockResult = await accountModel.updateOne(
                senderFilter,
                { $inc: { ledgerSequence: 1 } },
                { session }
            )
            if (lockResult.matchedCount !== 1) throw new AccountUnavailableError("Sender account is no longer active")

            const sender = await accountModel.findById(fromAccount).session(session)
            const recipient = await accountModel.findOne({ _id: toAccount, status: "ACTIVE" }).session(session)
            if (!sender || !recipient) throw new AccountUnavailableError("A transaction account is no longer active")
            if (sender._id.equals(recipient._id)) throw new AccountUnavailableError("Sender and receiver accounts must be different")

            // Recheck after acquiring the sender write lock. This closes the race
            // where two copies both passed the initial idempotency lookup.
            const existing = await transactionModel.findOne({ idempotencyKey }).session(session)
            if (existing) {
                if (!sameRequest(existing, { fromAccount, toAccount, amount })) {
                    throw new DuplicateRequestError("Idempotency key was already used for a different transaction")
                }
                throw new DuplicateRequestError("Transaction already processed")
            }

            if (senderUserId) {
                const balance = await sender.getBalance(session)
                if (balance < amount) throw new InsufficientBalanceError(`Insufficient balance. Current balance is ${balance}. Requested amount is ${amount}`)
            }

            transaction = new transactionModel({
                fromAccount,
                toAccount,
                amount,
                idempotencyKey,
                status: "PENDING"
            })
            await transaction.save({ session })

            await ledgerModel.create([
                { account: fromAccount, amount, transaction: transaction._id, type: "DEBIT" },
                { account: toAccount, amount, transaction: transaction._id, type: "CREDIT" }
            ], { session, ordered: true })

            transaction.status = "COMPLETED"
            await transaction.save({ session })
        })
        return transaction
    } finally {
        await session.endSession()
    }
}

function isDuplicateKeyError(error) {
    return error?.code === 11000 || error?.keyPattern?.idempotencyKey === 1
}

async function respondToTransactionError(error, idempotencyKey, request, res) {
    // A concurrent copy of this same request may have committed while this
    // attempt was retrying its account write.
    if (await returnExistingTransaction(idempotencyKey, request, res)) return
    if (isDuplicateKeyError(error)) {
        return res.status(409).json({ message: "A request with this idempotency key is being processed; retry with the same key" })
    }
    if (error instanceof InsufficientBalanceError) return res.status(400).json({ message: error.message })
    if (error instanceof AccountUnavailableError) return res.status(400).json({ message: error.message })
    if (error instanceof DuplicateRequestError) return res.status(409).json({ message: error.message })

    console.error("Transaction failed:", error)
    return res.status(500).json({ message: "Transaction could not be completed; retry with the same idempotency key" })
}

async function createTransaction(req, res) {
    const { fromAccount, toAccount, amount, idempotencyKey } = req.body
    if (!fromAccount || !toAccount || amount === undefined || !idempotencyKey) {
        return res.status(400).json({ message: "FromAccount, toAccount, amount and idempotencyKey are required" })
    }

    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" })
    }
    const request = { fromAccount, toAccount, amount: numericAmount }
    if (!mongoose.isValidObjectId(fromAccount) || !mongoose.isValidObjectId(toAccount)) {
        return res.status(400).json({ message: "Invalid fromAccount or toAccount" })
    }

    const fromUserAccount = await accountModel.findOne({ _id: fromAccount, user: req.user._id })
    const toUserAccount = await accountModel.findById(toAccount)
    if (!fromUserAccount || !toUserAccount) {
        return res.status(400).json({ message: "Invalid fromAccount or toAccount" })
    }
    if (await returnExistingTransaction(idempotencyKey, request, res)) return
    if (String(fromAccount) === String(toAccount)) {
        return res.status(400).json({ message: "Sender and receiver accounts must be different" })
    }
    if (fromUserAccount.status !== "ACTIVE" || toUserAccount.status !== "ACTIVE") {
        return res.status(400).json({ message: "Both fromAccount and toAccount must be ACTIVE to process transaction" })
    }

    let transaction
    try {
        transaction = await completeLedgerTransaction({
            ...request,
            idempotencyKey,
            senderUserId: req.user._id
        })
    } catch (error) {
        return respondToTransactionError(error, idempotencyKey, request, res)
    }

    // A notification failure must not make a committed transfer look retryable.
    try {
        await emailService.sendTransactionEmail(req.user.email, req.user.name, numericAmount, toAccount)
    } catch (error) {
        console.error("Transaction committed, but email notification failed:", error)
    }

    return res.status(201).json({ message: "Transaction completed successfully", transaction })
}

async function createInitialFundsTransaction(req, res) {
    const { toAccount, amount, idempotencyKey } = req.body
    if (!toAccount || amount === undefined || !idempotencyKey) {
        return res.status(400).json({ message: "toAccount, amount and idempotencyKey are required" })
    }

    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" })
    }

    const fromUserAccount = await accountModel.findOne({ user: req.user._id })
    if (!fromUserAccount) return res.status(400).json({ message: "System user account not found" })

    const request = { fromAccount: fromUserAccount._id, toAccount, amount: numericAmount }
    if (await returnExistingTransaction(idempotencyKey, request, res)) return

    const toUserAccount = await accountModel.findById(toAccount)
    if (!toUserAccount) return res.status(400).json({ message: "Invalid toAccount" })
    if (fromUserAccount.status !== "ACTIVE" || toUserAccount.status !== "ACTIVE") {
        return res.status(400).json({ message: "Both funding accounts must be ACTIVE" })
    }
    if (String(fromUserAccount._id) === String(toUserAccount._id)) {
        return res.status(400).json({ message: "System funding source and target account must be different" })
    }

    try {
        const transaction = await completeLedgerTransaction({
            ...request,
            idempotencyKey
        })
        return res.status(201).json({ message: "Initial funds transaction completed successfully", transaction })
    } catch (error) {
        return respondToTransactionError(error, idempotencyKey, request, res)
    }
}

module.exports = { createTransaction, createInitialFundsTransaction }
