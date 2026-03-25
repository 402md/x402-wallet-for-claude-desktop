# x402-wallet

Give Claude a USDC wallet. Three tools. That's it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![x402](https://img.shields.io/badge/x402-v2-green)](https://x402.org)
[![Base](https://img.shields.io/badge/Base-EVM-3245FF)](https://base.org)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blueviolet)](https://stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io)

---

## What is this?

A minimal [MCP](https://modelcontextprotocol.io) server that gives Claude Desktop a USDC wallet on **Stellar** or **Base**. It adds exactly three tools:

| Tool            | What it does                                                               |
| --------------- | -------------------------------------------------------------------------- |
| `check_balance` | Shows your USDC balance and wallet address                                 |
| `pay`           | Signs an x402 payment and returns the `X-PAYMENT` header                   |
| `x402_fetch`    | Fetches a URL with automatic 402 payment — sign and retry in a single call |

Claude handles everything else — discovering services, reading docs, calling APIs. The wallet just signs payments when needed.

## How it works

```
You ask Claude to use a paid API
        │
        ▼
Claude calls `x402_fetch` with the URL
        │
        ▼
Wallet fetches the endpoint → gets 402 Payment Required
        │
        ▼
Wallet signs USDC authorization automatically
        │
        ▼
Wallet retries with X-PAYMENT header → returns the response
```

Everything happens in a single tool call. No API keys. No accounts. The payment IS the authentication.

## Install

### Claude Desktop (one-click)

Download the latest `x402-wallet.mcpb` from [Releases](https://github.com/402md/x402-wallet-for-claude-desktop/releases) and double-click it. Claude Desktop will prompt for your wallet key and configure everything.

### Manual (claude_desktop_config.json)

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": {
        "STELLAR_SECRET": "S...",
        "NETWORK": "stellar-testnet"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/402md/x402-wallet-for-claude-desktop.git
cd x402-wallet-mcp
npm install
npm run build
```

## Configuration

| Variable          | Default   | Description                                             |
| ----------------- | --------- | ------------------------------------------------------- |
| `STELLAR_SECRET`  | —         | Stellar secret key (starts with `S...`)                 |
| `EVM_PRIVATE_KEY` | —         | EVM private key (starts with `0x...`)                   |
| `NETWORK`         | `stellar` | `stellar`, `stellar-testnet`, `base`, or `base-sepolia` |
| `MAX_PER_CALL`    | `0.10`    | Max USDC per single payment                             |
| `MAX_PER_DAY`     | `20.00`   | Max USDC per calendar day                               |

Set at least one key (`STELLAR_SECRET` or `EVM_PRIVATE_KEY`). Without a key, the wallet runs in read-only mode.

You can also store config in `~/.x402/wallet.json`:

```json
{
  "stellarSecret": "S...",
  "network": "stellar-testnet"
}
```

Environment variables take priority over the wallet file.

## Supported networks

| Network           | Chain           | USDC                     |
| ----------------- | --------------- | ------------------------ |
| `stellar`         | Stellar Pubnet  | Native USDC (7 decimals) |
| `stellar-testnet` | Stellar Testnet | Testnet USDC             |
| `base`            | Base Mainnet    | USDC on L2 (6 decimals)  |
| `base-sepolia`    | Base Sepolia    | Testnet USDC             |

## Budget limits

The wallet enforces spending limits to protect your funds:

- **Per-call limit** — rejects any single payment above `MAX_PER_CALL`
- **Daily limit** — rejects payments that would exceed `MAX_PER_DAY` for the calendar day

Both default to conservative values ($0.10/call, $20/day). Adjust as needed.

## Tools

### `x402_fetch`

Fetches a URL with automatic x402 payment handling. If the server responds 402, the wallet signs the payment and retries — all in one call.

**Parameters:**

| Param     | Type    | Description                          |
| --------- | ------- | ------------------------------------ |
| `url`     | string  | URL to fetch                         |
| `method`  | string? | HTTP method (default: `GET`)         |
| `headers` | object? | Optional HTTP headers                |
| `body`    | string? | Optional request body (for POST/PUT) |

**Returns:**

```json
{
  "status": 200,
  "statusText": "OK",
  "body": "{\"result\": \"paid content\"}",
  "payment": {
    "amount": "0.05 USDC",
    "recipient": "0xABC...",
    "network": "base-sepolia"
  }
}
```

### `check_balance`

Returns your wallet address, USDC balance, network, and mode.

```json
{
  "address": "GABCDEF...",
  "balance": "42.5000000 USDC",
  "network": "stellar-testnet",
  "mode": "STELLAR_ONLY"
}
```

### `pay`

Signs a USDC payment authorization for an x402 endpoint. Use this for manual control — for most cases, prefer `x402_fetch`.

**Parameters:**

| Param       | Type    | Description                           |
| ----------- | ------- | ------------------------------------- |
| `amount`    | string  | USDC amount (e.g. `"0.05"`)           |
| `recipient` | string  | Recipient address (`0x...` or `G...`) |
| `network`   | string  | Payment network                       |
| `resource`  | string? | URL being paid for                    |

**Returns:**

```json
{
  "paymentHeader": "eyJ4NDAy...",
  "amount": "0.05 USDC",
  "recipient": "GABCDEF...",
  "network": "stellar-testnet",
  "hint": "Set this as the X-PAYMENT header in your HTTP request."
}
```

## Development

```bash
# Install
npm install

# Dev (watch mode)
npm run dev

# Build
npm run build

# Test (56 tests)
npm test

# Lint + format
npm run lint
npm run format:fix

# Type check
npm run typecheck

# Build .mcpb extension
npm run build:mcpb
```

### Project structure

```
src/
├── index.ts              # Entry point
├── server.ts             # MCP server + tool registration
├── config.ts             # Env vars + wallet file loading
├── types.ts              # TypeScript interfaces
├── wallet-store.ts       # ~/.x402/wallet.json I/O
├── spending.ts           # Budget tracking
├── clients.ts            # x402 client creation (Stellar/EVM)
└── tools/
    ├── check-balance.ts  # check_balance tool
    ├── pay.ts            # pay tool
    └── x402-fetch.ts     # x402_fetch tool (fetch + auto-pay)
```

### Built on

- [@x402/core](https://github.com/coinbase/x402) — x402 protocol types and client
- [@x402/stellar](https://www.npmjs.com/package/@x402/stellar) — Stellar payment signing
- [@x402/evm](https://www.npmjs.com/package/@x402/evm) — EVM payment signing
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) — MCP server framework

## About x402

[x402](https://x402.org) is an open payment protocol built on HTTP status code 402 (Payment Required). When an agent requests a paid resource, the server responds with `402` and payment requirements. The agent signs a USDC authorization, retries with the `X-PAYMENT` header, and gets the response. No API keys, no subscriptions — the payment is the authentication.

Built by [402.md](https://402.md) — the commerce layer for AI agents.

## License

MIT
