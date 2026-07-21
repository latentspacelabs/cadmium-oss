const path = require('path');

module.exports = {
  presets: [
    '@vue/app',
  ],
  overrides: [
    {
      include: [
        path.resolve(__dirname, 'node_modules/nucleus-analytics'),
      ],
      presets: ['@babel/preset-env'],
    },
  ],
};
