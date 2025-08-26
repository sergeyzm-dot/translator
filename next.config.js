/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // было: experimental.serverComponentsExternalPackages
  // стало:
  serverExternalPackages: [
    'pdf-parse',
    'docx',
    'openai',
    'stripe',
  ],

  // swcMinify больше не нужен в Next 15
  // swcMinify: true,  // ← удалить
};

module.exports = nextConfig;