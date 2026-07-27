import type { Config } from 'prettier'

export default {
  plugins: ['prettier-plugin-tailwindcss'],
  singleQuote: true,
  semi: false,
  trailingComma: 'all',
} satisfies Config
