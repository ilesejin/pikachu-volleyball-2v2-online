const path = require('path');
const { ClientVersionPlugin } = require('./scripts/client-version.cjs');
const { OfflineEnginePlugin } = require('./scripts/sync-offline-engine.cjs');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  entry: {
    main: './src/resources/js/main_online_2v2.js',
    ko: './src/ko/ko.js',
    main_replay: './src/resources/js/replay/main_replay.js',
    main_update_history:
      './src/resources/js/update_history/main_update_history.js',
    dark_color_scheme:
      './src/resources/js/offline_version_js/utils/dark_color_scheme.js',
  },
  output: {
    filename: '[name].[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
  },
  optimization: {
    runtimeChunk: { name: 'runtime' }, // Share runtime across game, replay, and localization entries.
    splitChunks: {
      chunks: 'all',
    },
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  plugins: [
    new OfflineEnginePlugin(),
    new ClientVersionPlugin(),
    new CleanWebpackPlugin(),
    new CopyPlugin({
      patterns: [
        {
          context: 'src/',
          from: 'resources/assets/**/*.+(json|png|mp3|wav)',
        },
        { from: 'src/index.html', to: 'index.html' },
        { from: 'src/replay/index.html', to: 'replay/index.html' },
      ],
    }),
    new MiniCssExtractPlugin({
      filename: '[name].[contenthash].css',
      chunkFilename: '[id].[contenthash].css',
    }),
    new HtmlWebpackPlugin({
      template: 'src/en/index.html',
      filename: 'en/index.html',
      chunks: ['runtime', 'main'],
      chunksSortMode: 'manual',
      minify: {
        collapseWhitespace: true,
        removeComments: true,
      },
    }),
    new HtmlWebpackPlugin({
      template: 'src/ko/index.html',
      filename: 'ko/index.html',
      chunks: ['runtime', 'main'],
      chunksSortMode: 'manual',
      minify: {
        collapseWhitespace: true,
        removeComments: true,
      },
    }),
    new HtmlWebpackPlugin({
      template: 'src/zh/index.html',
      filename: 'zh/index.html',
      chunks: ['runtime', 'main'],
      chunksSortMode: 'manual',
      minify: { collapseWhitespace: true, removeComments: true },
    }),
    new HtmlWebpackPlugin({
      template: 'src/zh/update-history/index.html',
      filename: 'zh/update-history/index.html',
      chunks: ['main_update_history', 'dark_color_scheme'],
      chunksSortMode: 'manual',
      minify: { collapseWhitespace: true, removeComments: true },
    }),
    new HtmlWebpackPlugin({
      template: 'src/en/replay/index.html',
      filename: 'en/replay/index.html',
      chunks: ['runtime', 'main_replay', 'dark_color_scheme'],
      chunksSortMode: 'manual',
      minify: {
        collapseWhitespace: true,
        removeComments: true,
      },
    }),
    new HtmlWebpackPlugin({
      template: 'src/ko/replay/index.html',
      filename: 'ko/replay/index.html',
      chunks: ['runtime', 'ko', 'main_replay', 'dark_color_scheme'],
      chunksSortMode: 'manual',
      minify: {
        collapseWhitespace: true,
        removeComments: true,
      },
    }),
    new HtmlWebpackPlugin({
      template: 'src/zh/replay/index.html',
      filename: 'zh/replay/index.html',
      chunks: ['runtime', 'main_replay', 'dark_color_scheme'],
      chunksSortMode: 'manual',
      minify: { collapseWhitespace: true, removeComments: true },
    }),
    new HtmlWebpackPlugin({
      template: 'src/en/update-history/index.html',
      filename: 'en/update-history/index.html',
      chunks: ['main_update_history', 'dark_color_scheme'],
      chunksSortMode: 'manual',
      minify: {
        collapseWhitespace: true,
        removeComments: true,
      },
    }),
    new HtmlWebpackPlugin({
      template: 'src/ko/update-history/index.html',
      filename: 'ko/update-history/index.html',
      chunks: ['main_update_history', 'dark_color_scheme'],
      chunksSortMode: 'manual',
      minify: {
        collapseWhitespace: true,
        removeComments: true,
      },
    }),
  ],
};
