/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: { instrumentationHook: true, cpus: 2 },
};

export default nextConfig;
