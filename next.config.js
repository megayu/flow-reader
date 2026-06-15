const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
})
const withTM = require('next-transpile-modules')([
  '@flow/epubjs',
  '@material/material-color-utilities',
])

/**
 * @type {import('next').NextConfig}
 **/
const config = {
  pageExtensions: ['ts', 'tsx'],
  webpack(config) {
    return config
  },
  i18n: {
    locales: ['en-US', 'zh-CN', 'ja-JP', 'de-DE'],
    defaultLocale: 'en-US',
  },
}

module.exports = withTM(withBundleAnalyzer(config))
