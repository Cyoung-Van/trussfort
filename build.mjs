// 打包：src/main.js → dist/game.js（单文件、普通 <script>，所以 index.html 双击即可运行）。
//   node build.mjs          打包一次
//   node build.mjs --watch  监听源码变化自动重打包
import * as esbuild from 'esbuild';

const opts = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/game.js',
  sourcemap: true,
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(opts);
}
