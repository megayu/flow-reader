/**
 * @type {import('next').NextConfig}
 **/
const config = {
  output: 'export',
  pageExtensions: ['ts', 'tsx'],
  transpilePackages: ['@flow/epubjs', '@material/material-color-utilities'],
  turbopack: {
    root: __dirname,
  },
}

module.exports = config
