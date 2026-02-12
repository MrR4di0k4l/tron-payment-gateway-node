
# TRON (TRX) Payment Gateway Service
> A lightweight, Dockerized Node.js service for accepting TRX payments with wallet rotation and auto-sweep features.

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[**<a href="https://github.com/MrR4di0k4l/tron-payment-gateway-node/blob/main/README.md">English</a>**] | [**<a href="https://github.com/MrR4di0k4l/tron-payment-gateway-node/blob/main/README_FA.md">Persion</a>**]

---

## English Documentation

### 🌟 Features
* **Native TRX Support:** Designed specifically for TRON (TRX) transactions.
* **Wallet Rotation (Pool System):** Efficient management of wallets (default: 20 max) to prevent generating infinite unused addresses.
* **Auto-Recycling:** Unused wallets are automatically freed up after a timeout (default: 7 minutes) and reused for new customers.
* **Auto-Sweep:** Automatically detects deposits and instantly forwards funds to your main (cold) wallet.
* **Smart Fee Calculation:** Dynamically calculates network fees to ensure successful transfers without overpaying.
* **Webhook Notifications:** Sends HTTP GET requests to your server upon deposit detection and successful collection.
* **Dockerized:** Simple and fast deployment using Docker and Docker Compose.
* **Persistent Data:** Uses SQLite to securely store wallet states and private keys locally.

### 🚀 Installation & Setup

#### Prerequisites
* Docker & Docker Compose installed.
* A TronGrid API Key (Recommended for higher rate limits).

#### 1. Configuration
Open `app.js` and configure your settings to match your needs:

```javascript
// app.js settings
const MAX_WALLETS = 20;            // Maximum number of wallets in the pool
const ORDER_TIMEOUT_MINUTES = 7;   // Time (in minutes) before a pending wallet is freed
const TRON_API_KEY = 'YOUR_API_KEY'; // Get free key from [https://trongrid.io](https://trongrid.io)

```

#### 2. Run with Docker

Build and start the container in the background:

```bash
docker-compose up -d --build

```

The service will start on port **3000** (mapped to port 80 inside the container).

### 🛠️ API Documentation

#### 1. Generate/Reserve Payment Address

Assigns a wallet from the pool to a user. If a free wallet exists, it reuses it; otherwise, it creates a new one (up to the limit).

* **Endpoint:** `GET /newAddress`
* **Parameters:**
* `notifyurl`: Your server URL to receive callbacks.
* `collect_address`: Your main wallet address (where funds will be swept to).
* `extra`: (Optional) User ID, Order ID, or any custom data.


* **Example:**
```
http://localhost:3000/newAddress?notifyurl=https://mysite.com/callback&collect_address=TZ...&extra=order123

```


* **Response:**
```json
{
  "code": 0,
  "msg": "ok",
  "address": "T...",
  "type": "new" // or "reused"
}

```



#### 2. Check Balance

Check the current balance of a managed wallet.

* **Endpoint:** `GET /balance`
* **Parameters:** `address`
* **Example:** `http://localhost:3000/balance?address=TZ...`

#### 3. Manual Sweep

Force triggers the sweep process for a specific address (useful if the auto-sweep misses a transaction).

* **Endpoint:** `GET /trans`
* **Parameters:** `address`

### QC Webhook Structure

The system sends a `GET` request to your `notifyurl` with the following query parameters:

* `code`: `0` (Success)
* `msg`: `"DEPOSIT_DETECTED"` or `"SUCCESS"`
* `type`:
* `"DEPOSIT"`: When a user deposit is detected.
* `"COLLECTION"`: When funds are successfully moved to your main wallet.


* `amount`: Amount in TRX.
* `txid`: Transaction Hash on the blockchain.
* `from`: The temporary wallet address.
* `to`: Your main wallet address.
* `extra`: The custom data you passed during address generation.

