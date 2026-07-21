module.exports = {
  root: true,
  env: {
    node: true,
  },
  extends: [
    'plugin:vue/essential',
    '@vue/airbnb',
  ],
  rules: {
    'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
    'linebreak-style': 'off',
    'no-underscore-dangle': 0,
    'no-console': 'off',
    'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    'prefer-destructuring': ['error', {
      array: false,
      object: true,
    }, {
      enforceForRenamedProperties: false,
    }],
  },
  parserOptions: {
    parser: '@babel/eslint-parser',
  },
};
