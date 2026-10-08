const nodeExternals = require('webpack-node-externals');

module.exports = (options) => ({
  ...options,
  // Keep the application's native ESM dependencies and Prisma import.meta intact.
  experiments: { outputModule: true },
  output: { ...options.output, module: true, chunkFormat: 'module' },
  externals: [nodeExternals({ importType: 'module' })],
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'swc-loader',
          options: {
            jsc: {
              target: 'es2022',
              parser: { syntax: 'typescript', decorators: true },
              transform: { legacyDecorator: true, decoratorMetadata: true },
            },
            module: { type: 'es6' },
          },
        },
      },
    ],
  },
  resolve: { ...options.resolve, extensions: ['.ts', '.mjs', '.js'] },
});
