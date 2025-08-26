/** @type {import('next').NextConfig} */
const nextConfig = {
  productionBrowserSourceMaps: false,
  swcMinify: false,

  // Подсказываем Next не тянуть тяжёлые пакеты в RSC-бандл
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', 'docx'],
  },

  webpack: (config, { isServer }) => {
    // 🔧 1) Полностью отключаем файловый кэш webpack (PackFileCacheStrategy)
    //    Это снимает ошибку: [webpack.cache.PackFileCacheStrategy] ... Out of memory
    config.cache = false;

    if (isServer) {
      // 🔧 2) Не бандлим тяжёлые нодовые пакеты в серверный бандл — пусть резолвятся в рантайме
      config.externals = [
        ...(config.externals || []),
        {
          'pdf-parse': 'commonjs pdf-parse',
          'docx': 'commonjs docx',
        },
      ];
    }

    return config;
  },
};

module.exports = nextConfig;