/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseStorageUrl = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_URL;
    const parsedSupabaseUrl = supabaseUrl ? new URL(supabaseUrl) : null;
    const supabaseOrigin = parsedSupabaseUrl?.origin ?? "";
    const supabaseWebSocket = parsedSupabaseUrl ? `wss://${parsedSupabaseUrl.host}` : "";
    const derivedStorageOrigin = parsedSupabaseUrl?.hostname.endsWith(".supabase.co")
      ? `${parsedSupabaseUrl.protocol}//${parsedSupabaseUrl.hostname.replace(".supabase.co", ".storage.supabase.co")}`
      : "";
    const storageOrigin = supabaseStorageUrl ? new URL(supabaseStorageUrl).origin : derivedStorageOrigin;
    const connectSources = ["'self'", supabaseOrigin, supabaseWebSocket, storageOrigin, "https://api.openai.com", "https://api.elevenlabs.io"].filter(Boolean).join(" ");
    const imgSources = ["'self'", "data:", "blob:", supabaseOrigin].filter(Boolean).join(" ");
    const mediaSources = ["'self'", "data:", "blob:", "https:"].join(" ");

    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      `connect-src ${connectSources}`,
      `img-src ${imgSources}`,
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      `media-src ${mediaSources}`,
      "object-src 'none'",
      "upgrade-insecure-requests"
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"
          }
        ]
      }
    ];
  }
};

export default nextConfig;
