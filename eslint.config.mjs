import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/', 'out/', 'release/', 'tests/electron/**/*.cjs']
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        clearTimeout: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly'
      }
    }
  },
  {
    files: ['app/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  }
)
