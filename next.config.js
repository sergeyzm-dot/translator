/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  serverExternalPackages: [
    'pdf-parse',
    'docx',
    'openai',
    'stripe',
    'pdfjs-dist' // <-- добавлено, чтобы pdfjs не бандлился в клиент
  ],

  // swcMinify больше не нужен в Next 15
  // swcMinify: true,
};

module.exports = nextConfig;