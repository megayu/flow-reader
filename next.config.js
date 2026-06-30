/**
 * @type {import('next').NextConfig}
 **/
const config = {
  output: 'export',
  pageExtensions: ['ts', 'tsx'],
  transpilePackages: ['@flow/epubjs'],
  turbopack: {
    root: __dirname,
  },
}

module.exports = config
