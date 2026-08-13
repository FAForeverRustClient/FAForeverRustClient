const userAgent = process.env.npm_config_user_agent ?? "";
const packageManager = userAgent.match(/^([^/\s]+)\//)?.[1];

if (packageManager !== "pnpm") {
  const detected = packageManager
    ? `Detected ${packageManager}.`
    : "No package manager was detected.";

  console.error(`
This project only supports pnpm. ${detected}

Enable the pinned pnpm version with Corepack, then install dependencies:
  corepack enable pnpm
  pnpm install
`);
  process.exit(1);
}
