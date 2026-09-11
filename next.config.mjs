/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ensure proper trailing slash handling
  trailingSlash: false,

  // Output configuration
  output: 'standalone',
};

export default nextConfig;
