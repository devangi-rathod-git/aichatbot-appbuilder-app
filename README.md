# Viha Digital Commerce — AI Chatbot

An Adobe App Builder application that provides an AI-powered chatbot for Adobe Commerce storefronts. It supports product search via vector embeddings (Qdrant), order tracking, and live chat — compatible with both **PaaS** (self-hosted) and **SaaS** (Adobe Cloud) Adobe Commerce instances.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [PaaS Authentication (Self-Hosted Commerce)](#paas-authentication-self-hosted-commerce)
  - [SaaS Authentication (Adobe Cloud Commerce)](#saas-authentication-adobe-cloud-commerce)
- [Local Development](#local-development)
- [Testing](#testing)
- [Deploy & Cleanup](#deploy--cleanup)
- [App Actions Overview](#app-actions-overview)

---

## Prerequisites

- [Adobe Developer Console](https://developer.adobe.com/console) access
- [AIO CLI](https://developer.adobe.com/app-builder/docs/getting_started/) installed: `npm install -g @adobe/aio-cli`
- An Adobe Commerce instance (PaaS or SaaS)
- OpenAI API key
- Qdrant vector database URL (for product search)

---

## Installation

1. Clone this repository
2. Run `npm install`
3. Run `aio app use` to link your Adobe Developer Console project
4. Populate the `.env` file (see [Configuration](#configuration) below)
5. Run `aio app deploy`

---

## Configuration

All configuration is provided via environment variables in your `.env` file, or via the **App Configuration UI** when installing from Adobe Exchange.

### Required for all deployments

| Variable | Description |
|---|---|
| `COMMERCE_BASE_URL` | Base URL of your Adobe Commerce instance. **PaaS format:** `https://mystore.example.com/rest/` — **SaaS format:** `https://na1-sandbox.api.commerce.adobe.com/<tenant-id>/` |

---

### COMMERCE_BASE_URL Format

The format of `COMMERCE_BASE_URL` differs between PaaS and SaaS:

**For PaaS (On-Premise/Cloud):**
```
COMMERCE_BASE_URL=https://<environment-name>.us-4.magentosite.cloud/rest/
```

**For SaaS (Adobe Commerce as a Cloud Service):**
```
COMMERCE_BASE_URL=https://na1-sandbox.api.commerce.adobe.com/<tenant-id>/
```

---

### PaaS Authentication (Self-Hosted Commerce)

If you run Adobe Commerce on-premises (PaaS), the app can still use an admin
integration access token via `COMMERCE_ACCESS_TOKEN`. However, configuration
is now primarily managed via `app.commerce.config.ts` (`businessConfig.schema`) and
the App Management UI. Use the App Configuration UI or set environment variables
directly to supply `COMMERCE_BASE_URL` and `COMMERCE_ACCESS_TOKEN` when needed.

For SaaS (recommended) use IMS OAuth credentials — see the **SaaS Authentication**
section below for Developer Console steps.

---

### SaaS Authentication (Adobe Cloud Commerce)

If you are running **Adobe Commerce as a Cloud Service (SaaS)**, authentication uses **Adobe IMS OAuth 2.0 client credentials** instead of a static token.

The app automatically detects which mode to use:
- If `IMS_CLIENT_ID` + `IMS_CLIENT_SECRET` are set → uses IMS (SaaS mode)
- If only `COMMERCE_ACCESS_TOKEN` is set → uses it directly (PaaS mode)

**How to obtain IMS credentials:**

1. Go to [Adobe Developer Console](https://developer.adobe.com/console)
2. Create a new **Project** (or use an existing one)
3. Click **Add API** → select **Adobe Commerce as a Cloud Service** → click **Next**
4. Select **OAuth Server-to-Server** as the credential type
5. Click **Save configured API**
6. From the credential page, copy:
   - **Client ID** → use as `IMS_CLIENT_ID`
   - **Client Secret** → use as `IMS_CLIENT_SECRET`
   - **Organization ID** → use as `IMS_ORG_ID` (shown as `XXXXX@AdobeOrg`)

Set in your `.env`:
```bash
COMMERCE_BASE_URL=https://na1-sandbox.api.commerce.adobe.com/<tenant-id>/
IMS_CLIENT_ID=your_client_id_here
IMS_CLIENT_SECRET=your_client_secret_here
IMS_ORG_ID=XXXXX@AdobeOrg
```

Leave `COMMERCE_ACCESS_TOKEN` empty for SaaS.

> **Note:** IMS tokens are short-lived (~24 hours). The app fetches a fresh token automatically on each action invocation — no manual refresh is needed.

---

### Additional Settings (configured in-app UI)

Once deployed, open the app UI and go to **Settings** to configure:

| Setting | Description |
|---|---|
| `openaiKey` | Your OpenAI API key (used for chat completions and embeddings) |
| `vectorDbUrl` | Your Qdrant instance URL (used for product vector search) |
| `productAttributes` | Comma-separated Adobe Commerce attribute codes to index (e.g. `color,size,material`) |
| `productLimit` | Max number of products to return per search (default: 5) |
| `chatbotEmail` | Support email shown in chat responses |
| `chatbotWhatsapp` | WhatsApp number shown in chat responses |

---

### `.env` file reference

```bash
# Adobe I/O Runtime credentials (required)
AIO_RUNTIME_AUTH=your_runtime_auth
AIO_RUNTIME_NAMESPACE=your_namespace

# Adobe Commerce Base URL (required)
# For SaaS (Cloud): https://na1-sandbox.api.commerce.adobe.com/<tenant-id>/
# For PaaS (self-hosted): https://<your-host>/rest/
COMMERCE_BASE_URL=

# SaaS (recommended): IMS OAuth credentials
IMS_CLIENT_ID=
IMS_CLIENT_SECRET=
IMS_ORG_ID=
IMS_AUTH_HOST=https://ims-na1.adobelogin.com

# PaaS (optional fallback) — leave empty when using SaaS
COMMERCE_ACCESS_TOKEN=

# Third-party services
OPENAI_KEY=
VECTOR_DB_URL=
VECTOR_DB_API_KEY=
```

---

## Local Development

```bash
# Start local dev server (actions run on Adobe I/O Runtime, UI runs locally)
aio app run

# Run actions fully locally
aio app dev
```

App runs at `http://localhost:9080` by default.

For more on the difference between `aio app run` and `aio app dev`, see the [App Builder docs](https://developer.adobe.com/app-builder/docs/guides/development/#aio-app-dev-vs-aio-app-run).

---

## Testing

```bash
# Run unit tests
aio app test

# Run end-to-end tests
aio app test --e2e
```

Unit tests cover:
- `utils.js` — shared helpers including `getCommerceToken` (PaaS and SaaS paths)
- `sync-validate` — credential validation for both auth modes
- `sync-start` / `sync-chunk` / `sync-status` — product sync pipeline
- `aichatbot` — chat intent routing and response generation

---

## Deploy & Cleanup

```bash
# Deploy all actions and static files
aio app deploy

# Remove all deployed resources
aio app undeploy
```

---

## App Actions Overview

| Action | Description |
|---|---|
| `aichatbot` | Main chat action — handles intent detection, product search, order tracking |
| `sync-validate` | Validates all prerequisites before starting a product sync |
| `sync-start` | Initiates a product sync job and stores progress in Adobe I/O State |
| `sync-chunk` | Processes one page of products and upserts embeddings into Qdrant |
| `sync-status` | Returns current sync progress |

All actions support both PaaS and SaaS authentication transparently via the shared `getCommerceToken()` utility in `actions/utils.js`.