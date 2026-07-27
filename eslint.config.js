import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      'react/jsx-key': 'off',
      'react/no-children-prop': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'import/no-anonymous-default-export': 'off',
      'no-empty': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc' },
          'newlines-between': 'always',
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
          ],
          pathGroups: [
            { pattern: '@/**', group: 'internal' },
            { pattern: '@flow/**', group: 'internal' },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
        },
      ],
    },
  },
  prettier,
  globalIgnores(['dist/**', 'release/**', 'build/**']),
])
