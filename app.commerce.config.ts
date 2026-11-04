// Commerce version constraints: minVersion 2.4.5 · maxVersion 3.0.0
import { defineConfig } from "@adobe/aio-commerce-lib-app/config";

export default defineConfig({
  metadata: {
    id: "ai-commerce-chatbot",
    displayName: "AI Commerce Chatbot",
    description:
      "AI-powered chatbot for Adobe Commerce storefronts, with product sync and live chat support for PaaS and SaaS deployments.",
    version: "0.0.1",
  },
  businessConfig: {
    schema: [
      {
        type: "text",
        name: "COMMERCE_BASE_URL",
        label: "Adobe Commerce Base URL",
        description:
          "Base URL for your Adobe Commerce instance. For PaaS, include /rest/ suffix; for SaaS, use the Adobe Commerce Cloud REST endpoint.",
      },
      {
        type: "password",
        name: "COMMERCE_ACCESS_TOKEN",
        label: "Adobe Commerce Access Token",
        description: "Required for self-hosted Adobe Commerce.",
        env: ["paas"],
      },
      {
        type: "text",
        name: "IMS_CLIENT_ID",
        label: "IMS Client ID",
        description: "Adobe IMS OAuth client ID for SaaS Commerce authentication.",
        env: ["saas"],
      },
      {
        type: "password",
        name: "IMS_CLIENT_SECRET",
        label: "IMS Client Secret",
        description: "Adobe IMS OAuth client secret for SaaS Commerce authentication.",
        env: ["saas"],
      },
      {
        type: "text",
        name: "IMS_ORG_ID",
        label: "IMS Organization ID",
        description: "Adobe IMS organization ID for SaaS Commerce authentication.",
        env: ["saas"],
      },
      {
        type: "text",
        name: "IMS_AUTH_HOST",
        label: "IMS Auth Host",
        description:
          "Optional Adobe IMS host for SaaS token requests. Defaults to https://ims-na1.adobelogin.com.",
        env: ["saas"],
      },
      {
        type: "password",
        name: "openaiKey",
        label: "OpenAI API Key",
        description: "API key used for OpenAI chat completions and embeddings.",
      },
      {
        type: "url",
        name: "vectorDbUrl",
        label: "Vector DB URL",
        description: "URL of your Qdrant vector database instance.",
      },
      {
        type: "password",
        name: "vectorDbApiKey",
        label: "Vector DB API Key",
        description: "API key for authenticating to your Qdrant vector database.",
      },
    ],
  },
});