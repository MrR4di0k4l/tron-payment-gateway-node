const TronWeb = require('tronweb');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
// Serve files from the public folder (like documents or 404 page)
app.use(express.static(path.join(__dirname, 'public'), { index: "index.html" }));

// --- Settings ---
const PORT = 80;
const DB_SOURCE = "./data/address.db";
const TABLE_NAME = "trx_transactions";
const MAX_WALLETS = 20; // Maximum number of allowed wallets
const ORDER_TIMEOUT_MINUTES = 7; // Duration the wallet remains reserved for the customer (minutes)

// TronGrid API Key (replace if you have one, otherwise leave empty)
// Get it for free at: https://www.trongrid.io/dashboard
const TRON_API_KEY = '5a77e386-93c6-4cfe-b02e-b9667b557462'; 

// Connect to the Mainnet
const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    headers: { "TRON-PRO-API-KEY": TRON_API_KEY }
});

// --- Database ---
const db = new sqlite3.Database(DB_SOURCE, (err) => {
    if (err) console.error('DB Error:', err.message);
    else {
        db.serialize(() => {
            // 1. Create table (for first-time installations)
            db.run(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
                address TEXT PRIMARY KEY,
                privateKey TEXT,
                notifyUrl TEXT,
                collectAddress TEXT,
                extraData TEXT,
                status TEXT DEFAULT 'FREE',
                updated_at INTEGER
            )`);

            // 2. Attempt to add a new column (for updating old database)
            // If the column already exists, it throws an error which we ignore
            // db.run(`ALTER TABLE ${TABLE_NAME} ADD COLUMN updated_at INTEGER`, (err) => {
                // If error occurs, it means the column exists and it's fine
            // });
            
            // 3. Attempt to update default status value (optional)
            // Because in the previous database default status was PENDING and now we need FREE
        });
    }
});

// --- Helper Functions ---


// 1. Free up expired wallets (Cleanup)
function cleanupExpiredOrders() {
    const timeoutTime = Date.now() - (ORDER_TIMEOUT_MINUTES * 60 * 1000);
    
    // If a wallet status is PENDING and time has passed, set it to free
    db.run(`UPDATE ${TABLE_NAME} SET status='FREE', notifyUrl=NULL, extraData=NULL, collectAddress=NULL 
            WHERE status='PENDING' AND updated_at < ?`, [timeoutTime], (err) => {
        if (!err) {
            // console.log("Expired orders cleaned up.");
        }
    });
}

// Check every 1 minute to free expired orders
setInterval(cleanupExpiredOrders, 60 * 1000);


// 2. Smart Fee Calculation
async function getSmartFee() {
    try {
        const params = await tronWeb.trx.getChainParameters();
        const feeParam = params.find(p => p.key === 'getTransactionFee');
        const feePerByte = feeParam ? feeParam.value : 1000;
        return 350 * feePerByte;
    } catch (error) {
        return 400_000;
    }
}

async function sendWebhook(url, data) {
    if (!url) return;
    try {
        const params = new URLSearchParams(data).toString();
        const fullUrl = `${url}?${params}`;
        console.log(`Sending webhook to: ${fullUrl}`);
        await axios.get(fullUrl, { timeout: 10000 });
    } catch (error) {
        console.error('Webhook error:', error.message);
    }
}
// async function sendWebhook(url, data) {
//     if (!url) return;
//     try {
//         console.log(`Sending webhook to: ${url}`);
//         await axios.post(url, data, { timeout: 5000 });
//     } catch (error) {
//         console.error('Webhook error:', error.message);
//     }
// }

// 3. Sweep and Release Wallet Operation
async function sweepWallet(row) {
    const { address, privateKey, collectAddress, notifyUrl, extraData } = row;
    
    // Create a dedicated instance for this wallet to sign the transaction
    const tempWallet = new TronWeb({
        fullHost: 'https://api.trongrid.io',
        headers: { "TRON-PRO-API-KEY": TRON_API_KEY },
        privateKey: privateKey
    });

    try {
        // Get exact balance (SUN)
        const balance = await tempWallet.trx.getBalance(address);
        
        // Precise and dynamic fee calculation
        // const ESTIMATED_FEE = 1_100_000;
        const smartFee = await getSmartFee();

        // If balance is less than fee, do not transfer (not cost-effective)
        if (balance <= smartFee) {
            console.log(`Insufficient balance for sweep: ${address} (${tronWeb.fromSun(balance)} TRX)`);
            db.run(`UPDATE ${TABLE_NAME} SET status='PENDING' WHERE address=?`, [address]);
            return;
        }

        const amountToSend = balance - smartFee;
        console.log(`Sweeping ${tronWeb.fromSun(amountToSend)} TRX from ${address} to ${collectAddress}`);

        // Execute transaction
        const trade = await tempWallet.transactionBuilder.sendTrx(collectAddress, amountToSend, address);
        const signedTx = await tempWallet.trx.sign(trade);
        const receipt = await tempWallet.trx.sendRawTransaction(signedTx);

        if (receipt.result) {
            console.log('Sweep Success TXID:', receipt.txid);
            
            // Notify success
            sendWebhook(notifyUrl, {
                code: 0,
                msg: "SUCCESS",
                type: "COLLECTION",
                txid: receipt.txid,
                amount: tronWeb.fromSun(amountToSend),
                from: address,
                to: collectAddress,
                extra: extraData
            });

            // *** Important change: Instead of deleting, we free the wallet ***
            db.run(`UPDATE ${TABLE_NAME} SET status='FREE', notifyUrl=NULL, extraData=NULL, collectAddress=NULL WHERE address=?`, [address]);
        } else {
            console.error('Sweep Failed:', receipt);
            db.run(`UPDATE ${TABLE_NAME} SET status='PENDING' WHERE address=?`, [address]);
        }
    } catch (error) {
        console.error(`Sweep Error:`, error.message);
        db.run(`UPDATE ${TABLE_NAME} SET status='PENDING' WHERE address=?`, [address]);
    }
}

// --- Blockchain Monitoring ---
let lastBlock = 0;

// Helper function to check if we have any pending customers
function hasPendingOrders() {
    return new Promise((resolve, reject) => {
        // Just check if at least one PENDING record exists
        db.get(`SELECT 1 FROM ${TABLE_NAME} WHERE status='PENDING' LIMIT 1`, (err, row) => {
            if (err) reject(err);
            // If row exists, it returns true (should check), if not false (sleep)
            resolve(!!row);
        });
    });
}

async function monitorBlockchain() {
    try {
        // 1. First step: Check internal database (Cost = Zero)
        const shouldMonitor = await hasPendingOrders();

        if (!shouldMonitor) {
            // If we have no active orders, no need to connect to Tron
            // console.log("System Idle: No pending orders. Sleeping..."); 
            
            // If the system has been idle for a long time, reset lastBlock so it doesn't start from old blocks when it wakes up
            // (Optional: This ensures when a new customer arrives, it starts checking from that moment)
            lastBlock = 0; 
            
            setTimeout(monitorBlockchain, 6000); // Sleep for 6 seconds and check again
            return; 
        }

        // 2. Second step: If we have active orders, connect to the Tron network
        const currentBlockObj = await tronWeb.trx.getCurrentBlock();
        const currentBlockNum = currentBlockObj.block_header.raw_data.number;

        if (lastBlock === 0) {
            lastBlock = currentBlockNum;
        }
        
        // If the block difference is too large (because system was sleeping), update it
        // So it doesn't have to check thousands of old blocks
        if (currentBlockNum - lastBlock > 10) {
             console.log("Resyncing block height...");
             lastBlock = currentBlockNum - 1; // Start from one block before
        }

        if (currentBlockNum > lastBlock) {
            // Check new blocks (Max 5 blocks)
            const range = Math.min(currentBlockNum - lastBlock, 5);
            
            for (let i = 1; i <= range; i++) {
                const blockNum = lastBlock + i;
                const block = await tronWeb.trx.getBlock(blockNum);
                
                if (block.transactions) {
                    for (const tx of block.transactions) {
                        // Only successful transactions
                        if (tx.ret && tx.ret[0].contractRet === 'SUCCESS') {
                            const raw = tx.raw_data.contract[0];
                            
                            // Only TRX transfer transactions (TransferContract)
                            if (raw.type === 'TransferContract') {
                                const val = raw.parameter.value;
                                const toHex = val.to_address;
                                const amount = val.amount;
                                const toAddress = tronWeb.address.fromHex(toHex);

                                // Check only wallets with PENDING status (waiting for deposit)
                                db.get(`SELECT * FROM ${TABLE_NAME} WHERE address = ? AND status='PENDING'`, [toAddress], (err, row) => {
                                    if (row) {
                                        console.log(`Depost Detected: ${tronWeb.fromSun(amount)} TRX -> ${toAddress} (Customer: ${row.extraData})`);
                                        db.run(`UPDATE ${TABLE_NAME} SET status='PROCESSING' WHERE address=?`, [toAddress]);

                                        // Deposit notification
                                        sendWebhook(row.notifyUrl, {
                                            code: 0,
                                            msg: "DEPOSIT_DETECTED",
                                            type: "DEPOSIT",
                                            amount: tronWeb.fromSun(amount),
                                            address: toAddress,
                                            extra: row.extraData
                                        });

                                        // Wait for confirmation then sweep
                                        setTimeout(() => sweepWallet(row), 60000); // 60 seconds delay
                                    }
                                });
                            }
                        }
                    }
                }
            }
            lastBlock += range;
        }
    } catch (e) {
        console.error("Monitor loop error:", e.message);
    }
    setTimeout(monitorBlockchain, 10000); 
}

// Start monitoring
monitorBlockchain();

// --- API Endpoints ---

/**
 * Create new address
 * Parameters: notifyurl, collect_address, extra
 */
app.get('/newAddress', async (req, res) => {
    const { notifyurl, collect_address, extra } = req.query;
    if (!notifyurl || !collect_address) return res.json({ code: 6, msg: "Missing params" });

    // if (!tronWeb.isAddress(collect_address)) {
        //     return res.json({ code: 8, msg: "Invalid collect_address" });
        // }
        
    // 1. First check if we have any free wallets?
    db.get(`SELECT * FROM ${TABLE_NAME} WHERE status='FREE' LIMIT 1`, async (err, row) => {
        if (row) {
            // If a free wallet is found, reserve it
            const now = Date.now();
            db.run(`UPDATE ${TABLE_NAME} SET status='PENDING', notifyUrl=?, collectAddress=?, extraData=?, updated_at=? WHERE address=?`,
                [notifyurl, collect_address, extra, now, row.address],
                (err) => {
                    if (err) return res.json({ code: 500, msg: "DB Update Error" });
                    res.json({ code: 0, msg: "ok", address: row.address, type: "reused" });
                });
        } else {
            // 2. If no free wallet, check if we reached the limit?
            db.get(`SELECT COUNT(*) as count FROM ${TABLE_NAME}`, async (err, result) => {
                if (result.count < MAX_WALLETS) {
                    // Still have space, create one
                    const account = await tronWeb.createAccount();
                    const now = Date.now();
                    db.run(`INSERT INTO ${TABLE_NAME} (address, privateKey, notifyUrl, collectAddress, extraData, status, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
                        [account.address.base58, account.privateKey, notifyurl, collect_address, extra || '', now], 
                        (err) => {
                            if (err) return res.json({ code: 500, msg: "DB Insert Error" });
                            res.json({ code: 0, msg: "ok", address: account.address.base58, type: "new" });
                        });
                } else {
                    // 3. Limit reached and no free wallets available
                    res.json({ code: 503, msg: "No wallet available. Please try again later." });
                }
            });
        }
    });
});



// Check balance
app.get('/balance', async (req, res) => {
    try {
        const bal = await tronWeb.trx.getBalance(req.query.address);
        res.json({ code: 0, msg: "ok", trx: tronWeb.fromSun(bal) });
    } catch (e) { res.json({ code: 500, msg: e.message }); }
});

// Manual sweep (if automatic failed)
app.get('/trans', (req, res) => {
    const { address } = req.query;
    db.get(`SELECT * FROM ${TABLE_NAME} WHERE address = ?`, [address], (err, row) => {
        if (!row) return res.json({ code: 4, msg: "Address not found" });
        // Force status to PROCESSING to perform operation
        db.run(`UPDATE ${TABLE_NAME} SET status='PROCESSING' WHERE address=?`, [address]);
        sweepWallet(row);
        res.json({ code: 0, msg: "ok", info: "Manual sweep triggered" });
    });
});

// 404 Handler for other requests
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/404/index.html'));
});

app.listen(PORT, () => console.log(`Service running on port ${PORT}`));