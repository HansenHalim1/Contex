import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const APP_ORIGIN = process.env.NEXT_PUBLIC_BASE_URL || "https://contex-akxn.vercel.app";

const ContentSecurityPolicy = `
  default-src 'self';
  script-src 'self' https://cdn.monday.com https://cdn1.monday.com https://cdn-static.monday.com https://static.monday.com https://*.monday.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://files.monday.com https://cdn.monday.com https://cdn1.monday.com https://cdn-static.monday.com;
  font-src 'self';
  connect-src 'self' https://*.supabase.co https://*.supabase.in https://*.monday.com wss://*.monday.com;
  frame-src https://*.monday.com https://js.stripe.com;
  frame-ancestors 'self' https://*.monday.com;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
`.replace(/\s{2,}/g, " ").trim();

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: ContentSecurityPolicy
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload"
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin"
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()"
  },
  {
    key: "Access-Control-Allow-Origin",
    value: APP_ORIGIN
  },
  {
    key: "Access-Control-Allow-Methods",
    value: "GET,POST,PUT,DELETE,OPTIONS"
  },
  {
    key: "Access-Control-Allow-Headers",
    value: "Authorization, Content-Type, x-monday-signature"
  },
  {
    key: "Access-Control-Allow-Credentials",
    value: "true"
  }
];

const nextConfig = {
  webpack(config) {
    config.resolve.alias["@"] = path.resolve(__dirname);
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders
      }
    ];
  }
};

export default nextConfig;
