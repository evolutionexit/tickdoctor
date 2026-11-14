import type { NextConfig } from "next";

const apiUrl = (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@tickdoctor/shared"],
  poweredByHeader: false,
  outputFileTracingIncludes: { "/s/[slug]/opengraph-image": ["./assets/fonts/**"], "/og/[...slug]": ["./assets/fonts/**", "./content/**"] },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
    ];
  },
};

export default config;
