const { spawn } = require('node:child_process');
const DEFAULT_PORT = 5173;

function resolveElectronBin() {
  try {
    return require('electron');
  } catch (error) {
    console.error('未找到 Electron。请先运行 npm install，再执行 npm run dev。');
    process.exit(1);
  }
}

function pipe(name, stream) {
  stream.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
}

async function main() {
  const electronBin = resolveElectronBin();
  const { createServer } = await import('vite');

  const server = await createServer({
    server: {
      host: true,
      port: DEFAULT_PORT,
    },
  });
  await server.listen();
  server.printUrls();

  const urls = server.resolvedUrls?.local ?? [`http://localhost:${DEFAULT_PORT}/`];
  const viteUrl = urls[0].replace(/\/$/, '');
  const child = spawn(electronBin, ['.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: viteUrl,
    },
  });

  pipe('electron', child.stdout);
  pipe('electron', child.stderr);

  child.on('exit', async (code) => {
    await server.close();
    process.exit(code ?? 0);
  });

  const shutdown = async () => {
    child.kill();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
