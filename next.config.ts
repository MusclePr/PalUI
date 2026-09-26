import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";

const nextConfig: NextConfig = {
  basePath,
  output: "standalone",
  async redirects() {
    return [
      // basePath を付けずにルートへアクセスした場合、basePath 配下へ転送する。
      {
        source: "/",
        destination: basePath,
        basePath: false,
        permanent: false,
      },
    ];
  },
};

export default nextConfig;